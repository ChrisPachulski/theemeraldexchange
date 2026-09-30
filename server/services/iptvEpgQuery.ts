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
    WHERE channel_id = ? AND start_utc <= ? AND stop_utc > ?
    ORDER BY start_utc DESC
    LIMIT 1
  `)

  const nextStmt = db.raw.prepare('SELECT channel_id, start_utc, stop_utc, title, description FROM epg_programs WHERE channel_id = ? AND start_utc > ? ORDER BY start_utc ASC LIMIT 1')
  return ids
    .map((streamId) => {
      const channel = channelByStreamId.get(streamId)
      if (!channel) return null
      if (!channel.epg_channel_id) return { channel_stream_id: streamId, current: null, next: null }

      const current = (programmeStmt.get(channel.epg_channel_id, iso, iso) as EpgProgramme | undefined) ?? null
      const next = (nextStmt.get(channel.epg_channel_id, iso) as EpgProgramme | undefined) ?? null
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
    where.push("name LIKE ? ESCAPE '\\'")
    args.push(`%${escapeLike(opts.q.trim())}%`)
  }
  if (opts.hasEpgOnly) {
    where.push(`EXISTS (SELECT 1 FROM epg_programs p WHERE p.channel_id = ${EPG_JOIN_ID} AND p.start_utc < ? AND p.stop_utc > ?)`)
    args.push(toIso, fromIso)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  // epg_channel_id here is the RESOLVED join id (name-matched or tvg), so the
  // programme lookup below joins the same id the hasEpgOnly filter used.
  const channelSql = `
    SELECT stream_id, COALESCE(num, 0) AS num, name, stream_icon, ${EPG_JOIN_ID} AS epg_channel_id, tv_archive, tv_archive_duration
    FROM channels
    ${whereSql}
    ORDER BY num, name, stream_id
    LIMIT ?
  `
  const channels = db.raw.prepare(channelSql).all(...args, limit) as Array<Omit<EpgGridRow, 'programmes'>>
  if (channels.length === 0) return []
  // Apply the channel/category cap before reading programmes. The SQL subquery
  // also avoids one bind parameter per feed id in large libraries.
  const progRows = db.raw.prepare(`
    SELECT channel_id, start_utc, stop_utc, title, description FROM epg_programs
    WHERE channel_id IN (SELECT epg_channel_id FROM (${channelSql}))
      AND start_utc < ? AND stop_utc > ?
    ORDER BY channel_id, start_utc
  `).all(...args, limit, toIso, fromIso) as EpgProgramme[]
  const byChannel = new Map<string, EpgProgramme[]>()
  for (const row of progRows) {
    const programmes = byChannel.get(row.channel_id) ?? []
    programmes.push(row)
    byChannel.set(row.channel_id, programmes)
  }

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

/** Escape LIKE metacharacters so a user term is matched LITERALLY: a `%`, `_`,
 *  or `\` typed in the search box must not act as a wildcard/escape. Pairs with
 *  `ESCAPE '\'` on the LIKE clause. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

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
  const term = opts.q.trim()
  if (!term) return { hits: [], total: 0 }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), SEARCH_LIMIT_MAX)

  const categories = opts.categoryIds?.length ? opts.categoryIds : []
  const categoryWhere = categories.length ? 'WHERE category_id IN (' + categories.map(() => '?').join(',') + ')' : ''
  const likeArg = '%' + escapeLike(term) + '%'
  // Scope before numbering programmes, then count matches in SQL before LIMIT.
  // No whole-store id bind list or uncapped JS hit array is needed.
  const rows = db.raw.prepare(`
    WITH channel_scope AS (
      SELECT stream_id, num, name, category_id, COALESCE(epg_resolved_id, epg_channel_id) AS epg_id
      FROM channels ${categoryWhere}
    ), programmes AS (
      SELECT channel_id, start_utc, stop_utc, title, description,
        ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY start_utc) - 1 AS program_index
      FROM epg_programs
      WHERE channel_id IN (SELECT epg_id FROM channel_scope)
        AND start_utc < ? AND stop_utc > ?
    )
    SELECT c.stream_id AS streamId, c.name AS channelName, c.category_id AS categoryId,
      p.*, COUNT(*) OVER () AS total
    FROM channel_scope c JOIN programmes p ON p.channel_id = c.epg_id
    WHERE COALESCE(p.title, '') LIKE ? ESCAPE '\\'
       OR COALESCE(p.description, '') LIKE ? ESCAPE '\\'
    ORDER BY c.num, c.name, c.stream_id, p.start_utc
    LIMIT ?
  `).all(...categories, toIso, fromIso, likeArg, likeArg, limit) as Array<EpgProgramme & {
    streamId: number; channelName: string; categoryId: number | null; program_index: number; total: number
  }>
  return {
    total: rows[0]?.total ?? 0,
    hits: rows.map(row => ({
      streamId: row.streamId, channelName: row.channelName, categoryId: row.categoryId,
      programIndex: row.program_index,
      programme: { channel_id: row.channel_id, start_utc: row.start_utc, stop_utc: row.stop_utc,
        title: row.title, description: row.description },
    })),
  }
}
