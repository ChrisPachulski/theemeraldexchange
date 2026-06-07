// Thin fetch client for the authed media-core proxy mounted at
// /api/media (server/routes/media.ts). Mirrors radarr.ts: credentialed
// fetch + throwApiError on non-ok. media-core serializes serde
// snake_case with no rename, so we normalize to camelCase at this
// boundary and the rest of src stays camelCase-consistent.

import { throwApiError, ApiError } from './errors'
import { apiUrl } from './base'

const BASE = '/api/media'

// A stalled backend must not pin a query in 'pending' forever — abort and
// surface a clear error instead of an endless spinner.
const DEFAULT_TIMEOUT_MS = 15_000

/** Per-request options. `signal` is React Query's queryFn signal (so unmount /
 *  re-query cancels the in-flight fetch); it is combined with a hard timeout. */
export type RequestOpts = { signal?: AbortSignal; timeoutMs?: number }

function withTimeout(opts?: RequestOpts): { signal: AbortSignal; timeout: AbortSignal } {
  const timeout = AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = opts?.signal ? AbortSignal.any([timeout, opts.signal]) : timeout
  return { signal, timeout }
}

async function get<T>(
  path: string,
  params?: Record<string, string | number | boolean>,
  opts?: RequestOpts,
): Promise<T> {
  const { signal, timeout } = withTimeout(opts)
  let res: Response
  try {
    res = await fetch(apiUrl(`${BASE}${path}`, params), {
      credentials: 'include',
      signal,
    })
  } catch (err) {
    // Hard timeout -> readable error; caller cancel re-throws as cancellation.
    if (timeout.aborted) throw new ApiError(0, `Media ${path} timed out`)
    throw err
  }
  if (!res.ok) await throwApiError(res, `Media ${path}`)
  return res.json() as Promise<T>
}

