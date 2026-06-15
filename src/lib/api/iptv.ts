import { throwApiError, ApiError } from './errors'
import { apiUrl } from './base'
import { withTimeout, type RequestOpts } from './timeout'

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

async function get<T>(path: string, params?: QueryParams, opts?: RequestOpts): Promise<T> {
  const { signal, timeout } = withTimeout(opts)
  let res: Response
  try {
    res = await fetch(apiUrl(`${BASE}${path}`, cleanParams(params)), {
      credentials: 'include',
      signal,
    })
  } catch (err) {
    // The hard timeout fired -> a readable error the UI shows instead of a
    // forever-spinner. A caller cancel (unmount / re-query) re-throws so React
    // Query treats it as cancellation, not a surfaced failure.
    if (timeout.aborted) throw new ApiError(0, `IPTV ${path} timed out`)
    throw err
  }
  if (!res.ok) await throwApiError(res, `IPTV ${path}`)
  return res.json() as Promise<T>
}

async function post<T>(path: string, body?: unknown, opts?: RequestOpts): Promise<T> {
  const { signal, timeout } = withTimeout(opts)
  const init: RequestInit = {
    method: 'POST',
    credentials: 'include',
    signal,
  }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }

  let res: Response
  try {
    res = await fetch(apiUrl(`${BASE}${path}`), init)
  } catch (err) {
    if (timeout.aborted) throw new ApiError(0, `IPTV ${path} timed out`)
    throw err
  }
  if (!res.ok) await throwApiError(res, `IPTV ${path}`)
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

async function del(path: string, opts?: RequestOpts): Promise<void> {
  const { signal, timeout } = withTimeout(opts)
  let res: Response
  try {
    res = await fetch(apiUrl(`${BASE}${path}`), {
      method: 'DELETE',
      credentials: 'include',
      signal,
    })
  } catch (err) {
    if (timeout.aborted) throw new ApiError(0, `IPTV ${path} timed out`)
    throw err
  }
  if (!res.ok) await throwApiError(res, `IPTV ${path}`)
}

// Grant endpoints return URLs as relative paths like `/api/iptv/stream/…`
// because the backend doesn't know its own public hostname. The SPA is
// hosted on theemeraldexchange.com (Netlify) while the backend lives on
// api.theemeraldexchange.com; if we hand the player a relative URL, the
// browser resolves it against window.location and Netlify's catch-all
// rewrite returns the SPA shell HTML instead of the stream bytes. Run
// the URL through apiUrl() so it points at the backend the same way every
// other API call does.
function absolutize(url: string): string {
  return url.startsWith('/') ? apiUrl(url) : url
}

async function grant(path: string): Promise<StreamGrant> {
  const g = await post<StreamGrant>(path)
  return { ...g, url: absolutize(g.url) }
}

export type IptvKind = 'live' | 'vod' | 'series'
export type IptvHistoryKind = 'live' | 'vod' | 'series_episode'

export type StreamDelivery = 'mpegts' | 'hls' | 'progressive'

export type StreamGrant = {
  url: string
  delivery: StreamDelivery
  sessionId?: string
  mime?: string
  /** Optional sidecar subtitle (local-media transcode path only) rendered as a
   *  `<track>`. Live/IPTV grants leave it unset. `url` is absolute + token-bearing. */
  subtitle?: { url: string; language: string | null; forced: boolean } | null
}

export type SessionKind = 'live' | 'vod' | 'series' | 'catchup' | 'remux'

export type SessionRow = {
  sessionId: string
  sub: string
  kind: SessionKind
  resourceId: string
  title: string | null
  resolvedTitle: string | null
  ip: string | null
  startedAt: number
  lastSeen: number
}

export type SessionsResponse = {
  self: string
  upstream: { activeConnections: number; maxConnections: number; status: string } | null
  ours: SessionRow[]
}

export type PlaylistTokenRow = {
  jti: string
  sub: string
  deviceName: string | null
  issuedAt: string
  expiresAt: string
  revokedAt: string | null
  revoked: boolean
}

export type ConcurrencyLimitError = {
  reason: 'iptv_concurrency_limit'
  limit: number
  current: number
  sessions: SessionRow[]
}

// Payload for the 'source_unavailable' reason code (§9 / §12.4).
// Surfaced when the rank-1 source (Plex / media-core) goes offline
// mid-session. The client MUST present this as an explicit user action
// rather than seamlessly downgrading — codec, quality, and progress-
// attribution change when sources switch.
export type SourceUnavailableError = {
  reason: 'source_unavailable'
  available_alternatives: Array<{
    source: 'plex' | 'iptv' | 'local'
    displayName: string
    kind: string
    id: string
  }>
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

export type EpgProgrammeDto = {
  channel_id: string
  start_utc: string
  stop_utc: string
  title: string | null
  description: string | null
}

export type EpgNowRow = {
  channel_stream_id: number
  current: EpgProgrammeDto | null
  next: EpgProgrammeDto | null
}

export type EpgGridDto = {
  stream_id: number
  num: number
  name: string
  epg_channel_id: string | null
  tv_archive: number
  tv_archive_duration: number | null
  programmes: EpgProgrammeDto[]
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
  epgNow: (channelIds: number[]) => get<EpgNowRow[]>('/epg/now', {
    channelIds: channelIds.join(','),
  }),
  epgChannel: (channelId: number, fromIso: string, toIso: string) =>
    get<EpgProgrammeDto[]>(`/epg/channel/${channelId}`, { from: fromIso, to: toIso }),
  epgGrid: (
    fromIso: string,
    toIso: string,
    opts: { categoryId?: number; q?: string; hasEpg?: boolean } = {},
  ) => {
    // Build params conditionally — apiUrl stringifies undefined into the literal
    // "undefined", which the backend would reject as an invalid category.
    const params: Record<string, string | number> = { from: fromIso, to: toIso }
    if (opts.categoryId != null) params.categoryId = opts.categoryId
    if (opts.q && opts.q.trim()) params.q = opts.q.trim()
    if (opts.hasEpg) params.hasEpg = '1'
    return get<EpgGridDto[]>('/epg/grid', params)
  },
  grantLive: (streamId: string, opts?: { avplayer?: boolean }) => {
    const avplayer = opts?.avplayer ?? preferAvplayer()
    const suffix = avplayer ? '?client=avplayer' : ''
    return grant(`/stream/live/${streamId}/grant${suffix}`)
  },
  grantVod: (streamId: string) => grant(`/stream/vod/${streamId}/grant`),
  grantSeries: (episodeId: string) => grant(`/stream/series/${episodeId}/grant`),
  grantCatchup: (streamId: number, startUtc: string, durationMin: number) =>
    grant(`/stream/catchup/${streamId}/grant?startUtc=${encodeURIComponent(startUtc)}&durationMin=${durationMin}`),
  generatePlaylist: async () => {
    const r = await post<{ url: string; expiresAt: string }>('/playlist/token')
    return { ...r, url: absolutize(r.url) }
  },
  listPlaylistTokens: () => get<{ tokens: PlaylistTokenRow[] }>('/playlist/tokens'),
  revokePlaylistToken: (jti: string) => del(`/playlist/tokens/${encodeURIComponent(jti)}`),
  listSessions: () => get<SessionsResponse>('/sessions'),
  killSession: (sessionId: string) => del(`/sessions/${encodeURIComponent(sessionId)}`),
})
