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

function uniqueStreamIds(channelStreamIds: number[]): number[] {
  return [...new Set(channelStreamIds.filter((id) => Number.isInteger(id) && id > 0))]
}

export function epgNow(db: IptvDb, channelStreamIds: number[], at: Date = new Date()): EpgNowRow[] {
  const ids = uniqueStreamIds(channelStreamIds)
  if (ids.length === 0) return []

  const placeholders = ids.map(() => '?').join(',')
  const channels = db.raw.prepare(`
    SELECT stream_id, epg_channel_id
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
    SELECT epg_channel_id
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

export function epgGrid(db: IptvDb, fromIso: string, toIso: string, categoryId?: number): EpgGridRow[] {
  const hasCategory = categoryId != null
  const channels = db.raw.prepare(`
    SELECT stream_id, COALESCE(num, 0) AS num, name, epg_channel_id, tv_archive, tv_archive_duration
    FROM channels
    ${hasCategory ? 'WHERE category_id = ?' : ''}
    ORDER BY num, name
  `).all(...(hasCategory ? [categoryId] : [])) as Array<Omit<EpgGridRow, 'programmes'>>

  const programmeStmt = db.raw.prepare(`
    SELECT channel_id, start_utc, stop_utc, title, description
    FROM epg_programs
    WHERE channel_id = ? AND start_utc < ? AND stop_utc > ?
    ORDER BY start_utc ASC
  `)

  return channels.map((channel) => ({
    ...channel,
    programmes: channel.epg_channel_id
      ? (programmeStmt.all(channel.epg_channel_id, toIso, fromIso) as EpgProgramme[])
      : [],
  }))
}
