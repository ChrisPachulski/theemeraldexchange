// Third-party EPG supplementation.
//
// The Xtream provider's own XMLTV (/epg.xml) only carries schedules for the
// ~6k channels the provider bothered to map — but our catalog has ~50k. Real
// IPTV setups (xTeVe/Threadfin/iptv-org) close this gap by layering a community
// EPG source on top, matched by channel name. iptv-org/epg (28k+ channels) is
// mirrored as aggregated XMLTV at epgshare01; we ingest it here and reuse the
// exact same name-resolver the provider feed uses.
//
// To keep epg_programs lean we DON'T store all 6.7M external programmes — only
// those for channels our catalog actually matches (~8k). The feed is standard
// XMLTV (all <channel> defs precede all <programme>s), so by the first programme
// the channel section is fully parsed: we resolve the still-unresolved catalog
// channels against the external aliases, then store only the matched channels'
// programmes as the rest of the stream flows by.

import { streamXmltv, normalizeEpgChannelId, stageEpg, type XmltvChannelDef } from './iptvEpg.js'
import { webStreamToNodeReadable } from './streamBridge.js'
import { guardedFetchTrustedOrigin } from './ssrfGuard.js'
import { buildEpgNameIndex, callsignIds, resolveEpgId, type FeedChannelDef } from './iptvEpgResolve.js'
import type { IptvDb } from './iptvDb.js'

// Aggregated iptv-org EPG (epgshare01). Comma-separated override via env.
export const DEFAULT_EXTERNAL_EPG_URLS = [
  'https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz',
]

