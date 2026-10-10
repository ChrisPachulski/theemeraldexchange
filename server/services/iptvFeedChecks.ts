// Feed-check records (migration 0008) and the guide id a channel joins EPG on.
//
// A channel's LISTED guide id is COALESCE(epg_resolved_id, epg_channel_id)
// (iptvEpgResolve + migration 0006). Its EFFECTIVE guide id is the listed one,
// unless a feed check proved the stream carries another channel's picture: then
// it is that channel's id, for as long as the listing the check saw still holds.

import type Database from 'better-sqlite3'

export type FeedVerdict = 'match' | 'mislabeled' | 'inconclusive'

export interface FeedCheck {
  stream_id: number
  verdict: FeedVerdict
  listed_epg_id: string | null
  actual_epg_id: string | null
  matched_stream_id: number | null
  score: number | null
  checked_at: string
}

/** SQL for a channel row's listed guide id. `t` is the channels table alias. */
export function listedEpgSql(t = 'channels'): string {
  return `COALESCE(${t}.epg_resolved_id, ${t}.epg_channel_id)`
}

/** SQL for a channel row's effective guide id (the feed-check override first). */
export function effectiveEpgSql(t = 'channels'): string {
  return `COALESCE((SELECT f.actual_epg_id FROM channel_feed_checks f
    WHERE f.stream_id = ${t}.stream_id AND f.verdict = 'mislabeled'
      AND f.listed_epg_id = ${listedEpgSql(t)}), ${listedEpgSql(t)})`
}

/** stream_id → the guide id a feed check proved it carries instead of its
 *  listing, keyed with the listing the check saw. One row per caught stream, so
 *  whole-catalog scans apply it in memory instead of a per-row subquery. */
export function feedOverrides(db: Database.Database): Map<number, { listed: string; actual: string }> {
  const rows = db.prepare(`SELECT stream_id, listed_epg_id, actual_epg_id FROM channel_feed_checks
    WHERE verdict = 'mislabeled' AND listed_epg_id IS NOT NULL AND actual_epg_id IS NOT NULL`).all() as
    Array<{ stream_id: number; listed_epg_id: string; actual_epg_id: string }>
  return new Map(rows.map((r) => [r.stream_id, { listed: r.listed_epg_id, actual: r.actual_epg_id }]))
}

/** In-memory twin of effectiveEpgSql for a row already read with its listing. */
export function effectiveOf(
  streamId: number,
  listed: string | null,
  overrides: Map<number, { listed: string; actual: string }>,
): string | null {
  const o = overrides.get(streamId)
  return o && o.listed === listed ? o.actual : listed
}

export function listedEpgId(db: Database.Database, streamId: number): string | null {
  const row = db.prepare(`SELECT ${listedEpgSql()} AS id FROM channels WHERE stream_id = ?`).get(streamId) as
    { id: string | null } | undefined
  return row?.id || null
}

export function effectiveEpgId(db: Database.Database, streamId: number): string | null {
  const row = db.prepare(`SELECT ${effectiveEpgSql()} AS id FROM channels WHERE stream_id = ?`).get(streamId) as
    { id: string | null } | undefined
  return row?.id || null
}

export function getFeedCheck(db: Database.Database, streamId: number): FeedCheck | undefined {
  return db.prepare('SELECT * FROM channel_feed_checks WHERE stream_id = ?').get(streamId) as FeedCheck | undefined
}

export function recordFeedCheck(db: Database.Database, check: Omit<FeedCheck, 'checked_at'>, at = new Date()): void {
  db.prepare(`
    INSERT INTO channel_feed_checks (stream_id, verdict, listed_epg_id, actual_epg_id, matched_stream_id, score, checked_at)
    VALUES (@stream_id, @verdict, @listed_epg_id, @actual_epg_id, @matched_stream_id, @score, @checked_at)
    ON CONFLICT(stream_id) DO UPDATE SET verdict = excluded.verdict, listed_epg_id = excluded.listed_epg_id,
      actual_epg_id = excluded.actual_epg_id, matched_stream_id = excluded.matched_stream_id,
      score = excluded.score, checked_at = excluded.checked_at
  `).run({ ...check, checked_at: at.toISOString() })
}

// How long a verdict stands before the next tune re-checks it. A mislabel is
// re-checked daily so a provider fix stops overriding the guide soon after.
const FRESH_MS: Record<FeedVerdict, number> = {
  match: 7 * 24 * 3600_000,
  mislabeled: 24 * 3600_000,
  inconclusive: 6 * 3600_000,
}

export function feedCheckIsFresh(check: FeedCheck, now = Date.now()): boolean {
  return now - Date.parse(check.checked_at) < FRESH_MS[check.verdict]
}

/** True when both guide ids list a programme at `at` and the titles differ.
 *  Only then does a picture match tell the two channels apart: East and West
 *  feeds (and sister channels) carry the same live event at the same moment,
 *  so a match while both list the same programme proves nothing. */
export function listingsDiffer(db: Database.Database, a: string, b: string, at: Date): boolean {
  const iso = at.toISOString()
  const title = db.prepare(`SELECT title FROM epg_programs WHERE channel_id = ? AND start_utc <= ? AND stop_utc > ?
    ORDER BY start_utc DESC LIMIT 1`)
  const norm = (row: unknown): string | null => {
    const t = (row as { title: string | null } | undefined)?.title
    return t ? t.trim().toLowerCase() : null
  }
  const ta = norm(title.get(a, iso, iso))
  const tb = norm(title.get(b, iso, iso))
  return ta != null && tb != null && ta !== tb
}

