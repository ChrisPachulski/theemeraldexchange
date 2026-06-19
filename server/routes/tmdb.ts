// TMDB credits proxy. We keep the API key server-side and surface only
// the credits endpoint, scoped to either a Sonarr-tracked TV show
// (identified by TVDB id) or a Radarr-tracked movie (TMDB id).
//
// Sonarr/Radarr don't expose cast in their v3 APIs, so the detail modal
// reaches here for cast data. If neither TMDB_READ_ACCESS_TOKEN nor
// TMDB_API_KEY is set, this route returns 503 and the frontend gracefully
// omits the cast section.

import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { requireAuth, type Env } from '../middleware/auth.js'
import { env } from '../env.js'
import { fetchWithTimeout, WAN_TIMEOUT_MS } from '../services/upstream.js'
import { resolveTrailerUrl, isValidYouTubeId } from '../services/ytdlp.js'
import { getOrFetchResolved } from '../services/ytresolve.js'
import { ensureMuxedTrailer, muxedTrailerPath } from '../services/ytmux.js'
import {
  signMediaToken,
  verifyMediaToken,
  mediaResourceId,
  MEDIA_DIRECT_KIND,
} from '../services/mediaStreamToken.js'
import { memberStatus } from '../services/membership.js'
import { publicBaseUrl } from './iptv.js'

export const tmdb = new Hono<Env>()

// Auth gate: the muxed-trailer stream (`/trailer/<id>/stream.mp4`) authenticates
// via a signed `?t=` token bound to that video id, so AVPlayer can fetch it
// cookielessly (same machinery as local-media `/stream/*`). Every other tmdb
// subpath requires the session cookie/bearer. Mirrors media.ts mediaAuth.
async function trailerStreamAuth(c: Context<Env>, next: Next) {
  const subpath = new URL(c.req.url).pathname.replace(/^\/api\/tmdb/, '') || '/'
  const m = subpath.match(/^\/trailer\/([A-Za-z0-9_-]{11})\/stream\.mp4/)
  const token = c.req.query('t')
  if (m && token) {
    const rid = mediaResourceId('trailer', m[1])
    const v = verifyMediaToken(token, { kinds: [MEDIA_DIRECT_KIND], rid })
    if (!v.ok) return c.json({ error: v.error }, 401)
    if (memberStatus(v.sub) !== 'allowed') return c.json({ error: 'access_revoked' }, 401)
    return next()
  }
  return requireAuth(c, next)
}

tmdb.use('*', trailerStreamAuth)

const TMDB_BASE = 'https://api.themoviedb.org/3'

// TMDB/TVDB ids are positive integers. Validate before spending an
// upstream call so garbage query values can't each turn into an
// outbound TMDB request (response-size / rate-limit amplification on
// the shared TMDB budget). Mirrors recommenderEvents.ts:49 and
// grabs.ts:42, which gate ids with Number.isSafeInteger(...) > 0 before
// forwarding.
function positiveIntId(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n <= 0) return null
  return n
}