export function externalEpgUrls(): string[] {
  const raw = process.env.IPTV_EXTERNAL_EPG_URLS
  if (!raw || !raw.trim()) return DEFAULT_EXTERNAL_EPG_URLS
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

const EXT_FETCH_TIMEOUT_MS = 8 * 60_000

export interface ExternalEpgResult {
  url: string
  ok: boolean
  channelsMatched: number
  programmesStored: number
  idsReplaced?: number
  placeholdersDropped?: number
  error?: string
}

type Unresolved = { stream_id: number; name: string; epg_channel_id: string | null }

/**
 * Resolve every still-unresolved catalog channel against the external feed's
 * channel aliases, returning tentative mappings and the external ids we want programmes for. Only touches
 * channels the provider feed left unresolved, so the provider always wins.
 */
function resolveAgainstExternal(db: IptvDb, defs: XmltvChannelDef[]): {
  wanted: Set<string>
  matches: Array<{ streamId: number; id: string; station?: Unresolved }>
} {
  const feedWithEpg = new Set<string>()
  for (const d of defs) {
    const id = normalizeEpgChannelId(d.id)
    if (id) feedWithEpg.add(id)
  }
  const index = buildEpgNameIndex(defs as FeedChannelDef[], feedWithEpg)
  const unresolved = db.raw
    .prepare(`SELECT stream_id, name, epg_channel_id FROM channels WHERE COALESCE(NULLIF(TRIM(epg_resolved_id), ''), '') = ''`)
    .all() as Unresolved[]

  const wanted = new Set<string>()
  const matches: Array<{ streamId: number; id: string; station?: Unresolved }> = []
  for (const ch of unresolved) {
    const id = resolveEpgId(ch, index)
    if (id) {
      wanted.add(id)
      // Which of a station's ids (wesh-dt, wesh-ld) has programmes is not
      // known until they stream in, so keep them all and pick after.
      const ids = callsignIds(ch, index)
      for (const alt of ids) wanted.add(alt)
      matches.push({ streamId: ch.stream_id, id, station: ids.length > 1 ? ch : undefined })
    }
  }
  return { wanted, matches }
}

/**
 * `fed` holds ids an earlier feed delivered this sync (the provider first, then
 * earlier sources). Their schedules stay as delivered: this source stores no
 * rows for them, which would otherwise replace them, and adds the ids it stores.
 * `west` holds the West ids deriveWestFeedEpg covers. Their channels are already
 * resolved, so name matching never asks for them, but a real West schedule from
 * this source beats the East copy and is stored.
 */
export async function ingestExternalEpg(
  db: IptvDb,
  url: string,
  opts: { horizonMs?: number; fed?: Set<string>; west?: Set<string> } = {},
): Promise<ExternalEpgResult> {
  const now = Date.now()
  const horizonIso = new Date(now + (opts.horizonMs ?? 7 * 24 * 3600_000)).toISOString()
  const cutoffIso = new Date(now - 24 * 3600_000).toISOString()
  const controller = new AbortController()
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(new Error('external_epg_timeout'))
  }, EXT_FETCH_TIMEOUT_MS)

  try {
    // SSRF: the feed URL is operator-configured (env / hardcoded default) so the
    // initial hop is trusted as-is, but a third-party aggregator's 30x is
    // attacker-influenceable — every redirect target is re-validated (public
    // address only) before it is followed.
    const res = await guardedFetchTrustedOrigin(url, { signal: controller.signal })
    if (!res.ok || !res.body) {
      return { url, ok: false, channelsMatched: 0, programmesStored: 0, error: `http_${res.status}` }
    }
    const src = webStreamToNodeReadable(res.body)

    const defs: XmltvChannelDef[] = []
    let candidates: ReturnType<typeof resolveAgainstExternal> | null = null
    const fed = opts.fed ?? new Set<string>()
    const west = opts.west ?? new Set<string>()
    const stage = stageEpg(db)
    let channelsMatched = 0
    let programmesStored = 0

    await streamXmltv(
      src,
      (row) => {
        // First programme ⇒ the channel section is fully parsed (standard XMLTV
        // ordering). Resolve now, once, and learn which external ids to keep.
        candidates ??= resolveAgainstExternal(db, defs)
        if ((!candidates.wanted.has(row.channel_id) && !west.has(row.channel_id)) || fed.has(row.channel_id)) return
        if (row.stop_utc < cutoffIso || row.stop_utc > horizonIso) return
        if (stage.add(row)) programmesStored += 1
      },
      controller.signal,
      (def) => {
        defs.push(def)
      },
      // ~92% of this feed's programmes are on channels nobody here wants;
      // the parser skips them instead of handing them over.
      () => {
        candidates ??= resolveAgainstExternal(db, defs)
        return [...candidates.wanted, ...west].filter((id) => !fed.has(id))
      },
    )

    const staged = stage.commit()
    // Commit only mappings backed by retained programmes, this source's or an
    // earlier feed's. Empty, expired and failed sources leave channels
    // available for the next feed. A station with several ids is resolved again
    // against the ids that kept programmes, now that their schedules are known.
    const maxStop = db.raw.prepare('SELECT MAX(stop_utc) AS stop FROM epg_programs WHERE channel_id = ?')
    const lastStop = new Map<string, string>()
    for (const def of defs) {
      const id = normalizeEpgChannelId(def.id)
      if (!id || lastStop.has(id) || !(staged.ids.has(id) || fed.has(id))) continue
      const stop = (maxStop.get(id) as { stop: string | null } | undefined)?.stop
      if (stop) lastStop.set(id, stop)
    }
    const setResolved = db.raw.prepare("UPDATE channels SET epg_resolved_id = ? WHERE stream_id = ? AND COALESCE(NULLIF(TRIM(epg_resolved_id), ''), '') = ''")
    const stored = Object.assign(buildEpgNameIndex(defs as FeedChannelDef[], new Set(lastStop.keys())), { lastStop })
    db.raw.transaction(() => {
      for (const match of candidates?.matches ?? []) {
        const id = (match.station && resolveEpgId(match.station, stored)) || match.id
        if (lastStop.has(id) || staged.ids.has(id) || fed.has(id)) channelsMatched += setResolved.run(id, match.streamId).changes
      }
    })()
    for (const id of staged.ids) fed.add(id)
    return { url, ok: true, channelsMatched, programmesStored, idsReplaced: staged.replaced, placeholdersDropped: staged.placeholders }
  } catch (e) {
    return { url, ok: false, channelsMatched: 0, programmesStored: 0, error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

/** Ingest every configured external EPG source in sequence. */
export async function ingestAllExternalEpg(db: IptvDb, fed = new Set<string>(), west = new Set<string>()): Promise<ExternalEpgResult[]> {
  const out: ExternalEpgResult[] = []
  for (const url of externalEpgUrls()) {
    out.push(await ingestExternalEpg(db, url, { fed, west }))
  }
  return out
}
