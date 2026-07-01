// Grant-time content-rating enforcement — the server half of parental
// controls. The client hides titles above a profile's rating cap; THIS makes
// the cap real: a capped, non-admin caller cannot mint a playback grant for a
// title above the cap even with a hand-crafted request.
//
// Certification is resolved at grant time, not stored: media.db carries the
// title's tmdb/tvdb identity (read directly, readonly — same pattern as
// version.ts) and Sonarr/Radarr carry the certification for everything in the
// library. Both arr lists are cached in-process (CERT_TTL_MS) so a grant costs
// zero upstream calls on the warm path.
//
// FAIL CLOSED, matching the client's ParentalGate exactly: when a cap is set,
// an unrated / unknown / unresolvable certification BLOCKS. Admins are never
// blocked. Music ('track') is exempt — audio has no certification system.
// IPTV VOD is provider content with star ratings only (never certifications),
// so a rating cap blocks those grants wholesale — same fail-closed rule.

import Database from 'better-sqlite3'
import { env } from '../env.js'
import { getPolicy } from './userPolicies.js'
import { sonarrFetch } from './sonarr.js'
import { radarrFetch } from './radarr.js'

// Canonical severity for the fixed policy rating set (mirrors the Swift
// ParentalGate): movie + TV ladders collapsed onto one 0–4 scale.
const SEVERITY: Record<string, number> = {
  'G': 0, 'TV-Y': 0, 'TV-G': 0,
  'PG': 1, 'TV-Y7': 1, 'TV-PG': 1,
  'PG-13': 2, 'TV-14': 2,
  'R': 3, 'TV-MA': 3,
  'NC-17': 4,
}

const normalize = (s: string) => s.trim().toUpperCase()

/** Pure rating decision. nil cap = allow all; a set cap blocks anything the
 * severity map can't place (unrated fails closed). A cap outside the policy
 * rating set can't be enforced and allows (the PUT validator makes that
 * unreachable in practice). */
export function ratingAllowed(
  certification: string | null | undefined,
  cap: string | null,
): boolean {
  if (cap === null) return true
  const capSev = SEVERITY[normalize(cap)]
  if (capSev === undefined) return true
  const sev = SEVERITY[normalize(certification ?? '')]
  if (sev === undefined) return false
  return sev <= capSev
}

// ── arr certification maps (in-process cache) ────────────────────────────────

const CERT_TTL_MS = 10 * 60 * 1000

type CertCache = { at: number; map: Map<number, string | null> }
let radarrCache: CertCache | null = null
let sonarrCache: CertCache | null = null

async function certMap(
  cache: CertCache | null,
  set: (c: CertCache) => void,
  fetchList: () => Promise<Response>,
  key: 'tmdbId' | 'tvdbId',
): Promise<Map<number, string | null>> {
  if (cache && Date.now() - cache.at < CERT_TTL_MS) return cache.map
  try {
    const r = await fetchList()
    if (!r.ok) throw new Error(`arr list ${r.status}`)
    const rows = (await r.json()) as Array<Record<string, unknown>>
    const map = new Map<number, string | null>()
    for (const row of rows) {
      const id = row[key]
      if (typeof id === 'number') {
        map.set(id, typeof row.certification === 'string' ? row.certification : null)
      }
    }
    set({ at: Date.now(), map })
    return map
  } catch (e) {
    // Serve stale over failing every grant on a blipped upstream; with no
    // stale copy the caller fails closed.
    if (cache) return cache.map
    throw e
  }
}

// ── media.db identity (readonly, per-call — matches version.ts) ─────────────

function mediaIdentity(sql: string, id: number): number | null {
  let db: Database.Database | null = null
  try {
    db = new Database(env.MEDIA_DB_PATH, { readonly: true, fileMustExist: true })
    const row = db.prepare(sql).get(id) as { ext_id: number | null } | undefined
    return row?.ext_id ?? null
  } finally {
    db?.close()
  }
}

/** The library certification for a media-core title, or null when unknown. */
async function certificationFor(kind: 'movie' | 'episode', id: number): Promise<string | null> {
  if (kind === 'movie') {
    const tmdbId = mediaIdentity('SELECT tmdb_id AS ext_id FROM movies WHERE id = ?', id)
    if (tmdbId === null) return null
    const map = await certMap(
      radarrCache, (c) => { radarrCache = c },
      () => radarrFetch('/api/v3/movie'), 'tmdbId')
    return map.get(tmdbId) ?? null
  }
  const tvdbId = mediaIdentity(
    'SELECT s.tvdb_id AS ext_id FROM episodes e JOIN shows s ON s.id = e.show_id WHERE e.id = ?',
    id)
  if (tvdbId === null) return null
  const map = await certMap(
    sonarrCache, (c) => { sonarrCache = c },
    () => sonarrFetch('/api/v3/series'), 'tvdbId')
  return map.get(tvdbId) ?? null
}

// Test hook: swap the resolver so route tests need no sqlite file or arr mock.
type Resolver = typeof certificationFor
let resolver: Resolver = certificationFor
export function _setCertificationResolverForTests(fn: Resolver | null): void {
  resolver = fn ?? certificationFor
  radarrCache = null
  sonarrCache = null
}

// ── grant gates ──────────────────────────────────────────────────────────────

type SessionLike = { sub: string; role: string }

/** True when the caller's rating cap forbids this media-core title. */
export async function ratingBlocked(
  session: SessionLike,
  kind: 'movie' | 'episode' | 'track',
  id: number,
): Promise<boolean> {
  if (session.role === 'admin') return false
  if (kind === 'track') return false
  const cap = (await getPolicy(session.sub)).maxContentRating
  if (cap === null) return false
  try {
    return !ratingAllowed(await resolver(kind, id), cap)
  } catch {
    return true // resolution failure fails closed
  }
}

/** True when the caller's rating cap forbids UNRATED catalogs (IPTV VOD /
 * series / catchup — provider content carries no certification). */
export async function capBlocksUnrated(session: SessionLike): Promise<boolean> {
  if (session.role === 'admin') return false
  return (await getPolicy(session.sub)).maxContentRating !== null
}
