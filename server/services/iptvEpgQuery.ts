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
    SELECT stream_id, COALESCE(num, 0) AS num, name, ${EPG_JOIN_ID} AS epg_channel_id, tv_archive, tv_archive_duration
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
