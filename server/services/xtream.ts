import { env } from '../env.js'
import { fetchJsonWithTimeout, fetchWithTimeout } from './upstream.js'
import { normalizeEpgChannelId } from './iptvEpg.js'

export interface XtreamCreds {
  host: string
  username: string
  password: string
}

export interface AccountInfo {
  expiresAt: Date | null
  maxConnections: number
  activeConnections: number
  status: string
}

export function credsFromEnv(): XtreamCreds {
  if (!env.XTREAM_HOST || !env.XTREAM_USERNAME || !env.XTREAM_PASSWORD) {
    throw new Error('xtream_credentials_missing')
  }
  return {
    host: env.XTREAM_HOST.replace(/\/+$/, ''),
    username: env.XTREAM_USERNAME,
    password: env.XTREAM_PASSWORD,
  }
}

export function buildPlayerApiUrl(
  creds: XtreamCreds,
  action: string,
  extra?: Record<string, string | number>,
): string {
  const params = new URLSearchParams({
    username: creds.username,
    password: creds.password,
    action,
  })
  if (extra) {
    for (const [k, v] of Object.entries(extra)) params.set(k, String(v))
  }
  return `${creds.host}/player_api.php?${params.toString()}`
}

export function parseAccountInfo(payload: unknown): AccountInfo {
  const root = (payload as { user_info?: Record<string, unknown> })?.user_info ?? {}
  const rawExp = root.exp_date
  const expiresAt = safeEpochDate(rawExp)
  const maxConnections =
    typeof root.max_connections === 'number'
      ? root.max_connections
      : Number(root.max_connections ?? 0) || 0
  // Xtream Codes panels return active_cons as a string or number; some
  // resellers also expose `active_connections` instead. Read both.
  const rawActive = root.active_cons ?? (root as Record<string, unknown>).active_connections
  const activeConnections =
    typeof rawActive === 'number'
      ? rawActive
      : Number(rawActive ?? 0) || 0
  const status = typeof root.status === 'string' ? root.status : ''
  return { expiresAt, maxConnections, activeConnections, status }
}

export async function getAccountInfo(creds: XtreamCreds = credsFromEnv()): Promise<AccountInfo> {
  const probe = `${creds.host}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}`
  const res = await fetchWithTimeout(probe, {}, env.IPTV_LIST_TIMEOUT_MS, 'xtream.account_info')
  if (!res.ok) throw new Error(`xtream_account_${res.status}`)
  const json = (await res.json()) as unknown
  return parseAccountInfo(json)
}

const num = (v: unknown): number => {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}
const numOrNull = (v: unknown): number | null => {
  if (v == null) return null
  const n = num(v)
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown): string | null => (typeof v === 'string' ? v : v == null ? null : String(v))

const safeEpochDate = (v: unknown): Date | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n) || n <= 0) return null
  const d = new Date(n * 1000)
  return Number.isFinite(d.getTime()) ? d : null
}

const safeEpochIso = (v: unknown): string | null => safeEpochDate(v)?.toISOString() ?? null

export interface CategoryRow { category_id: number; name: string; parent_id: number }
export function parseCategoriesPayload(raw: unknown): CategoryRow[] {
  if (!Array.isArray(raw)) return []
  return raw.map((r) => {
    const o = r as Record<string, unknown>
    return {
      category_id: num(o.category_id),
      name: str(o.category_name) ?? '',
      parent_id: num(o.parent_id),
    }
  })
}

export interface ChannelRow {
  stream_id: number; num: number; name: string; stream_icon: string | null;
  epg_channel_id: string | null; category_id: number | null;
  is_adult: number; tv_archive: number; tv_archive_duration: number | null;
  added_ts: string | null; fetched_at: string
}
export function parseLiveStreams(raw: unknown, fetchedAt: string): ChannelRow[] {
  if (!Array.isArray(raw)) return []
  return raw.map((r) => {
    const o = r as Record<string, unknown>
    const addedSecs = numOrNull(o.added)
    return {
      stream_id: num(o.stream_id),
      num: num(o.num),
      name: str(o.name) ?? '',
      stream_icon: str(o.stream_icon),
      // Lowercase+trim so the tvg-id joins the (lowercase) XMLTV guide feed.
      epg_channel_id: normalizeEpgChannelId(str(o.epg_channel_id)),
      category_id: numOrNull(o.category_id),
      is_adult: num(o.is_adult) ? 1 : 0,
      tv_archive: num(o.tv_archive) ? 1 : 0,
      tv_archive_duration: numOrNull(o.tv_archive_duration),
      added_ts: safeEpochIso(addedSecs),
      fetched_at: fetchedAt,
    }
  })
}