async function tmdbFetch(path: string, params: Record<string, string> = {}) {
  if (!(env.tmdbReadAccessToken ?? env.tmdbApiKey)) {
    return null
  }
  const url = new URL(`${TMDB_BASE}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (env.tmdbReadAccessToken) {
    headers.Authorization = `Bearer ${env.tmdbReadAccessToken}`
  } else if (env.tmdbApiKey) {
    url.searchParams.set('api_key', env.tmdbApiKey)
  }
  return fetchWithTimeout(
    url,
    { headers },
    WAN_TIMEOUT_MS,
    `tmdb${path}`,
  )
}

tmdb.get('/credits', async (c) => {
  if (!(env.tmdbReadAccessToken ?? env.tmdbApiKey)) {
    return c.json({ error: 'tmdb_not_configured' }, 503)
  }

  const type = c.req.query('type')

  if (type === 'tv') {
    const tvdbId = positiveIntId(c.req.query('tvdbId'))
    if (tvdbId === null) {
      return c.json({ error: 'invalid_tvdbId' }, 400)
    }
    // TVDB → TMDB lookup. /find returns matches across types; we take
    // the first tv_results entry.
    const findRes = await tmdbFetch(`/find/${tvdbId}`, {
      external_source: 'tvdb_id',
    })
    if (!findRes || !findRes.ok) {
      return c.json({ error: 'tmdb_find_failed', status: findRes?.status }, 502)
    }
    const findData = (await findRes.json()) as { tv_results?: Array<{ id: number }> }
    const id = findData.tv_results?.[0]?.id
    if (!id) return c.json({ cast: [], crew: [] })
    const credits = await tmdbFetch(`/tv/${id}/aggregate_credits`)
    if (!credits || !credits.ok) {
      return c.json({ error: 'tmdb_credits_failed', status: credits?.status }, 502)
    }
    const data = await credits.json()
    return c.json(data)
  }

  if (type === 'movie') {
    const tmdbId = positiveIntId(c.req.query('tmdbId'))
    if (tmdbId === null) {
      return c.json({ error: 'invalid_tmdbId' }, 400)
    }
    const credits = await tmdbFetch(`/movie/${tmdbId}/credits`)
    if (!credits || !credits.ok) {
      return c.json({ error: 'tmdb_credits_failed', status: credits?.status }, 502)
    }
    const data = await credits.json()
    return c.json(data)
  }

  return c.json({ error: 'invalid_query' }, 400)
})

// Trending feed — surfaces TMDB's week-window list of the most-talked-
// about titles for the requested type. Used by the Discover tab as a
// landing row so users see something to browse before they search.
//
// Type param: 'movie' or 'tv'. We pin the window to 'week' (vs 'day')
// because day-trending whipsaws on news cycles; week reads as "what's
// hot right now" without being volatile.
tmdb.get('/trending/:type', async (c) => {
  if (!(env.tmdbReadAccessToken ?? env.tmdbApiKey)) {
    return c.json({ error: 'tmdb_not_configured' }, 503)
  }
  const type = c.req.param('type')
  if (type !== 'movie' && type !== 'tv') {
    return c.json({ error: 'invalid_type' }, 400)
  }
  const res = await tmdbFetch(`/trending/${type}/week`)
  if (!res || !res.ok) {
    return c.json({ error: 'tmdb_trending_failed', status: res?.status }, 502)
  }
  const data = (await res.json()) as { results?: unknown[] }
  return c.json(data)
})

// Resolve a Sonarr TVDB id to its TMDB tv id (Sonarr tracks by TVDB; TMDB's
// /videos etc. key by TMDB id). Mirrors the /credits TV branch.
async function tvTmdbId(tvdbId: number): Promise<number | null> {
  const findRes = await tmdbFetch(`/find/${tvdbId}`, { external_source: 'tvdb_id' })
  if (!findRes || !findRes.ok) return null
  const data = (await findRes.json()) as { tv_results?: Array<{ id: number }> }
  return data.tv_results?.[0]?.id ?? null
}

// Resolve a (type, id-or-tvdbId) request to the TMDB id + media-type path
// segment, or an error tuple. Shared by /videos and /related.
async function resolveTmdb(
  type: string | undefined,
  movieId: number | null,
  tvdbId: number | null,
): Promise<{ id: number; path: 'movie' | 'tv' } | { error: string; status: 400 | 502 }> {
  if (type === 'movie') {
    if (movieId === null) return { error: 'invalid_tmdbId', status: 400 }
    return { id: movieId, path: 'movie' }
  }
  if (type === 'tv') {
    if (tvdbId === null) return { error: 'invalid_tvdbId', status: 400 }
    const id = await tvTmdbId(tvdbId)
    if (id === null) return { error: 'tmdb_find_failed', status: 502 }
    return { id, path: 'tv' }
  }
  return { error: 'invalid_query', status: 400 }
}

// Trailers + extras for a title. TMDB /videos returns YouTube keys (trailers,
// teasers, featurettes, clips, behind-the-scenes). We surface the YouTube ones,
// official trailers first, so the app can show a "Trailer" action + an extras
// shelf. Playback is resolved separately via /trailer (the app can't embed
// YouTube on tvOS, so the key alone isn't playable).
tmdb.get('/videos', async (c) => {
  if (!(env.tmdbReadAccessToken ?? env.tmdbApiKey)) {
    return c.json({ error: 'tmdb_not_configured' }, 503)
  }
  const resolved = await resolveTmdb(
    c.req.query('type'),
    positiveIntId(c.req.query('tmdbId')),
    positiveIntId(c.req.query('tvdbId')),
  )
  if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status)

  const res = await tmdbFetch(`/${resolved.path}/${resolved.id}/videos`)
  if (!res || !res.ok) {
    return c.json({ error: 'tmdb_videos_failed', status: res?.status }, 502)
  }
  const data = (await res.json()) as {
    results?: Array<{ key: string; name: string; site: string; type: string; official?: boolean }>
  }
  const rank = (v: { type: string; official?: boolean }) => {
    if (v.type === 'Trailer') return v.official ? 0 : 1
    if (v.type === 'Teaser') return 2
    return 3
  }
  const videos = (data.results ?? [])
    .filter((v) => v.site === 'YouTube' && isValidYouTubeId(v.key))
    .map((v) => ({ key: v.key, name: v.name, type: v.type, official: v.official ?? false }))
    .sort((a, b) => rank(a) - rank(b))
  return c.json({ videos })
})

// "More like this" — TMDB recommendations (falls back to /similar when TMDB has
// no curated recommendations for the title). Returns the poster/title/year/id
// the app needs to render a related-titles shelf.
tmdb.get('/related', async (c) => {
  if (!(env.tmdbReadAccessToken ?? env.tmdbApiKey)) {
    return c.json({ error: 'tmdb_not_configured' }, 503)
  }
  const resolved = await resolveTmdb(
    c.req.query('type'),
    positiveIntId(c.req.query('tmdbId')),
    positiveIntId(c.req.query('tvdbId')),
  )
  if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status)

  type Row = { id: number; title?: string; name?: string; poster_path?: string | null; release_date?: string; first_air_date?: string }
  const fetchList = async (kind: 'recommendations' | 'similar'): Promise<Row[]> => {
    const res = await tmdbFetch(`/${resolved.path}/${resolved.id}/${kind}`)
    if (!res || !res.ok) return []
    const data = (await res.json()) as { results?: Row[] }
    return data.results ?? []
  }
  let rows = await fetchList('recommendations')
  if (rows.length === 0) rows = await fetchList('similar')

  const items = rows
    .filter((r) => r.poster_path)
    .slice(0, 20)
    .map((r) => ({
      tmdbId: r.id,
      title: r.title ?? r.name ?? '',
      year: Number((r.release_date ?? r.first_air_date ?? '').slice(0, 4)) || null,
      posterPath: r.poster_path ?? null,
    }))
  return c.json({ items })
})

// Resolve a YouTube video id (trailer/extra) to a directly-playable URL for
// AVPlayer. Server-side because tvOS has no WebKit/YouTube embed.
//
// Resolution priority (first that succeeds wins):
//   1. eex-ytresolve (native Rust binary, no Python) — tries the iOS
//      Innertube client to get pre-signed stream URLs directly.
//      a. resolved.hls  → return it as-is (AVPlayer / hls.js plays natively).
//      b. resolved.progressive → single muxed mp4, return the direct URL.
//      c. resolved.video + resolved.audio (adaptive-only) → proxy+remux: pull
//         both streams down in sub-cap `&range=` chunks and `ffmpeg -c copy`
//         them into one faststart mp4 we serve ourselves (services/ytmux.ts),
//         handing AVPlayer a tokenised URL to our /stream.mp4 route. A manifest
//         pointing straight at the googlevideo URLs can't work (they 403 plain/
//         over-cap GETs), which is why we localise + mux instead.
//   2. yt-dlp fallback — shelled Python process that downloads with proper
//      ranges + muxes; also handles age/region/cipher cases the Rust path can't
//      (and the adaptive mux above if it fails).
//
// A missing binary or a total failure on both paths → 502 so the app shows
// "Trailer unavailable" rather than a dead player.
tmdb.get('/trailer', async (c) => {
  const key = c.req.query('key') ?? ''
  if (!isValidYouTubeId(key)) {
    return c.json({ error: 'invalid_key' }, 400)
  }

  // ── 1. Try the native Rust resolver ──────────────────────────────────────
  try {
    const resolved = await getOrFetchResolved(key)

    // 1a. Ready-made HLS manifest (AVPlayer / hls.js plays it natively).
    if (resolved.hls) {
      return c.json({ url: resolved.hls })
    }

    // 1b. Progressive muxed mp4 (single file, no manifest needed).
    if (resolved.progressive) {
      return c.json({ url: resolved.progressive })
    }

    // 1c. Adaptive-only (split video + audio): mux into one faststart mp4 we
    // serve ourselves, then hand AVPlayer a tokenised URL to it. On any mux
    // failure (range/ffmpeg), fall through to yt-dlp.
    if (resolved.video && resolved.audio) {
      try {
        await ensureMuxedTrailer(key, resolved)
        const session = c.get('session')
        const token = signMediaToken({
          sub: session.sub,
          rid: mediaResourceId('trailer', key),
          kind: MEDIA_DIRECT_KIND,
        })
        return c.json({
          url: `${publicBaseUrl(c)}/api/tmdb/trailer/${key}/stream.mp4?t=${token}`,
        })
      } catch {
        // Mux failed — fall through to yt-dlp.
      }
    }
  } catch {
    // Binary absent or YouTube-side rejection — fall through to yt-dlp.
  }

  // ── 2. yt-dlp fallback ───────────────────────────────────────────────────
  const url = await resolveTrailerUrl(key)
  if (!url) {
    return c.json({ error: 'trailer_unavailable' }, 502)
  }
  return c.json({ url })
})

// Serve a muxed adaptive trailer (services/ytmux.ts). Authed by the `?t=` token
// in trailerStreamAuth above (cookieless, so AVPlayer can fetch it). Supports
// Range so AVPlayer can seek; the file is faststart so playback starts early.
tmdb.get('/trailer/:key/stream.mp4', async (c) => {
  const key = c.req.param('key')
  if (!isValidYouTubeId(key)) return c.json({ error: 'invalid_key' }, 400)

  const path = muxedTrailerPath(key)
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    // Evicted/expired between the /trailer call and playback — the app re-taps.
    return c.json({ error: 'trailer_not_ready' }, 404)
  }

  const baseHeaders: Record<string, string> = {
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
  }

  const range = c.req.header('range')
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (m && !(m[1] === '' && m[2] === '')) {
      let start: number
      let end: number
      if (m[1] === '') {
        // suffix range: bytes=-N → last N bytes
        start = Math.max(0, size - Number(m[2]))
        end = size - 1
      } else {
        start = Number(m[1])
        end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
      }
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
        return c.body(null, 416, { 'content-range': `bytes */${size}` })
      }
      const webStream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream
      return c.body(webStream, 206, {
        ...baseHeaders,
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': String(end - start + 1),
      })
    }
  }

  const webStream = Readable.toWeb(createReadStream(path)) as ReadableStream
  return c.body(webStream, 200, { ...baseHeaders, 'content-length': String(size) })
})