/** The guide id a checked stream is known to carry, or null when unknown. */
export function knownCarriedEpgId(check: FeedCheck | undefined, listed: string | null): string | null {
  if (!check || check.listed_epg_id !== listed) return null
  if (check.verdict === 'match') return listed
  if (check.verdict === 'mislabeled') return check.actual_epg_id
  return null
}

// ── Candidate streams to compare a feed against ───────────────────────────────

export interface FeedCandidate {
  streamId: number
  epgId: string
  /** 'sibling' carries the intended guide id; 'family' a related channel's. */
  role: 'sibling' | 'family'
}

/** "showtime2west.us" → { root: "showtime", country: "us" }: the brand part of a
 *  guide id with its feed number / coast / HD suffixes stripped. */
export function epgIdFamily(epgId: string): { base: string; root: string; country: string } {
  const lower = epgId.toLowerCase()
  const dot = lower.indexOf('.')
  const base = (dot < 0 ? lower : lower.slice(0, dot)).replace(/[^\p{L}\p{N}]+/gu, '')
  const country = dot < 0 ? '' : lower.slice(dot + 1)
  let root = base
  for (;;) {
    const next = root.replace(/(?:east|west|pacific|hd|\d+)$/, '')
    if (next === root || next.length < 3) break
    root = next
  }
  return { base, root, country }
}

/** Two guide ids name related channels of one brand (Showtime / Showtime 2 /
 *  Showtime Extreme; HBO / HBO Zone): same country, and their roots share a
 *  prefix of at least 3 characters covering 40% of the shorter one. */
export function relatedEpgIds(a: string, b: string): boolean {
  if (a === b) return false
  const fa = epgIdFamily(a)
  const fb = epgIdFamily(b)
  if (fa.country !== fb.country) return false
  let common = 0
  while (common < fa.root.length && common < fb.root.length && fa.root[common] === fb.root[common]) common++
  return common >= 3 && common >= 0.4 * Math.min(fa.root.length, fb.root.length)
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

/** Provider source group: this provider numbers each source's streams in its own
 *  range (5864 "(S)", 200163566 "US:", 400124922 "US: CAPS"), and one source's
 *  mistake is often repeated across its own range, so evidence from another
 *  source is worth more. */
function sourceGroup(streamId: number): number {
  return Math.floor(streamId / 100_000_000)
}

interface ChannelEpgRow { stream_id: number; num: number | null; epg: string }

/**
 * Ordered streams to compare `subject` against, to learn which guide id it
 * really carries: one stream of `intendedEpg` (a sibling: a match proves the
 * listing right), then up to `maxFamily` streams of related channels (a match
 * proves it carries that channel instead), then a second sibling (in case the
 * first was itself the odd one out). Each guide id is represented by one
 * stream: a previously verified one first, then one from another provider
 * source, then the lowest channel number. Dead feeds and `exclude` are skipped.
 */
export function feedCheckCandidates(
  db: Database.Database,
  subject: number,
  intendedEpg: string,
  opts: { isDead: (streamId: number) => boolean; exclude?: number[]; maxFamily?: number },
): FeedCandidate[] {
  const maxFamily = opts.maxFamily ?? 4
  const skip = new Set([subject, ...(opts.exclude ?? [])])
  const overrides = feedOverrides(db)
  const rows = (db.prepare(`
    SELECT stream_id, num, ${listedEpgSql()} AS epg FROM channels
    WHERE COALESCE(${listedEpgSql()}, '') != ''
  `).all() as ChannelEpgRow[]).map((r) => ({ ...r, epg: effectiveOf(r.stream_id, r.epg, overrides) ?? '' }))
  const verified = new Set(
    (db.prepare(`SELECT stream_id FROM channel_feed_checks WHERE verdict IN ('match', 'mislabeled')`).all() as
      Array<{ stream_id: number }>).map((r) => r.stream_id),
  )
  const hasProgrammes = db.prepare('SELECT 1 FROM epg_programs WHERE channel_id = ? LIMIT 1')
  const subjectGroup = sourceGroup(subject)
  const rank = (r: ChannelEpgRow): [number, number, number] => [
    verified.has(r.stream_id) ? 0 : 1,
    sourceGroup(r.stream_id) === subjectGroup ? 1 : 0,
    r.num ?? r.stream_id,
  ]
  const byRank = (a: ChannelEpgRow, b: ChannelEpgRow): number => {
    const ra = rank(a)
    const rb = rank(b)
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2]
  }

  const byEpg = new Map<string, ChannelEpgRow[]>()
  for (const r of rows) {
    if (!r.epg || skip.has(r.stream_id) || opts.isDead(r.stream_id)) continue
    const list = byEpg.get(r.epg) ?? []
    list.push(r)
    byEpg.set(r.epg, list)
  }

  const siblings = (byEpg.get(intendedEpg) ?? []).sort(byRank)
  const intendedBase = epgIdFamily(intendedEpg).base
  const family = [...byEpg.keys()]
    .filter((epg) => relatedEpgIds(intendedEpg, epg) && hasProgrammes.get(epg))
    .sort((a, b) => editDistance(intendedBase, epgIdFamily(a).base) - editDistance(intendedBase, epgIdFamily(b).base)
      || a.localeCompare(b))
    .slice(0, maxFamily)
    .map((epg) => ({ streamId: byEpg.get(epg)!.sort(byRank)[0].stream_id, epgId: epg, role: 'family' as const }))

  const out: FeedCandidate[] = []
  if (siblings[0]) out.push({ streamId: siblings[0].stream_id, epgId: intendedEpg, role: 'sibling' })
  out.push(...family)
  if (siblings[1]) out.push({ streamId: siblings[1].stream_id, epgId: intendedEpg, role: 'sibling' })
  return out
}
