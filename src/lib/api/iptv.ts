import { throwApiError } from './errors'
import { apiUrl } from './base'

const BASE = '/api/iptv'

type QueryParams = Record<string, string | number | boolean | undefined>

function cleanParams(params?: QueryParams): Record<string, string | number | boolean> | undefined {
  if (!params) return undefined
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

async function get<T>(path: string, params?: QueryParams): Promise<T> {
  const res = await fetch(apiUrl(`${BASE}${path}`, cleanParams(params)), {
    credentials: 'include',
  })
  if (!res.ok) await throwApiError(res, `IPTV ${path}`)
  return res.json() as Promise<T>
}

export type IptvKind = 'live' | 'vod' | 'series'

export type CategoryDto = {
  category_id: number
  name: string
  parent_id: number
}

export type ChannelDto = {
  stream_id: number
  num: number
  name: string
  stream_icon: string | null
  epg_channel_id: string | null
  category_id: number | null
  tv_archive: number
  tv_archive_duration: number | null
}

export type VodDto = {
  stream_id: number
  name: string
  stream_icon: string | null
  rating: number | null
  category_id: number | null
  year: number | null
  tmdb_id: number | null
}

export type VodDetailDto = VodDto & {
  container_extension: string | null
  plot: string | null
  director: string | null
  cast_csv: string | null
}

export type SeriesDto = {
  series_id: number
  name: string
  cover: string | null
  rating: number | null
  category_id: number | null
  tmdb_id: number | null
}

export type SeriesEpisodeDto = {
  episode_id: string
  episode_num: number
  title: string | null
  container_extension: string | null
  duration_secs: number | null
  plot: string | null
}

export type SeriesDetailDto = SeriesDto & {
  plot: string | null
  seasons: Array<{ season: number; episodes: SeriesEpisodeDto[] }>
}

export type PagedDto<T> = {
  items: T[]
  total: number
  limit: number
  offset: number
}

export type ListParams = {
  categoryId?: number
  q?: string
  limit?: number
  offset?: number
}

export const iptvApi = {
  health: () => get<{ expiresAt: string | null; maxConnections: number; status: string }>('/health'),
  categories: (kind: IptvKind) => get<CategoryDto[]>('/categories', { kind }),
  listLive: (params: ListParams = {}) => get<PagedDto<ChannelDto>>('/live', params),
  listVod: (params: ListParams = {}) => get<PagedDto<VodDto>>('/vod', params),
  listSeries: (params: ListParams = {}) => get<PagedDto<SeriesDto>>('/series', params),
  vodDetail: (id: number) => get<VodDetailDto>(`/vod/${id}`),
  seriesDetail: (id: number) => get<SeriesDetailDto>(`/series/${id}`),
}
