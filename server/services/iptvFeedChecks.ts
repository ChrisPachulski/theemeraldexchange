// Feed-check records (migration 0008) and the guide id a channel joins EPG on.
//
// A channel's LISTED guide id is COALESCE(epg_resolved_id, epg_channel_id)
// (iptvEpgResolve + migration 0006), or none when the resolver refused the
// tag. Its EFFECTIVE guide id is the listed one, unless a feed check proved the
// stream carries another channel's picture: then it is that channel's id, for
// as long as the listing the check saw still holds.

import type Database from 'better-sqlite3'
import { normalizeChannelName } from './iptvSiblingFeeds.js'

export type FeedVerdict = 'match' | 'mislabeled' | 'inconclusive'

export interface FeedCheck {
  stream_id: number
  verdict: FeedVerdict
  listed_epg_id: string | null
  actual_epg_id: string | null
  matched_stream_id: number | null
  score: number | null
  /** Why the check ended so (iptvFeedVerify's outcome reason); NULL before 0009. */
  reason: string | null
  checked_at: string
}

/** The reason a check records when no other stream of its listing exists. */
export const NO_SIBLING_REASON = 'no other stream of its listing to compare'

/** SQL for a channel row's listed guide id. `t` is the channels table alias.
 *  An epg_resolved_id of '' is a provider tag the resolver refused: no listing,
 *  not a fall back to that tag. */
