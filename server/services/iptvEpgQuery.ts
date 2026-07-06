import type { IptvDb } from './iptvDb.js'

export interface EpgProgramme {
  channel_id: string
  start_utc: string
  stop_utc: string
  title: string | null
  description: string | null
}

export interface EpgNowRow {
  channel_stream_id: number
  current: EpgProgramme | null
  next: EpgProgramme | null
}

export interface EpgGridRow {
  stream_id: number
  num: number
  name: string
  /** Channel logo URL from the provider — lets clients paint a branded card
   *  in the guide's focused-channel preview instead of a bare name. */
  stream_icon: string | null
  epg_channel_id: string | null
  tv_archive: number
  tv_archive_duration: number | null
  programmes: EpgProgramme[]
}

type ChannelEpgRow = {
  stream_id: number
  epg_channel_id: string | null
}

// The feed id a channel joins EPG on: the name-resolved id if the sync matched
// one, else the raw tvg-id (so queries work before the first resync). See
// iptvEpgResolve + migration 0006.
const EPG_JOIN_ID = 'COALESCE(epg_resolved_id, epg_channel_id)'

function uniqueStreamIds(channelStreamIds: number[]): number[] {
  return [...new Set(channelStreamIds.filter((id) => Number.isInteger(id) && id > 0))]
}

export function epgNow(db: IptvDb, channelStreamIds: number[], at: Date = new Date()): EpgNowRow[] {
  const ids = uniqueStreamIds(channelStreamIds)
  if (ids.length === 0) return []

  const placeholders = ids.map(() => '?').join(',')
  const channels = db.raw.prepare(`
    SELECT stream_id, ${EPG_JOIN_ID} AS epg_channel_id
    FROM channels
    WHERE stream_id IN (${placeholders})
  `).all(...ids) as ChannelEpgRow[]
  const channelByStreamId = new Map(channels.map((row) => [row.stream_id, row]))

  const iso = at.toISOString()
  const programmeStmt = db.raw.prepare(`
    SELECT channel_id, start_utc, stop_utc, title, description
    FROM epg_programs
    WHERE channel_id = ? AND stop_utc > ?
    ORDER BY start_utc ASC
    LIMIT 2
  `)

  return ids
    .map((streamId) => {
      const channel = channelByStreamId.get(streamId)
      if (!channel) return null
      if (!channel.epg_channel_id) return { channel_stream_id: streamId, current: null, next: null }

      const programmes = programmeStmt.all(channel.epg_channel_id, iso) as EpgProgramme[]
      const current = programmes.find((p) => p.start_utc <= iso && p.stop_utc > iso) ?? null
      const next = programmes.find((p) => p.start_utc > iso) ?? null
      return { channel_stream_id: streamId, current, next }
    })
    .filter((row): row is EpgNowRow => row != null)
}

export function epgChannelWindow(db: IptvDb, streamId: number, fromIso: string, toIso: string): EpgProgramme[] {
  const channel = db.raw.prepare(`
    SELECT ${EPG_JOIN_ID} AS epg_channel_id
    FROM channels
    WHERE stream_id = ?
  `).get(streamId) as { epg_channel_id: string | null } | undefined

  if (!channel?.epg_channel_id) return []

  return db.raw.prepare(`
    SELECT channel_id, start_utc, stop_utc, title, description
    FROM epg_programs
    WHERE channel_id = ? AND start_utc < ? AND stop_utc > ?
    ORDER BY start_utc ASC
  `).all(channel.epg_channel_id, toIso, fromIso) as EpgProgramme[]
}

export interface EpgGridOptions {
  categoryId?: number
  /**
   * Restrict to a SET of categories (`category_id IN (...)`). Takes precedence
   * over the single `categoryId`. Native clients use this to pull only the
   * curated guide set (e.g. US + sports) in one request instead of the full
   * ~17k-channel catalog — smaller payload, relevant grid.
   */
  categoryIds?: number[]
  /** Channel-name substring filter (case-insensitive LIKE). */
  q?: string
  /**
   * Restrict to channels that actually have ≥1 programme overlapping the
   * window. This provider only carries EPG for ~800 of 50k channels, so the
   * classic guide grid would otherwise be 99% empty rows. The card view keeps
   * showing everything; the guide view sets this true.
   */
  hasEpgOnly?: boolean
  /** Hard cap on returned rows (the grid is windowed client-side). */
  limit?: number
}

