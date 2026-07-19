// Thin fetch client for the authed media-core proxy mounted at
// /api/media (server/routes/media.ts). Mirrors radarr.ts: credentialed
// fetch + throwApiError on non-ok. media-core serializes serde
// snake_case with no rename, so we normalize to camelCase at this
// boundary and the rest of src stays camelCase-consistent.

import { throwApiError, ApiError } from './errors'
import { apiUrl } from './base'
import { withTimeout, type RequestOpts } from './timeout'
import { SESSION_EXPIRED_EVENT } from '../queryClient'

const BASE = '/api/media'

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
  /** Audio codecs this client can decode (backend default: ['aac']). */
  audio_codecs?: string[]
  /** Max AAC channels the MSE path can append (backend default: 2 — Chrome
   *  and Firefox reject a >2-channel AAC SourceBuffer append). */
  aac_max_channels?: number
  /** This client's HLS player can play HEVC carried in fMP4 segments, so the
   *  transcoder may copy-remux HEVC instead of re-encoding it. */
  hls_fmp4_hevc?: boolean
}

type PlaybackRequest = PlaybackCaps & {
  /** Optional resume offset. The backend forwards this to the HLS transcoder. */
  start_secs?: number
  /** Demand buffered (HLS) delivery even for a direct-play-eligible file.
   *  The transcoder resolves these to a lossless copy-remux session; sent by
   *  the player's stall-escalation path. */
  force_hls?: boolean
}

/** What the backend hands back: a tokenised URL the <video>/hls.js player can
 *  load cross-origin, plus playback metadata. Mirrors the IPTV StreamGrant
 *  ({ delivery, url }) so the shared IptvPlayer consumes it directly. */
/** A pre-extracted sidecar subtitle for the HLS (transcode) path: a complete
 *  WebVTT served alongside the session and loaded as a `<track>`. Present only
 *  when the title carried a text subtitle. */
export type PlaybackSubtitle = {
  /** Absolute, token-bearing `.vtt` URL (same stream token as the segments). */
  url: string
  /** ISO language tag for `<track srclang>`, when known. */
  language: string | null
  /** Whether this is a forced/narrative track (shown by default). */
  forced: boolean
}