export function listedEpgSql(t = 'channels'): string {
  return `NULLIF(COALESCE(${t}.epg_resolved_id, ${t}.epg_channel_id), '')`
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

export function recordFeedCheck(
  db: Database.Database,
  check: Omit<FeedCheck, 'checked_at' | 'reason'> & { reason?: string | null },
  at = new Date(),
): void {
  db.prepare(`
    INSERT INTO channel_feed_checks (stream_id, verdict, listed_epg_id, actual_epg_id, matched_stream_id, score, reason, checked_at)
    VALUES (@stream_id, @verdict, @listed_epg_id, @actual_epg_id, @matched_stream_id, @score, @reason, @checked_at)
    ON CONFLICT(stream_id) DO UPDATE SET verdict = excluded.verdict, listed_epg_id = excluded.listed_epg_id,
      actual_epg_id = excluded.actual_epg_id, matched_stream_id = excluded.matched_stream_id,
      score = excluded.score, reason = excluded.reason, checked_at = excluded.checked_at
  `).run({ ...check, reason: check.reason ?? null, checked_at: at.toISOString() })
}

// How long a verdict stands before the next tune re-checks it. A mislabel is
// re-checked daily so a provider fix stops overriding the guide soon after.
const FRESH_MS: Record<FeedVerdict, number> = {
  match: 7 * 24 * 3600_000,
  mislabeled: 24 * 3600_000,
  inconclusive: 6 * 3600_000,
}

/** A check that compared nothing (a capture failed, or the picture was dark or
 *  still) waits a day and an hour, so each retry lands an hour later in the
 *  overnight window: a channel off air at 10:00 every night still gets seen. */
const CAPTURE_RETRY_MS = 25 * 3600_000

/** Fresh = still answers for the stream as listed now. A verdict about another
 *  listing says nothing about what the guide shows today (2026-10-15: matches
 *  for abcphiladelphia.us kept a stream now listed abc5.us out of the sweep). */
export function feedCheckIsFresh(check: FeedCheck, listed: string | null, now = Date.now()): boolean {
  if (check.listed_epg_id !== listed) return false
  const comparedNothing = check.verdict === 'inconclusive' && check.score == null
    && check.reason != null && check.reason !== NO_SIBLING_REASON
  return now - Date.parse(check.checked_at) < (comparedNothing ? CAPTURE_RETRY_MS : FRESH_MS[check.verdict])
}

// Titles that say nothing about the picture: off-air slates and the event
// channels' "Next game: ..." filler.
const PLACEHOLDER_TITLE =
  /^(?:sign ?off|off[ -]?air|channel off air|to be announced|tba|tbd|no match today|channel no longer available|next (?:game|match)\b.*)$/

/** A programme title folded for comparison ("Live: WWE NXT" -> "wwe nxt",
 *  "Good Morning America Category: News" -> "good morning america"). Null for
 *  a placeholder or no title. */
export function normTitle(title: string | null | undefined): string | null {
  const t = title?.trim().toLowerCase()
  if (!t || PLACEHOLDER_TITLE.test(t)) return null
  return t
    .replace(/^(?:live|new)\s*:\s*/, '')
    .replace(/\s+category:.*$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim() || null
}

/** Two folded titles name one programme: equal, or one source adds an episode
 *  or event subtitle the other leaves off ("t20 cricket" / "t20 cricket india
 *  vs west indies"). Two different subtitles stay different games. */
function sameProgramme(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `)
}

function titleAt(db: Database.Database): (epgId: string, at: number) => string | null {
  const stmt = db.prepare(`SELECT title FROM epg_programs WHERE channel_id = ? AND start_utc <= ? AND stop_utc > ?
    ORDER BY start_utc DESC LIMIT 1`)
  return (epgId, at) => {
    const iso = new Date(at).toISOString()
    return normTitle((stmt.get(epgId, iso, iso) as { title: string | null } | undefined)?.title)
  }
}

/** True when both guide ids list a real programme at `at` and the titles differ.
 *  Only then does a picture match tell the two channels apart: East and West
 *  feeds (and sister channels) carry the same live event at the same moment,
 *  so a match while both list the same programme proves nothing. */
export function listingsDiffer(db: Database.Database, a: string, b: string, at: Date): boolean {
  const title = titleAt(db)
  const ta = title(a, at.getTime())
  const tb = title(b, at.getTime())
  return ta != null && tb != null && !sameProgramme(ta, tb)
}

/** How far two guide ids' schedules agree within `hours` either side of `at`:
 *  of the half-hour points where both list a real programme (`points`), the
 *  share listing the same one, and how many distinct titles agreed. */
export function scheduleAgreement(
  db: Database.Database,
  a: string,
  b: string,
  at: Date,
  hours = 12,
): { share: number; points: number; titles: number } {
  const title = titleAt(db)
  const agreed = new Set<string>()
  let points = 0
  let same = 0
  for (let t = at.getTime() - hours * 3600_000; t <= at.getTime() + hours * 3600_000; t += 30 * 60_000) {
    const ta = title(a, t)
    const tb = title(b, t)
    if (ta == null || tb == null) continue
    points++
    if (sameProgramme(ta, tb)) {
      same++
      agreed.add(ta.length < tb.length ? ta : tb)
    }
  }
  return { share: points ? same / points : 0, points, titles: agreed.size }
}

/** Two ids of one channel (travel.us / travelchannel.us, lifetimemovies.us /
 *  lifetimemovienetwork.us): their schedules agree most of the time, so a stream
 *  carrying one carries the other's programmes too. */
export function sameScheduleEpgIds(db: Database.Database, a: string, b: string, at: Date): boolean {
  const { share, points } = scheduleAgreement(db, a, b, at)
  return points >= 4 && share >= 0.5
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

interface ChannelEpgRow { stream_id: number; num: number | null; name: string; tvg: string | null; epg: string }

/** A channel name as a sibling key: normalizeChannelName, but a West feed never
 *  pairs with an East one ("US Showtime (West) (H)" is not "US: Showtime"). */
function siblingNameKey(name: string): string {
  const key = normalizeChannelName(name.replace(/\b(?:east|west|pacific)\b/gi, ' '))
  return key && /\b(?:west|pacific)\b/i.test(name) ? `${key} west` : key
}

const westFeed = (epgId: string): boolean => /west|pacific/.test(epgId)

/** Guide ids filed for the same channel as `epgId` (cmt.us and cmt.hd.us2,
 *  2026-10-15): the same programme now and across the surrounding day, with
 *  enough distinct titles that two all-day "Teleshopping" ids don't count. Same
 *  coast only: some West ids carry the East schedule at East times. */
function aliasEpgIds(db: Database.Database, epgId: string, ids: Iterable<string>, at: Date): string[] {
  const title = titleAt(db)
  const now = title(epgId, at.getTime())
  if (now == null) return []
  const out: string[] = []
  for (const id of ids) {
    if (id === epgId || westFeed(id) !== westFeed(epgId)) continue
    const idNow = title(id, at.getTime())
    if (idNow == null || !sameProgramme(idNow, now)) continue
    const { share, points, titles } = scheduleAgreement(db, epgId, id, at)
    if (share >= 0.9 && points >= 12 && titles >= 4) out.push(id)
  }
  return out
}

/**
 * Ordered streams to compare `subject` against, to learn which guide id it
 * really carries: one stream of `intendedEpg` (a sibling: a match proves the
 * listing right), then up to `maxFamily` streams of related channels (a match
 * proves it carries that channel instead), then a second sibling (in case the
 * first was itself the odd one out). Each guide id is represented by one
 * stream: a stream verified under its current listing first, then one from
 * another provider source, then the lowest channel number. Dead feeds and
 * `exclude` are skipped.
 *
 * A sibling must be vouched to be the intended channel: the provider tags it
 * with that id itself, or with the subject's own tag, or it has the subject's
 * name. Sharing a name-resolved id is not enough (2026-10-14: WTAE Pittsburgh
 * "confirmed" against WPVI Philadelphia, both name-resolved to abc5.us). When
 * that leaves fewer than two, streams of an id with the same schedule count too.
 */
export function feedCheckCandidates(
  db: Database.Database,
  subject: number,
  intendedEpg: string,
  opts: { isDead: (streamId: number) => boolean; exclude?: number[]; maxFamily?: number; now?: number },
): FeedCandidate[] {
  const maxFamily = opts.maxFamily ?? 4
  const skip = new Set([subject, ...(opts.exclude ?? [])])
  const overrides = feedOverrides(db)
  const rows = (db.prepare(`
    SELECT stream_id, num, name, epg_channel_id AS tvg, ${listedEpgSql()} AS epg FROM channels
    WHERE COALESCE(${listedEpgSql()}, '') != ''
  `).all() as ChannelEpgRow[]).map((r) => ({ ...r, epg: effectiveOf(r.stream_id, r.epg, overrides) ?? '' }))
  const verified = new Set(
    (db.prepare(`SELECT f.stream_id FROM channel_feed_checks f JOIN channels c ON c.stream_id = f.stream_id
      WHERE f.verdict IN ('match', 'mislabeled') AND f.listed_epg_id = ${listedEpgSql('c')}`).all() as
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

  const self = db.prepare('SELECT name, epg_channel_id AS tvg FROM channels WHERE stream_id = ?').get(subject) as
    { name: string; tvg: string | null } | undefined
  const selfName = self ? siblingNameKey(self.name) : ''
  const vouched = (epg: string) => (r: ChannelEpgRow): boolean =>
    r.tvg === epg || (!!self?.tvg && r.tvg === self.tvg) || (selfName !== '' && siblingNameKey(r.name) === selfName)
  let siblings = (byEpg.get(intendedEpg) ?? []).filter(vouched(intendedEpg))
  let aliases: string[] = []
  if (siblings.length < 2) {
    aliases = aliasEpgIds(db, intendedEpg, byEpg.keys(), new Date(opts.now ?? Date.now()))
    siblings = [...siblings, ...aliases.flatMap((epg) => byEpg.get(epg)!.filter(vouched(epg)))]
  }
  siblings.sort(byRank)
  const intendedBase = epgIdFamily(intendedEpg).base
  // The other coast's feed of the same channel is the likeliest mix-up
  // (Showtime West, HGTV West): always compare it first.
  const coast = (base: string): string => base.replace(/(?:east|west|pacific)$/, '')
  const otherCoast = (epg: string): number => (coast(epgIdFamily(epg).base) === coast(intendedBase) ? 0 : 1)
  const family = [...byEpg.keys()]
    .filter((epg) => relatedEpgIds(intendedEpg, epg) && !aliases.includes(epg) && hasProgrammes.get(epg))
    .sort((a, b) => otherCoast(a) - otherCoast(b)
      || editDistance(intendedBase, epgIdFamily(a).base) - editDistance(intendedBase, epgIdFamily(b).base)
      || a.localeCompare(b))
    .slice(0, maxFamily)
    .map((epg) => ({ streamId: byEpg.get(epg)!.sort(byRank)[0].stream_id, epgId: epg, role: 'family' as const }))

  // An alias stream stands for the intended listing: its match is a match.
  const out: FeedCandidate[] = []
  if (siblings[0]) out.push({ streamId: siblings[0].stream_id, epgId: intendedEpg, role: 'sibling' })
  out.push(...family)
  if (siblings[1]) out.push({ streamId: siblings[1].stream_id, epgId: intendedEpg, role: 'sibling' })
  return out
}
