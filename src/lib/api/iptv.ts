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

async function post<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method: 'POST',
    credentials: 'include',
  }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }

  const res = await fetch(apiUrl(`${BASE}${path}`), init)
  if (!res.ok) await throwApiError(res, `IPTV ${path}`)
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

async function del(path: string): Promise<void> {
  const res = await fetch(apiUrl(`${BASE}${path}`), {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!res.ok) await throwApiError(res, `IPTV ${path}`)
}

export type IptvKind = 'live' | 'vod' | 'series'
export type IptvHistoryKind = 'live' | 'vod' | 'series_episode'

export type StreamDelivery = 'mpegts' | 'hls' | 'progressive'

export type StreamGrant = {
  url: string
  delivery: StreamDelivery
  sessionId?: string
  mime?: string
}

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

export type FavoriteRow = {
  sub: string
  kind: IptvKind
  item_id: string
  added_ts: string
}

export type HistoryRow = {
  sub: string
  kind: IptvHistoryKind
  item_id: string
  position_secs: number
  duration_secs: number | null
  watched_at: string
  completed: number
}

export type PutHistoryInput = {
  kind: IptvHistoryKind
  itemId: string
  positionSecs: number
  durationSecs?: number | null
  completed?: boolean
}

export type ListParams = {
  categoryId?: number
  q?: string
  limit?: number
  offset?: number
}

export function preferAvplayer(): boolean {
  if (typeof navigator === 'undefined') return false

  const ua = navigator.userAgent
  const platform = navigator.platform
  const maxTouchPoints = navigator.maxTouchPoints ?? 0
  const isiOS = /iPad|iPhone|iPod/i.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1)
  const isSafari = /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Android/i.test(ua)
  return isiOS || isSafari
}

export const iptvApi = Object.assign({
  health: () => get<{ expiresAt: string | null; maxConnections: number; status: string }>('/health'),
  categories: (kind: IptvKind) => get<CategoryDto[]>('/categories', { kind }),
  listLive: (params: ListParams = {}) => get<PagedDto<ChannelDto>>('/live', params),
  listVod: (params: ListParams = {}) => get<PagedDto<VodDto>>('/vod', params),
  listSeries: (params: ListParams = {}) => get<PagedDto<SeriesDto>>('/series', params),
  vodDetail: (id: number) => get<VodDetailDto>(`/vod/${id}`),
  seriesDetail: (id: number) => get<SeriesDetailDto>(`/series/${id}`),
  favorites: () => get<FavoriteRow[]>('/favorites'),
  addFavorite: (kind: FavoriteRow['kind'], itemId: string) => post<void>('/favorites', { kind, itemId }),
  removeFavorite: (kind: FavoriteRow['kind'], itemId: string) =>
    del(`/favorites/${kind}/${encodeURIComponent(itemId)}`),
  history: (limit = 50) => get<HistoryRow[]>('/history', { limit }),
  putHistory: (input: PutHistoryInput) => post<void>('/history', input),
}, {
  grantLive: (streamId: string, opts?: { avplayer?: boolean }) => {
    const avplayer = opts?.avplayer ?? preferAvplayer()
    const suffix = avplayer ? '?client=avplayer' : ''
    return post<StreamGrant>(`/stream/live/${streamId}/grant${suffix}`)
  },
  grantVod: (streamId: string) => post<StreamGrant>(`/stream/vod/${streamId}/grant`),
  grantSeries: (episodeId: string) => post<StreamGrant>(`/stream/series/${episodeId}/grant`),
})