export function epgGrid(
  db: IptvDb,
  fromIso: string,
  toIso: string,
  optsOrCategoryId?: number | EpgGridOptions,
): EpgGridRow[] {
  // Back-compat: a bare number is the legacy categoryId positional arg.
  const opts: EpgGridOptions =
    typeof optsOrCategoryId === 'number'
      ? { categoryId: optsOrCategoryId }
      : optsOrCategoryId ?? {}
  // No artificial cap for the guide. This provider carries EPG for ~12k
  // channels; the client grid is virtualized (only on-screen rows mount), so
  // returning the full set is fine. hasEpgOnly naturally bounds this to channels
  // that actually have a schedule (~11.5k) rather than the full 50k catalog — so
  // a generous ceiling here does not pull in empty rows.
  const limit = Math.min(Math.max(opts.limit ?? 60000, 1), 60000)

  // One pass over the programmes overlapping the window, grouped by channel_id.
  // Cheaper than N+1 per-channel lookups when the grid spans hundreds of rows,
  // and it yields the has-EPG set used to scope the channel query below. Both
  // sides are stored lowercase (see 0005_lowercase_epg_id + parseLiveStreams),
  // so this exact-id grouping joins correctly.
  const progRows = db.raw.prepare(`
    SELECT channel_id, start_utc, stop_utc, title, description
    FROM epg_programs
    WHERE start_utc < ? AND stop_utc > ?
    ORDER BY channel_id, start_utc ASC
  `).all(toIso, fromIso) as EpgProgramme[]
  const byChannel = new Map<string, EpgProgramme[]>()
  for (const row of progRows) {
    const arr = byChannel.get(row.channel_id)
    if (arr) arr.push(row)
    else byChannel.set(row.channel_id, [row])
  }

  const where: string[] = []
  const args: Array<string | number> = []
  if (opts.categoryIds && opts.categoryIds.length) {
    where.push(`category_id IN (${opts.categoryIds.map(() => '?').join(',')})`)
    args.push(...opts.categoryIds)
  } else if (opts.categoryId != null) {
    where.push('category_id = ?')
    args.push(opts.categoryId)
  }
  if (opts.q && opts.q.trim()) {
    where.push('name LIKE ?')
    args.push(`%${opts.q.trim()}%`)
  }
  if (opts.hasEpgOnly) {
    const ids = [...byChannel.keys()]
    if (ids.length === 0) return []
    where.push(`${EPG_JOIN_ID} IN (${ids.map(() => '?').join(',')})`)
    args.push(...ids)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  // epg_channel_id here is the RESOLVED join id (name-matched or tvg), so the
  // programme lookup below joins the same id the hasEpgOnly filter used.
  const channels = db.raw.prepare(`
    SELECT stream_id, COALESCE(num, 0) AS num, name, stream_icon, ${EPG_JOIN_ID} AS epg_channel_id, tv_archive, tv_archive_duration
    FROM channels
    ${whereSql}
    ORDER BY num, name
    LIMIT ?
  `).all(...args, limit) as Array<Omit<EpgGridRow, 'programmes'>>

  return channels.map((channel) => ({
    ...channel,
    programmes: channel.epg_channel_id ? (byChannel.get(channel.epg_channel_id) ?? []) : [],
  }))
}

/** One programme-title/description search hit + the guide row it airs on. Mirrors
 *  the Apple client's `ProgramHit` (EpgSearch.swift): `programme` reuses the exact
 *  grid projection so it decodes into the same `EpgProgram` Swift type, and
 *  `programIndex` is the hit's index within that channel's window-ordered
 *  programme list (stable id `"<streamId>#<programIndex>"`). */
export interface EpgSearchHit {
  streamId: number
  channelName: string
  categoryId: number | null
  programme: EpgProgramme
  programIndex: number
}

export interface EpgSearchOptions {
  /** Required search term; matched case-insensitively against title + description. */
  q: string
  /** Optional `category_id IN (...)` filter, mirroring the grid's curated-set filter. */
  categoryIds?: number[]
  /** Hard cap on returned hits (the client's own scan capped at 100). */
  limit?: number
}

export interface EpgSearchResult {
  hits: EpgSearchHit[]
  total: number
}

// Ceiling on returned hits — mirrors the grid's cap philosophy so a broad term
// ('news') can't build an unbounded result set. `total` still reports the full
// match count so the client can show "showing N of M".
const SEARCH_LIMIT_MAX = 500

/**
 * Server-side programme search over the whole synced EPG store — the endpoint
 * that replaces the client's warm-window-only `EpgSearch.programHits` seam.
 *
 * Semantics deliberately mirror that seam: case-insensitive "contains" over
 * title OR description, hits ordered by channel (num, name) then programme
 * start, one hit per (channel, matching programme) so duplicate feeds sharing
 * an EPG id each surface (exactly as the grid renders one row per channel).
 */
export function epgSearch(
  db: IptvDb,
  fromIso: string,
  toIso: string,
  opts: EpgSearchOptions,
): EpgSearchResult {
  const needle = opts.q.trim().toLowerCase()
  if (!needle) return { hits: [], total: 0 }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), SEARCH_LIMIT_MAX)

  // All programmes overlapping the window, grouped by EPG channel_id using the
  // grid's exact projection + ordering, so `programIndex` lines up with the
  // client's `row.programmes`. Both sides are stored lowercase (0005), so this
  // exact-id grouping joins correctly.
  const progRows = db.raw.prepare(`
    SELECT channel_id, start_utc, stop_utc, title, description
    FROM epg_programs
    WHERE start_utc < ? AND stop_utc > ?
    ORDER BY channel_id, start_utc ASC
  `).all(toIso, fromIso) as EpgProgramme[]

  const byChannel = new Map<string, EpgProgramme[]>()
  for (const row of progRows) {
    const arr = byChannel.get(row.channel_id)
    if (arr) arr.push(row)
    else byChannel.set(row.channel_id, [row])
  }

  // Case-insensitive contains over title/description (mirrors the client's
  // localizedCaseInsensitiveContains), carrying each match's index within its
  // channel's window-ordered programme list.
  const matchesByChannel = new Map<string, Array<{ programme: EpgProgramme; programIndex: number }>>()
  const matchedIds: string[] = []
  for (const [channelId, programmes] of byChannel) {
    const matches: Array<{ programme: EpgProgramme; programIndex: number }> = []
    programmes.forEach((programme, programIndex) => {
      const titleHit = programme.title != null && programme.title.toLowerCase().includes(needle)
      const descHit = programme.description != null && programme.description.toLowerCase().includes(needle)
      if (titleHit || descHit) matches.push({ programme, programIndex })
    })
    if (matches.length) {
      matchesByChannel.set(channelId, matches)
      matchedIds.push(channelId)
    }
  }
  if (matchedIds.length === 0) return { hits: [], total: 0 }

  // Resolve the matched EPG ids back to channel rows (one EPG id can map to
  // several duplicate feeds; each becomes its own hit). Optional category filter
  // narrows the channel set exactly as the grid does.
  const where: string[] = [`${EPG_JOIN_ID} IN (${matchedIds.map(() => '?').join(',')})`]
  const args: Array<string | number> = [...matchedIds]
  if (opts.categoryIds && opts.categoryIds.length) {
    where.push(`category_id IN (${opts.categoryIds.map(() => '?').join(',')})`)
    args.push(...opts.categoryIds)
  }
  const channels = db.raw.prepare(`
    SELECT stream_id, name, category_id, ${EPG_JOIN_ID} AS epg_channel_id
    FROM channels
    WHERE ${where.join(' AND ')}
    ORDER BY num, name
  `).all(...args) as Array<{ stream_id: number; name: string; category_id: number | null; epg_channel_id: string | null }>

  const allHits: EpgSearchHit[] = []
  for (const channel of channels) {
    if (!channel.epg_channel_id) continue
    const matches = matchesByChannel.get(channel.epg_channel_id)
    if (!matches) continue
    for (const { programme, programIndex } of matches) {
      allHits.push({
        streamId: channel.stream_id,
        channelName: channel.name,
        categoryId: channel.category_id,
        programme,
        programIndex,
      })
    }
  }

  return { hits: allHits.slice(0, limit), total: allHits.length }
}
