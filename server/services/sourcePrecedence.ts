// Source-precedence resolver for the §9 Resolution A local-first rule.
//
// Precedence order at play-time (M1.5 scope, per §9):
//   media-core (M3+) > Plex (Sonarr/Radarr-tracked) > IPTV
//
// In M1.5, media-core does not exist, so the effective order is:
//   Plex (Sonarr/Radarr-tracked + file present) > IPTV
//
// Auto-fallback rule:
//   If the rank-1 source is unavailable (offline, 5xx, library path
//   missing, empty file), automatically fall back to the next source.
//   Fallback only applies at grant time (pre-session start); it does NOT
//   apply mid-session — a source going offline during playback surfaces
//   the 'source_unavailable' reason code so the client can prompt the
//   user for an explicit action (codec / quality / progress-attribution
//   change requires explicit consent per §9 contract note).

import { env } from '../env.js'
import { fetchWithTimeout, LAN_TIMEOUT_MS } from './upstream.js'

// The sources that can back a title, in precedence order.
// 'local' is reserved for media-core (M3+); 'plex' covers
// Sonarr/Radarr-tracked + file-present; 'iptv' is the Xtream panel.
export type PlaySource = 'local' | 'plex' | 'iptv'

// Payload attached to a source_unavailable denial (§12.4 closed enum).
export type SourceUnavailablePayload = {
  available_alternatives: Array<{
    source: PlaySource
    displayName: string
    kind: string
    id: string
  }>
}

// A fully resolved, playable source.
export type ResolvedSource = {
  source: PlaySource
  kind: string
  id: string
}

// The item reference the caller wants to play.
// kind: 'live' | 'vod' | 'series' | 'catchup' — mirrors IPTV grant kinds.
// id: stream_id (live/vod/catchup) or episode_id (series) as a string.
export type ItemRef = {
  kind: string
  id: string
}

// Probe the IPTV (Xtream) panel for availability.
// Returns true when the panel credentials are configured AND the upstream
// replies with a non-5xx response to a lightweight account-info probe.
// A 4xx from the panel (e.g. bad credentials) is treated as unavailable
// — the stream can't be started regardless.
async function probeIptv(): Promise<boolean> {
  if (!env.XTREAM_HOST || !env.XTREAM_USERNAME || !env.XTREAM_PASSWORD) {
    return false
  }
  const host = env.XTREAM_HOST.replace(/\/+$/, '')
  const url =
    `${host}/player_api.php` +
    `?username=${encodeURIComponent(env.XTREAM_USERNAME)}` +
    `&password=${encodeURIComponent(env.XTREAM_PASSWORD)}`
  try {
    const res = await fetchWithTimeout(url, {}, LAN_TIMEOUT_MS, 'sourcePrecedence.iptv')
    // 5xx or timeout (504 synthesized by fetchWithTimeout) → unavailable.
    // 4xx (expired line, bad creds) → also unavailable for play purposes.
    return res.ok
  } catch {
    return false
  }
}

// Probe the Plex Media Server for availability.
// Returns true when PLEX_SERVER_URL is set and the server's /identity
// endpoint responds with 2xx. This endpoint is unauthenticated and
// intentionally lightweight — it only checks that PMS is up, not that
// the specific title is present (file-presence is checked at the
// Sonarr/Radarr layer, which is out-of-scope for M1.5 where Plex is not
// wired into the IPTV grant path). Plex is rank-2 in M1.5 but rank-1
// tracking is reserved for it so M3+ media-core can slot in above it
// without changing the comparator.
async function probePlex(): Promise<boolean> {
  const plexUrl = env.plexServerUrl
  if (!plexUrl) return false
  try {
    const res = await fetchWithTimeout(
      `${plexUrl}/identity`,
      {},
      LAN_TIMEOUT_MS,
      'sourcePrecedence.plex',
    )
    return res.ok
  } catch {
    return false
  }
}

// Build the list of sources that could serve `item`, in precedence order.
// M1.5: only IPTV is wired. Plex is probed to determine if it is up, but
// it cannot actually serve the item (the IPTV stream-id ↔ Plex ratingKey
// mapping requires media-core / M3+ work). When Plex is online it appears
// in available_alternatives so the client can prompt the user; it does
// NOT trigger an auto-fallback because we cannot construct a Plex play URL
// for an IPTV stream_id in M1.5.
//
// M3+ will replace this function with one that queries media_title_link
// and constructs the appropriate PlayURL per source.
async function buildCandidates(item: ItemRef): Promise<ResolvedSource[]> {
  // media-core (M3+): not wired, always absent in M1.5.

  // Plex: check if PMS is reachable. Not yet able to serve IPTV items
  // (no ratingKey mapping in M1.5), so we don't include it as an auto-
  // fallback candidate here. Included only in available_alternatives via
  // probeIptv path so UI can surface "switch to Plex" if user clicks.
  // (Implementation note: when M3+ adds media_title_link, Plex/local
  // slots here should call a getRatingKey(tmdb_id) helper and return a
  // full ResolvedSource.)

  const iptv = await probeIptv()
  if (iptv) {
    return [{ source: 'iptv', kind: item.kind, id: item.id }]
  }
  return []
}

// Resolve the best available source for `item`, or null if no source is
// currently reachable.
//
// Returns:
//   { resolved: ResolvedSource }               — best available source
//   { resolved: null; alternatives: ... }      — nothing available
//
// The caller (grant endpoint) must:
//   - On null: respond with 503 + reason 'source_unavailable' and the
//     alternatives payload so the client can surface "switch source?"
//   - On a resolved source with rank > 0 (Plex / local): redirect the
//     grant to the appropriate service. In M1.5 only IPTV is wired, so
//     this always resolves to IPTV or null.
export type PrecedenceResult =
  | { resolved: ResolvedSource }
  | { resolved: null; alternatives: SourceUnavailablePayload['available_alternatives'] }

export async function resolveSourcePrecedence(item: ItemRef): Promise<PrecedenceResult> {
  const candidates = await buildCandidates(item)

  if (candidates.length > 0) {
    // Return the highest-ranked available source.
    return { resolved: candidates[0] }
  }

  // Nothing available. Build the alternatives list (empty in M1.5 when
  // IPTV is down, but populated once Plex / media-core are wired).
  // We still probe Plex here so the UI can offer "switch to Plex?" even
  // when IPTV is down — consistent with the contract's explicit-action
  // requirement for mid-session source changes.
  const plexUp = await probePlex()
  const alternatives: SourceUnavailablePayload['available_alternatives'] = []
  if (plexUp) {
    alternatives.push({ source: 'plex', displayName: 'Plex', kind: item.kind, id: item.id })
  }

  return { resolved: null, alternatives }
}