async function post<T, B>(path: string, body: B, opts?: RequestOpts): Promise<T> {
  const { signal, timeout } = withTimeout(opts)
  let res: Response
  try {
    res = await fetch(apiUrl(`${BASE}${path}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (timeout.aborted) throw new ApiError(0, `Media ${path} timed out`)
    throw err
  }
  if (!res.ok) await throwApiError(res, `Media ${path}`)
  return res.json() as Promise<T>
}

// ── Raw row shapes (snake_case, exactly as media-core emits) ──────────

type RawMovieRow = {
  id: number
  tmdb_id: number | null
  imdb_id: string | null
  title: string
  year: number | null
  added_at: string
  file_id: number
  overview?: string | null
  poster_path?: string | null
}

type RawShowRow = {
  id: number
  tmdb_id: number | null
  tvdb_id: number | null
  title: string
  year: number | null
  added_at: string
  imdb_id?: string | null
  overview?: string | null
  poster_path?: string | null
}

type RawEpisodeRow = {
  id: number
  show_id: number
  season: number
  episode: number
  title: string | null
  air_date: string | null
  file_id: number
}

// Some list routes carry `total`; the show-scoped /shows/{id}/episodes
// and /watch do NOT. Type it optional and default to items.length.
type RawListResponse<T> = { items: T[]; total?: number }

// ── Normalized (camelCase) types the SPA consumes ────────────────────

export type MediaMovie = {
  id: number
  tmdbId: number | null
  imdbId: string | null
  title: string
  year: number | null
  addedAt: string
  fileId: number
  overview: string | null
  posterPath: string | null
}

export type MediaShow = {
  id: number
  tmdbId: number | null
  tvdbId: number | null
  title: string
  year: number | null
  addedAt: string
  imdbId: string | null
  overview: string | null
  posterPath: string | null
}

export type MediaEpisode = {
  id: number
  showId: number
  season: number
  episode: number
  title: string | null
  airDate: string | null
  fileId: number
}

export type MediaListResponse<T> = { items: T[]; total: number }

export type ScanStarted = { status: 'started'; jobId?: string | number }
export type ScanRunning = { status: 'running' }
export type ScanResponse = ScanStarted | ScanRunning

// ── Playback ─────────────────────────────────────────────────────────

/** Media kinds the playback grant accepts (movies + episodes have a file). */
export type PlayableKind = 'movie' | 'episode'

/** Capabilities advertised to the grant. snake_case to match the backend body
 *  (which forwards them to media-core's ClientCaps). */
export type PlaybackCaps = {
  containers: string[]
  video_codecs: string[]
  max_height?: number
  hdr: boolean
}

/** What the backend hands back: a tokenised URL the <video>/hls.js player can
 *  load cross-origin, plus playback metadata. Mirrors the IPTV StreamGrant
 *  ({ delivery, url }) so the shared IptvPlayer consumes it directly. */
export type PlaybackGrant = {
  delivery: 'progressive' | 'hls'
  /** Absolute, token-bearing stream/manifest URL. */
  url: string
  durationSecs: number | null
  /** Present only for the HLS (transcode) path — POST it to keep the session
   *  alive (the transcoder reaps idle sessions). */
  heartbeatUrl?: string | null
  sessionId?: string
}

/** A persisted watch-progress row (camelCase-normalised from media-core). */
export type WatchEntry = {
  mediaKind: PlayableKind
  mediaId: number
  positionSecs: number
  durationSecs: number | null
  watchedAt: string
  completed: boolean
}

type RawWatchRow = {
  media_kind: PlayableKind
  media_id: number
  position_secs: number
  duration_secs: number | null
  watched_at: string
  completed: number | boolean
}

/** Conservative browser playback capabilities. The backend already defaults to
 *  mp4/h264 (routing everything else through the transcoder); we advertise the
 *  same explicitly and cap height to the display so a 4K source isn't
 *  direct-played to a 1080p screen. */
export function browserCaps(): PlaybackCaps {
  const screenH =
    typeof window !== 'undefined' && window.screen?.height ? window.screen.height : 1080
  return {
    containers: ['mp4'],
    video_codecs: ['h264'],
    max_height: Math.max(screenH, 720),
    hdr: false,
  }
}

// ── Normalizers ──────────────────────────────────────────────────────

function normMovie(r: RawMovieRow): MediaMovie {
  return {
    id: r.id,
    tmdbId: r.tmdb_id ?? null,
    imdbId: r.imdb_id ?? null,
    title: r.title,
    year: r.year ?? null,
    addedAt: r.added_at,
    fileId: r.file_id,
    overview: r.overview ?? null,
    posterPath: r.poster_path ?? null,
  }
}

function normShow(r: RawShowRow): MediaShow {
  return {
    id: r.id,
    tmdbId: r.tmdb_id ?? null,
    tvdbId: r.tvdb_id ?? null,
    title: r.title,
    year: r.year ?? null,
    addedAt: r.added_at,
    imdbId: r.imdb_id ?? null,
    overview: r.overview ?? null,
    posterPath: r.poster_path ?? null,
  }
}

function normEpisode(r: RawEpisodeRow): MediaEpisode {
  return {
    id: r.id,
    showId: r.show_id,
    season: r.season,
    episode: r.episode,
    title: r.title ?? null,
    airDate: r.air_date ?? null,
    fileId: r.file_id,
  }
}

function normList<R, T>(
  raw: RawListResponse<R>,
  map: (r: R) => T,
): MediaListResponse<T> {
  const items = (raw.items ?? []).map(map)
  // `total` is absent on the show-scoped episodes route — fall back to
  // the page length so callers never see undefined.
  return { items, total: raw.total ?? items.length }
}

// ── Poster resolver seam ─────────────────────────────────────────────
//
// media-core does not yet populate poster_path (NULL on every row until
// a TMDB re-scan lands). Returning undefined here makes MediaCard render
// its first-letter fallback. When enrichment ships we change ONLY this
// function — e.g. build a TMDB image URL from posterPath — not every
// call site.
export function posterFor(item: {
  posterPath?: string | null
}): string | undefined {
  if (!item.posterPath) return undefined
  // poster_path is a TMDB relative path like "/abc.jpg"; resolve to the
  // public TMDB image CDN at a card-appropriate width.
  return `https://image.tmdb.org/t/p/w342${item.posterPath}`
}

type RawPlaybackGrant = {
  delivery: 'progressive' | 'hls'
  url: string
  durationSecs: number | null
  heartbeatUrl?: string | null
  sessionId?: string
}

// The grant's url/heartbeatUrl are returned root-relative; resolve them through
// apiUrl so the <video>/hls.js element loads them from the API origin (which in
// prod is a different host than the SPA). The embedded ?t= token is preserved.
function absolutizeGrant(g: RawPlaybackGrant): PlaybackGrant {
  return {
    delivery: g.delivery,
    url: g.url.startsWith('/') ? apiUrl(g.url) : g.url,
    durationSecs: g.durationSecs ?? null,
    heartbeatUrl: g.heartbeatUrl
      ? g.heartbeatUrl.startsWith('/')
        ? apiUrl(g.heartbeatUrl)
        : g.heartbeatUrl
      : null,
    sessionId: g.sessionId,
  }
}

function normWatch(r: RawWatchRow): WatchEntry {
  return {
    mediaKind: r.media_kind,
    mediaId: r.media_id,
    positionSecs: r.position_secs,
    durationSecs: r.duration_secs ?? null,
    watchedAt: r.watched_at,
    completed: Boolean(r.completed),
  }
}

type WatchUpsertBody = {
  media_kind: PlayableKind
  media_id: number
  position_secs: number
  duration_secs?: number
  completed: boolean
}

// media-core's list routes clamp `limit` to 1..=200 and default to 50 when
// it's omitted. The "Play Direct" tmdbId index needs EVERY local title, not
// the first page — calling /movies with no limit only ever indexed 50 titles,
// so the button silently vanished for the rest of a large library. Page
// through at the max page size and concatenate. The cap is a runaway guard
// (200 pages = 40k titles, far above any real homelab library).
const LIST_PAGE_SIZE = 200
const MAX_LIST_PAGES = 200

async function fetchAllPages<R, T>(
  path: string,
  map: (r: R) => T,
  req?: RequestOpts,
): Promise<T[]> {
  const out: T[] = []
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const raw = await get<RawListResponse<R>>(
      path,
      { limit: LIST_PAGE_SIZE, offset: page * LIST_PAGE_SIZE },
      req,
    )
    const items = (raw.items ?? []).map(map)
    out.push(...items)
    if (items.length < LIST_PAGE_SIZE) break
  }
  return out
}

// ── Public API ───────────────────────────────────────────────────────

export const mediaApi = {
  movies: (q?: string, req?: RequestOpts) =>
    get<RawListResponse<RawMovieRow>>('/movies', q ? { q } : undefined, req).then(
      (raw) => normList(raw, normMovie),
    ),
  shows: (q?: string, req?: RequestOpts) =>
    get<RawListResponse<RawShowRow>>('/shows', q ? { q } : undefined, req).then(
      (raw) => normList(raw, normShow),
    ),
  /** Every local movie (paged past the 50/200 list cap) — for the
   *  tmdbId→id "Play Direct" index, which must cover the whole library. */
  allMovies: (req?: RequestOpts): Promise<MediaMovie[]> =>
    fetchAllPages<RawMovieRow, MediaMovie>('/movies', normMovie, req),
  /** Every local show (paged) — for the show "Watch episodes" index. */
  allShows: (req?: RequestOpts): Promise<MediaShow[]> =>
    fetchAllPages<RawShowRow, MediaShow>('/shows', normShow, req),
  episodes: (showId: number, req?: RequestOpts) =>
    get<RawListResponse<RawEpisodeRow>>(`/shows/${showId}/episodes`, undefined, req).then(
      (raw) => normList(raw, normEpisode),
    ),
  scan: () => post<ScanResponse, Record<string, never>>('/scan', {}),

  /** Request a playback grant. Returns a tokenised URL the player loads. */
  playback: (kind: PlayableKind, id: number, caps: PlaybackCaps = browserCaps()) =>
    post<RawPlaybackGrant, PlaybackCaps>(`/playback/${kind}/${id}`, caps).then(absolutizeGrant),

  /** The current user's watch-progress rows. */
  watch: (req?: RequestOpts) =>
    get<{ items: RawWatchRow[] }>('/watch', undefined, req).then((r) =>
      (r.items ?? []).map(normWatch),
    ),

  /** Upsert watch progress for one title. */
  saveWatch: (entry: {
    kind: PlayableKind
    id: number
    positionSecs: number
    durationSecs?: number | null
    completed?: boolean
  }) =>
    post<{ ok: boolean }, WatchUpsertBody>('/watch', {
      media_kind: entry.kind,
      media_id: entry.id,
      position_secs: Math.max(0, Math.floor(entry.positionSecs)),
      ...(entry.durationSecs != null && Number.isFinite(entry.durationSecs)
        ? { duration_secs: Math.floor(entry.durationSecs) }
        : {}),
      completed: entry.completed ?? false,
    }),

  /** Keep a transcode session alive. Fire-and-forget; the absolute heartbeatUrl
   *  already carries its ?t= token, so no credentials are needed. */
  heartbeat: (url: string) =>
    fetch(url, { method: 'POST', keepalive: true }).catch(() => undefined),
}