export interface VodRow {
  stream_id: number; name: string; stream_icon: string | null; rating: number | null;
  category_id: number | null; container_extension: string | null;
  added_ts: string | null; tmdb_id: number | null; year: number | null;
  plot: string | null; director: string | null; cast_csv: string | null;
  fetched_at: string
}
export function parseVodStreams(raw: unknown, fetchedAt: string): VodRow[] {
  if (!Array.isArray(raw)) return []
  return raw.map((r) => {
    const o = r as Record<string, unknown>
    const addedSecs = numOrNull(o.added)
    return {
      stream_id: num(o.stream_id),
      name: str(o.name) ?? '',
      stream_icon: str(o.stream_icon),
      rating: numOrNull(o.rating),
      category_id: numOrNull(o.category_id),
      container_extension: str(o.container_extension),
      added_ts: safeEpochIso(addedSecs),
      tmdb_id: numOrNull(o.tmdb ?? o.tmdb_id),
      year: numOrNull(o.year),
      plot: str(o.plot),
      director: str(o.director),
      cast_csv: str(o.cast),
      fetched_at: fetchedAt,
    }
  })
}

export interface SeriesRow {
  series_id: number; name: string; cover: string | null; plot: string | null;
  rating: number | null; category_id: number | null; tmdb_id: number | null;
  last_modified: string | null; fetched_at: string
}
export function parseSeriesList(raw: unknown, fetchedAt: string): SeriesRow[] {
  if (!Array.isArray(raw)) return []
  return raw.map((r) => {
    const o = r as Record<string, unknown>
    return {
      series_id: num(o.series_id),
      name: str(o.name) ?? '',
      cover: str(o.cover),
      plot: str(o.plot),
      rating: numOrNull(o.rating),
      category_id: numOrNull(o.category_id),
      tmdb_id: numOrNull(o.tmdb ?? o.tmdb_id),
      last_modified: str(o.last_modified),
      fetched_at: fetchedAt,
    }
  })
}

async function getJson(url: string, label: string): Promise<unknown> {
  return fetchJsonWithTimeout(url, {}, env.IPTV_LIST_TIMEOUT_MS, label)
}

export async function fetchCategories(
  kind: 'live' | 'vod' | 'series',
  creds: XtreamCreds = credsFromEnv(),
): Promise<CategoryRow[]> {
  const action = kind === 'live' ? 'get_live_categories' : kind === 'vod' ? 'get_vod_categories' : 'get_series_categories'
  return parseCategoriesPayload(await getJson(buildPlayerApiUrl(creds, action), `xtream.${action}`))
}
export async function fetchLiveStreams(fetchedAt: string, creds: XtreamCreds = credsFromEnv()): Promise<ChannelRow[]> {
  return parseLiveStreams(await getJson(buildPlayerApiUrl(creds, 'get_live_streams'), 'xtream.get_live_streams'), fetchedAt)
}
export async function fetchVodStreams(fetchedAt: string, creds: XtreamCreds = credsFromEnv()): Promise<VodRow[]> {
  return parseVodStreams(await getJson(buildPlayerApiUrl(creds, 'get_vod_streams'), 'xtream.get_vod_streams'), fetchedAt)
}
export async function fetchSeriesList(fetchedAt: string, creds: XtreamCreds = credsFromEnv()): Promise<SeriesRow[]> {
  return parseSeriesList(await getJson(buildPlayerApiUrl(creds, 'get_series'), 'xtream.get_series'), fetchedAt)
}

export interface EpisodeRow {
  episode_id: string; series_id: number; season: number; episode_num: number;
  title: string | null; container_extension: string | null; added_ts: string | null;
  plot: string | null; duration_secs: number | null
}
export async function fetchSeriesInfo(seriesId: number, creds: XtreamCreds = credsFromEnv()): Promise<EpisodeRow[]> {
  const url = buildPlayerApiUrl(creds, 'get_series_info', { series_id: seriesId })
  const raw = (await getJson(url, 'xtream.get_series_info')) as { episodes?: Record<string, unknown[]> }
  const out: EpisodeRow[] = []
  const episodesBySeason = raw.episodes ?? {}
  for (const [seasonStr, eps] of Object.entries(episodesBySeason)) {
    const season = num(seasonStr)
    if (!Array.isArray(eps)) continue
    for (const r of eps) {
      const o = r as Record<string, unknown>
      const info = (o.info as Record<string, unknown> | undefined) ?? {}
      const addedSecs = numOrNull(o.added)
      out.push({
        episode_id: String(o.id),
        series_id: seriesId,
        season,
        episode_num: num(o.episode_num),
        title: str(o.title),
        container_extension: str(o.container_extension),
        added_ts: safeEpochIso(addedSecs),
        plot: str(info.plot ?? info.description),
        duration_secs: numOrNull(info.duration_secs),
      })
    }
  }
  return out
}
