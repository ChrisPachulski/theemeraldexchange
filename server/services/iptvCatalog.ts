import type { IptvDb } from './iptvDb.js'

type Kind = 'live' | 'vod' | 'series'

export interface ListOpts {
  categoryId?: number
  q?: string
  limit?: number
  offset?: number
}

export interface ListResult<T> { items: T[]; total: number; limit: number; offset: number }

export interface CategoryItem { category_id: number; name: string; parent_id: number }
export interface LiveItem {
  stream_id: number
  num: number
  name: string
  stream_icon: string | null
  epg_channel_id: string | null
  category_id: number | null
  tv_archive: number
  tv_archive_duration: number | null
}
export interface VodItem {
  stream_id: number
  name: string
  stream_icon: string | null
  rating: number | null
  category_id: number | null
  year: number | null
  tmdb_id: number | null
}
export interface VodDetail extends VodItem {
  container_extension: string | null
  plot: string | null
  director: string | null
  cast_csv: string | null
}
export interface SeriesItem {
  series_id: number
  name: string
  cover: string | null
  rating: number | null
  category_id: number | null
  tmdb_id: number | null
}
export interface SeriesEpisode {
  episode_id: string
  episode_num: number
  title: string | null
  container_extension: string | null
  duration_secs: number | null
  plot: string | null
}
export interface SeriesDetail extends SeriesItem {
  plot: string | null
  seasons: Array<{ season: number; episodes: SeriesEpisode[] }>
}

type CountRow = { n: number }
type EpisodeRow = SeriesEpisode & { season: number }

const clampLimit = (n: number | undefined) => {
  const v = Number.isFinite(n) ? Math.floor(n as number) : 50
  return Math.max(1, Math.min(200, v))
}
const clampOffset = (n: number | undefined) => {
  const v = Number.isFinite(n) ? Math.floor(n as number) : 0
  return Math.max(0, v)
}
const likeOrAny = (q: string | undefined) => (
  q && q.trim() ? `%${q.trim().toLowerCase().replace(/[\\%_]/g, '\\$&')}%` : null
)

export function listCategories(db: IptvDb, kind: Kind): CategoryItem[] {
  return db.raw
    .prepare(`SELECT category_id, name, parent_id FROM categories WHERE kind=? ORDER BY name`)
    .all(kind) as CategoryItem[]
}

export function listLive(db: IptvDb, opts: ListOpts): ListResult<LiveItem> {
  const limit = clampLimit(opts.limit)
  const offset = clampOffset(opts.offset)
  const like = likeOrAny(opts.q)
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (opts.categoryId != null) { where.push('category_id = @categoryId'); params.categoryId = opts.categoryId }
  if (like) { where.push("LOWER(name) LIKE @like ESCAPE '\\'"); params.like = like }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = (db.raw.prepare(`SELECT COUNT(*) AS n FROM channels ${whereSql}`).get(params) as CountRow).n
  const items = db.raw.prepare(`
    SELECT stream_id, num, name, stream_icon, epg_channel_id, category_id, tv_archive, tv_archive_duration
    FROM channels ${whereSql}
    ORDER BY num, name
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset }) as LiveItem[]
  return { items, total, limit, offset }
}

export function listVod(db: IptvDb, opts: ListOpts): ListResult<VodItem> {
  const limit = clampLimit(opts.limit)
  const offset = clampOffset(opts.offset)
  const like = likeOrAny(opts.q)
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (opts.categoryId != null) { where.push('category_id = @categoryId'); params.categoryId = opts.categoryId }
  if (like) { where.push("LOWER(name) LIKE @like ESCAPE '\\'"); params.like = like }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = (db.raw.prepare(`SELECT COUNT(*) AS n FROM vod ${whereSql}`).get(params) as CountRow).n
  const items = db.raw.prepare(`
    SELECT stream_id, name, stream_icon, rating, category_id, year, tmdb_id
    FROM vod ${whereSql}
    ORDER BY COALESCE(added_ts, '') DESC, name
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset }) as VodItem[]
  return { items, total, limit, offset }
}

export function getVodDetail(db: IptvDb, streamId: number): VodDetail | null {
  return (db.raw.prepare(`
    SELECT stream_id, name, stream_icon, rating, category_id, container_extension,
           tmdb_id, year, plot, director, cast_csv
    FROM vod WHERE stream_id = ?
  `).get(streamId) ?? null) as VodDetail | null
}

export function listSeries(db: IptvDb, opts: ListOpts): ListResult<SeriesItem> {
  const limit = clampLimit(opts.limit)
  const offset = clampOffset(opts.offset)
  const like = likeOrAny(opts.q)
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (opts.categoryId != null) { where.push('category_id = @categoryId'); params.categoryId = opts.categoryId }
  if (like) { where.push("LOWER(name) LIKE @like ESCAPE '\\'"); params.like = like }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = (db.raw.prepare(`SELECT COUNT(*) AS n FROM series ${whereSql}`).get(params) as CountRow).n
  const items = db.raw.prepare(`
    SELECT series_id, name, cover, rating, category_id, tmdb_id
    FROM series ${whereSql}
    ORDER BY name
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset }) as SeriesItem[]
  return { items, total, limit, offset }
}

export function getSeriesDetail(db: IptvDb, seriesId: number): SeriesDetail | null {
  const meta = db.raw.prepare(`
    SELECT series_id, name, cover, plot, rating, category_id, tmdb_id
    FROM series WHERE series_id = ?
  `).get(seriesId) as (SeriesItem & { plot: string | null }) | undefined
  if (!meta) return null
  const eps = db.raw.prepare(`
    SELECT episode_id, season, episode_num, title, container_extension, duration_secs, plot
    FROM series_episodes WHERE series_id = ?
    ORDER BY season, episode_num
  `).all(seriesId) as EpisodeRow[]
  const seasonsMap = new Map<number, EpisodeRow[]>()
  for (const episode of eps) {
    const list = seasonsMap.get(episode.season) ?? []
    list.push(episode)
    seasonsMap.set(episode.season, list)
  }
  const seasons = [...seasonsMap.entries()].sort(([a], [b]) => a - b).map(([season, episodes]) => ({
    season,
    episodes: episodes.map((episode) => {
      const { season: _season, ...rest } = episode
      return rest
    }),
  }))
  return { ...meta, seasons }
}