export type PlaybackGrant = {
  delivery: 'progressive' | 'hls'
  /** Absolute, token-bearing stream/manifest URL. */
  url: string
  durationSecs: number | null
  /** Present only for the HLS (transcode) path — POST it to keep the session
   *  alive (the transcoder reaps idle sessions). */
  heartbeatUrl?: string | null
  /** Present only for the HLS (transcode) path — POST it on player close to
   *  free the transcoder's concurrency slot immediately (don't wait for the
   *  30s idle reaper). */
  stopUrl?: string | null
  sessionId?: string
  /** Sidecar subtitle for the transcode path; `null` when the title has none. */
  subtitle?: PlaybackSubtitle | null
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

/** Conservative fallback playback capabilities — the canonical web-safe
 *  profile (mp4 + h264 + SDR + stereo AAC) every browser plays. Used when the
 *  MediaCapabilities probe is unavailable (old browsers, node tests) or
 *  rejects. NOTE: deliberately NO screen-height gate — browsers downscale a
 *  4K source on a smaller display natively, and forcing those titles through
 *  the transcoder traded a perfect picture for a 1080p re-encode. */
export function browserCaps(): PlaybackCaps {
  return {
    containers: ['mp4'],
    video_codecs: ['h264'],
    max_height: 2160,
    hdr: false,
    audio_codecs: ['aac'],
    aac_max_channels: 2,
    hls_fmp4_hevc: false,
  }
}

// ── Real capability probing ──────────────────────────────────────────
//
// `navigator.mediaCapabilities.decodingInfo` is the only probe that is
// resolution-, bit-depth- and CHANNEL-aware. The legacy checks lie in exactly
// the ways that used to grey-box this app: `isTypeSupported('mp4a.40.2')`
// says yes while Chrome's MSE rejects the 6-channel AAC append, and codec
// strings say yes for HEVC on machines with no hardware decoder. Everything
// below resolves to the conservative `browserCaps()` baseline on any error,
// so a probe failure can only ever cost quality, never playback.

/** The HDR members of VideoConfiguration as literal unions (typed locally so
 *  both tsconfig DOM libs — one predates the fields, one ships them as enums —
 *  accept the same code). Browsers that don't know a member ignore it per
 *  WebIDL; unknown VALUES reject, which the catch maps to false. */
type ProbeTransferFunction = 'srgb' | 'hlg' | 'pq'
type ProbeHdrMetadataType = 'smpteSt2086' | 'smpteSt2094-10' | 'smpteSt2094-40'
type ProbeColorGamut = 'srgb' | 'p3' | 'rec2020'

type HdrVideoConfiguration = VideoConfiguration & {
  transferFunction?: ProbeTransferFunction
  hdrMetadataType?: ProbeHdrMetadataType
  colorGamut?: ProbeColorGamut
}

/** decodingInfo for a video config; false on rejection/absence. */
function probeVideo(
  contentType: string,
  opts: {
    type: 'media-source' | 'file'
    width?: number
    height?: number
    bitrate?: number
    transferFunction?: ProbeTransferFunction
    hdrMetadataType?: ProbeHdrMetadataType
    colorGamut?: ProbeColorGamut
  },
): Promise<boolean> {
  try {
    const video: HdrVideoConfiguration = {
      contentType,
      width: opts.width ?? 1920,
      height: opts.height ?? 1080,
      bitrate: opts.bitrate ?? 8_000_000,
      framerate: 30,
    }
    if (opts.transferFunction) video.transferFunction = opts.transferFunction
    if (opts.hdrMetadataType) video.hdrMetadataType = opts.hdrMetadataType
    if (opts.colorGamut) video.colorGamut = opts.colorGamut
    return navigator.mediaCapabilities
      .decodingInfo({ type: opts.type, video })
      .then((r) => r.supported)
      .catch(() => false)
  } catch {
    return Promise.resolve(false)
  }
}

/** decodingInfo for an audio config; false on rejection/absence. */
function probeAudio(
  contentType: string,
  channels: number,
  type: 'media-source' | 'file',
): Promise<boolean> {
  try {
    return navigator.mediaCapabilities
      .decodingInfo({
        type,
        audio: {
          contentType,
          // The spec types `channels` as a DOMString.
          channels: String(channels),
          bitrate: 256_000,
          samplerate: 48_000,
        },
      })
      .then((r) => r.supported)
      .catch(() => false)
  } catch {
    return Promise.resolve(false)
  }
}

async function buildProbedCaps(): Promise<PlaybackCaps> {
  if (typeof navigator === 'undefined' || !navigator.mediaCapabilities?.decodingInfo) {
    return browserCaps()
  }
  // Canonical strings (Jellyfin-web/StaZhu): hev1.* = in-band parameter sets
  // (the MSE/hls.js form), hvc1.* = out-of-band (the progressive-mp4 form
  // Apple requires). HEVC is advertised only when BOTH Main and Main 10 pass
  // — the backend treats "hevc" as implying Main 10 (it is the normal HEVC
  // profile wherever HEVC is hardware-decoded at all).
  const [
    hevcMseMain,
    hevcMse10,
    hevcFile10,
    av1File,
    hdr10,
    aac6,
    eac3Mse,
    eac3File,
    ac3Mse,
    ac3File,
  ] = await Promise.all([
    probeVideo('video/mp4; codecs="hev1.1.6.L120.90"', { type: 'media-source' }),
    probeVideo('video/mp4; codecs="hev1.2.4.L153.B0"', {
      type: 'media-source',
      width: 3840,
      height: 2160,
      bitrate: 40_000_000,
    }),
    probeVideo('video/mp4; codecs="hvc1.2.4.L153.B0"', {
      type: 'file',
      width: 3840,
      height: 2160,
      bitrate: 40_000_000,
    }),
    probeVideo('video/mp4; codecs="av01.0.08M.08"', { type: 'file' }),
    // hdr=true means "send me the 10-bit PQ stream untouched; I decode the
    // metadata and tone-map for my own display" — NOT "I have an HDR panel".
    probeVideo('video/mp4; codecs="hvc1.2.4.L153.B0"', {
      type: 'file',
      width: 3840,
      height: 2160,
      bitrate: 40_000_000,
      transferFunction: 'pq',
      hdrMetadataType: 'smpteSt2086',
      colorGamut: 'rec2020',
    }),
    // The Chrome 6-channel-AAC liar-catcher: isTypeSupported says yes, the
    // actual SourceBuffer append fails. decodingInfo knows the truth.
    probeAudio('audio/mp4; codecs="mp4a.40.2"', 6, 'media-source'),
    probeAudio('audio/mp4; codecs="ec-3"', 6, 'media-source'),
    probeAudio('audio/mp4; codecs="ec-3"', 6, 'file'),
    probeAudio('audio/mp4; codecs="ac-3"', 6, 'media-source'),
    probeAudio('audio/mp4; codecs="ac-3"', 6, 'file'),
  ])

  const hevc = hevcMseMain && hevcMse10 && hevcFile10
  // audio_codecs drives BOTH direct play (progressive file) AND the
  // transcoder's copy-into-HLS decision, so a codec is advertised only when
  // both delivery paths can decode it (Safari/Edge yes; Chrome/Firefox no).
  const eac3 = eac3Mse && eac3File
  const ac3 = ac3Mse && ac3File
  return {
    // Never 'mkv': no browser progressive-plays matroska (the backend
    // hard-denies it too — defense in depth).
    containers: ['mp4'],
    video_codecs: ['h264', ...(hevc ? ['hevc'] : []), ...(av1File ? ['av1'] : [])],
    max_height: 2160,
    hdr: hdr10,
    audio_codecs: ['aac', ...(eac3 ? ['eac3'] : []), ...(ac3 ? ['ac3'] : [])],
    aac_max_channels: aac6 ? 6 : 2,
    // HEVC fMP4 segments need the MSE-side decode (hls.js appends them raw).
    hls_fmp4_hevc: hevcMseMain && hevcMse10,
  }
}

let probedCapsPromise: Promise<PlaybackCaps> | null = null

/** The real, probed capabilities of this browser — resolved once per page
 *  load and cached (the probes are pure feature detection; nothing about
 *  them changes within a session). Falls back to `browserCaps()` on any
 *  failure, so callers can always await this safely. */
export function probedCaps(): Promise<PlaybackCaps> {
  probedCapsPromise ??= buildProbedCaps().catch(() => browserCaps())
  return probedCapsPromise
}

/** Test seam: reset the probe cache (vitest re-runs with fresh mocks). */
export function resetProbedCapsForTest(): void {
  probedCapsPromise = null
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

type RawPlaybackGrant = {
  delivery: 'progressive' | 'hls'
  url: string
  durationSecs: number | null
  heartbeatUrl?: string | null
  stopUrl?: string | null
  sessionId?: string
  subtitle?: { url: string; language?: string | null; forced?: boolean } | null
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
    stopUrl: g.stopUrl
      ? g.stopUrl.startsWith('/')
        ? apiUrl(g.stopUrl)
        : g.stopUrl
      : null,
    sessionId: g.sessionId,
    // The sidecar `.vtt` URL is root-relative like the manifest; resolve it
    // through apiUrl so the <track> loads from the API origin (cross-origin in
    // prod). The embedded ?t= stream token is preserved.
    subtitle:
      g.subtitle && g.subtitle.url
        ? {
            url: g.subtitle.url.startsWith('/') ? apiUrl(g.subtitle.url) : g.subtitle.url,
            language: g.subtitle.language ?? null,
            forced: g.subtitle.forced ?? false,
          }
        : null,
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

export type WatchSaveEntry = {
  kind: PlayableKind
  id: number
  positionSecs: number
  durationSecs?: number | null
  completed?: boolean
}

/** Shared body builder for saveWatch (in-session upsert) and flushWatch
 *  (keepalive unload flush) so the two can't drift. */
function watchUpsertBody(entry: WatchSaveEntry): WatchUpsertBody {
  return {
    media_kind: entry.kind,
    media_id: entry.id,
    position_secs: Math.max(0, Math.floor(entry.positionSecs)),
    ...(entry.durationSecs != null && Number.isFinite(entry.durationSecs)
      ? { duration_secs: Math.floor(entry.durationSecs) }
      : {}),
    completed: entry.completed ?? false,
  }
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

  /** Request a playback grant. Returns a tokenised URL the player loads.
   *  With no explicit caps, the REAL probed capabilities of this browser are
   *  advertised (cached after the first call), so HEVC/HDR/E-AC-3 titles
   *  direct-play or copy-remux wherever the browser proved it can decode
   *  them instead of being blanket re-encoded. */
  playback: async (
    kind: PlayableKind,
    id: number,
    caps?: PlaybackCaps,
    startPositionSecs?: number,
    forceHls?: boolean,
  ) => {
    const body: PlaybackRequest = { ...(caps ?? (await probedCaps())) }
    if (startPositionSecs != null && Number.isFinite(startPositionSecs) && startPositionSecs > 0) {
      body.start_secs = Math.floor(startPositionSecs)
    }
    if (forceHls) body.force_hls = true
    return post<RawPlaybackGrant, PlaybackRequest>(`/playback/${kind}/${id}`, body).then(absolutizeGrant)
  },

  /** The current user's watch-progress rows. */
  watch: (req?: RequestOpts) =>
    get<{ items: RawWatchRow[] }>('/watch', undefined, req).then((r) =>
      (r.items ?? []).map(normWatch),
    ),

  /** Upsert watch progress for one title. */
  saveWatch: (entry: WatchSaveEntry) =>
    post<{ ok: boolean }, WatchUpsertBody>('/watch', watchUpsertBody(entry)),

  /** Final watch-progress flush for page unload (tab close / navigation)
   *  and visibility loss. fetch keepalive (the mediaApi.stop pattern)
   *  rather than navigator.sendBeacon: the upstream media-core handler
   *  is an axum Json extractor that REQUIRES Content-Type
   *  application/json, and a cross-origin beacon with a JSON Blob needs
   *  a CORS preflight the Beacon API cannot perform — it would silently
   *  fail on the Netlify-SPA-to-NAS-API split. keepalive fetches survive
   *  document teardown and support credentials + preflight in every
   *  current browser. Fire-and-forget; no timeout signal (unload-time
   *  timers don't reliably run). A response received before teardown
   *  still reports a 401 through the shared session-expiry event. */
  flushWatch: (entry: WatchSaveEntry): void => {
    void fetch(apiUrl(`${BASE}/watch`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(watchUpsertBody(entry)),
      keepalive: true,
    })
      .then((response) => {
        if (response.status === 401) {
          window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
        }
      })
      .catch(() => undefined)
  },

  /** Keep a transcode session alive. The absolute heartbeatUrl already carries
   *  its ?t= token, so no credentials are needed. Resolves to the HTTP status
   *  (undefined on network failure) so the player can tell a reaped session
   *  (404 — stop and re-grant) from a transient blip (keep beating). */
  heartbeat: (url: string): Promise<number | undefined> =>
    fetch(url, { method: 'POST', keepalive: true }).then(
      (res) => res.status,
      () => undefined,
    ),

  /** Stop a transcode session, freeing its concurrency slot immediately.
   *  Fire-and-forget with keepalive so it still flushes during page unload
   *  (pagehide/tab close). The absolute stopUrl carries its own ?t= token. */
  stop: (url: string) =>
    fetch(url, { method: 'POST', keepalive: true }).catch(() => undefined),
}
