import { Hono, type Context, type Next } from 'hono'
import { requireAuth, type Env } from '../middleware/auth.js'
import { env } from '../env.js'
import { fetchStreamWithConnectTimeout, fetchWithTimeout, LAN_TIMEOUT_MS } from '../services/upstream.js'
import { mintInternalPrincipal } from '../services/internalPrincipal.js'
import { recommenderCallerFromSession } from '../services/recommenderCaller.js'
import type { Session } from '../session.js'
import {
  signMediaToken,
  verifyMediaToken,
  mediaResourceId,
  mediaSessionResourceId,
  MEDIA_DIRECT_KIND,
  MEDIA_HLS_KIND,
} from '../services/mediaStreamToken.js'
import { memberStatus } from '../services/membership.js'

export const media = new Hono<Env>()

// Inbound request headers forwarded verbatim to media-core so range/seeking
// and conditional requests work end-to-end through the proxy.
const FORWARD_REQUEST_HEADERS = [
  'range',
  'if-range',
  'if-none-match',
  'if-modified-since',
] as const

// Upstream response headers copied back to the caller so byte-range streaming
// (206 Partial Content), seeking, caching and revalidation are preserved.
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'accept-ranges',
  'content-range',
  'etag',
  'last-modified',
  'cache-control',
  // cloudflared buffers tunnel responses by default; the origin's
  // X-Accel-Buffering: no opt-out must survive this proxy hop or segments/
  // range responses are edge-accumulated before the player sees byte one.
  'x-accel-buffering',
] as const

// Browser playback caps when the SPA does not advertise its own. The capability
// gate only checks container/codec/height/HDR (not audio), so this conservative
// set direct-plays the canonical web-safe profile (mp4 + h264) and routes
// everything else (mkv, hevc, hdr) to the transcoder rather than risk shipping
// an undecodable container to a <video> element.
type Caps = {
  containers: string[]
  video_codecs: string[]
  max_height?: number
  hdr: boolean
  /** Audio codecs the client can decode (default browser-safe AAC-only). */
  audio_codecs: string[]
  /** Max AAC channels the client's MSE path can append (Chrome/Firefox: 2). */
  aac_max_channels: number
  /** Client's HLS player handles HEVC in fMP4 segments (enables HEVC copy-remux). */
  hls_fmp4_hevc: boolean
  /** Native HLS player (AVPlayer): opt into multi-audio muxing for in-band
   *  language switching. Browser/MSE clients omit it (single English track). */
  native_hls?: boolean
}
type PlaybackRequest = Partial<Caps> & { start_secs?: unknown; force_hls?: unknown }
const DEFAULT_CAPS: Caps = {
  containers: ['mp4'],
  video_codecs: ['h264'],
  max_height: 2160,
  hdr: false,
  audio_codecs: ['aac'],
  aac_max_channels: 2,
  hls_fmp4_hevc: false,
  native_hls: false,
}

function capsQuery(caps: Caps, startSecs?: number, forceTranscode = false): string {
  const p = new URLSearchParams()
  if (caps.containers.length) p.set('containers', caps.containers.join(','))
  if (caps.video_codecs.length) p.set('video_codecs', caps.video_codecs.join(','))
  if (typeof caps.max_height === 'number') p.set('max_height', String(caps.max_height))
  p.set('hdr', String(Boolean(caps.hdr)))
  if (caps.audio_codecs.length) p.set('audio_codecs', caps.audio_codecs.join(','))
  p.set('aac_max_channels', String(caps.aac_max_channels))
  p.set('hls_fmp4_hevc', String(Boolean(caps.hls_fmp4_hevc)))
  if (caps.native_hls) p.set('native_hls', 'true')
  if (startSecs !== undefined) p.set('start_secs', String(startSecs))
  if (forceTranscode) p.set('force_transcode', 'true')
  return p.toString()
}

/** A minimal session synthesised from a verified stream token's `sub` so the
 *  downstream internal-principal can be minted on the cookieless playback path.
 *  Playback never needs admin, so role is always 'user'. */
function sessionFromSub(sub: string): Session {
  // auth_mode is intentionally omitted: recommenderCallerFromSession re-derives
  // it from `sub`, so it never reads this field. Playback never needs admin.
  return { sub, username: '', role: 'user' }
}

/** Build the Authorization header for a media-core call from a session, or
 *  return {} in the off/no-secret posture. Throws on mint failure so the caller
 *  can fail closed. */
function principalHeader(session: Session): Record<string, string> {
  const caller = recommenderCallerFromSession(session)
  if (caller && env.internalPrincipalSecret) {
    return { authorization: `Bearer ${mintInternalPrincipal(caller)}` }
  }
  return {}
}

// Auth gate: `/stream/*` accepts a `?t=` stream token (so a cross-origin
// <video> can authenticate without a cookie) bound to the exact title; every
// other media subpath requires the session cookie/bearer.
async function mediaAuth(c: Context<Env>, next: Next) {
  const subpath = new URL(c.req.url).pathname.replace(/^\/api\/media/, '') || '/'
  const token = c.req.query('t')
  const streamMatch = subpath.match(/^\/stream\/([^/]+)\/([^/?]+)/)
  if (streamMatch && token) {
    const rid = mediaResourceId(streamMatch[1], streamMatch[2])
    const v = verifyMediaToken(token, { kinds: [MEDIA_DIRECT_KIND], rid })
    if (!v.ok) return c.json({ error: v.error }, 401)
    if (memberStatus(v.sub) !== 'allowed') return c.json({ error: 'access_revoked' }, 401)
    c.set('session', sessionFromSub(v.sub))
    return next()
  }
  return requireAuth(c, next)
}

media.use('*', mediaAuth)

// Playback grant. Cookie/bearer authed. Orchestrates the media-core capability
// grant and, when the file can't direct-play, starts a transcoder session —
// then returns a tokenised StreamGrant the SPA's <video>/hls.js player loads
// cross-origin. Mirrors the IPTV grant shape ({ delivery, url }).
media.post('/playback/:kind/:id', async (c) => {
  const session = c.get('session')
  const kind = c.req.param('kind')
  const id = c.req.param('id')
  if (kind !== 'movie' && kind !== 'episode') {
    return c.json({ error: 'unknown media kind' }, 400)
  }

  const reqCaps = await c.req.json<PlaybackRequest>().catch(() => ({}) as PlaybackRequest)
  const caps: Caps = {
    containers: reqCaps.containers?.length ? reqCaps.containers : DEFAULT_CAPS.containers,
    video_codecs: reqCaps.video_codecs?.length ? reqCaps.video_codecs : DEFAULT_CAPS.video_codecs,
    max_height: typeof reqCaps.max_height === 'number' ? reqCaps.max_height : DEFAULT_CAPS.max_height,
    hdr: Boolean(reqCaps.hdr),
    audio_codecs: reqCaps.audio_codecs?.length ? reqCaps.audio_codecs : DEFAULT_CAPS.audio_codecs,
    aac_max_channels:
      typeof reqCaps.aac_max_channels === 'number' && reqCaps.aac_max_channels >= 2
        ? Math.floor(reqCaps.aac_max_channels)
        : DEFAULT_CAPS.aac_max_channels,
    hls_fmp4_hevc: Boolean(reqCaps.hls_fmp4_hevc),
  }
  const startSecs =
    typeof reqCaps.start_secs === 'number' &&
    Number.isFinite(reqCaps.start_secs) &&
    reqCaps.start_secs > 0
      ? Math.floor(reqCaps.start_secs)
      : undefined
  // The client may demand buffered (HLS) delivery even for a direct-play-
  // eligible file — the player escalates when progressive playback stalls.
  // The transcoder resolves these to a lossless copy-remux session.
  const forceHls = Boolean(reqCaps.force_hls)

  let auth: Record<string, string>
  try {
    auth = principalHeader(session)
  } catch (e) {
    console.error('[media] playback grant: mint failed, failing closed:', e)
    return c.json({ error: 'principal_mint_failed' }, 502)
  }

  // 1. Capability decision (+ file metadata for duration). This is a small
  // JSON control-plane response, so it goes through fetchWithTimeout (whole-
  // transfer deadline + buffered body) — the streaming wrapper only bounds
  // TTFB, leaving the r.json() read below unbounded against a stalled
  // upstream. Only the actual media bytes (the catch-all proxy at the bottom)
  // belong on the streaming wrapper.
  let grant: { directPlay?: boolean; file?: { duration_secs?: number | null } }
  try {
    const r = await fetchWithTimeout(
      `${env.mediaCoreUrl}/api/media/play/${kind}/${id}/grant`,
      {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          containers: caps.containers,
          video_codecs: caps.video_codecs,
          max_height: caps.max_height,
          hdr: caps.hdr,
          audio_codecs: caps.audio_codecs,
          aac_max_channels: caps.aac_max_channels,
          hls_fmp4_hevc: caps.hls_fmp4_hevc,
        }),
      },
      LAN_TIMEOUT_MS,
      'media-core',
    )
    if (r.status === 404) return c.json({ error: 'not_found' }, 404)
    if (!r.ok) return c.json({ error: 'grant_failed' }, 502)
    grant = (await r.json()) as typeof grant
  } catch {
    return c.json({ error: 'media_core_unreachable' }, 502)
  }

  const durationSecs = grant.file?.duration_secs ?? null

  // 2a. Direct play → a vod token on the proxied stream URL. Skipped when the
  // client forced HLS: fall through to the stream handoff, which carries
  // force_transcode so media-core/transcoder bypass their direct-play paths.
  if (grant.directPlay && !forceHls) {
    const token = signMediaToken({
      sub: session.sub,
      rid: mediaResourceId(kind, id),
      kind: MEDIA_DIRECT_KIND,
    })
    return c.json({
      delivery: 'progressive',
      url: `/api/media/stream/${kind}/${id}?t=${token}`,
      durationSecs,
    })
  }

  // 2b. Transcode required → start a session (media-core hands off) and return
  // a remux token on the HLS manifest + heartbeat URLs. The transcode proxy
  // rewrites the manifest's segment lines to carry the same token.
  let handoff: {
    sessionId?: string
    manifestUrl?: string
    heartbeatUrl?: string
    subtitle?: { url: string; language?: string | null; forced?: boolean } | null
  }
  try {
    // Small JSON handoff — whole-transfer deadline, same as the grant above.
    const r = await fetchWithTimeout(
      `${env.mediaCoreUrl}/api/media/stream/${kind}/${id}?${capsQuery(caps, startSecs, forceHls)}`,
      { method: 'GET', headers: auth },
      LAN_TIMEOUT_MS,
      'media-core',
    )
    if (r.status === 503) return c.json({ error: 'transcoder_unavailable' }, 503)
    if (!r.ok) return c.json({ error: 'transcode_start_failed' }, 502)
    handoff = (await r.json()) as typeof handoff
  } catch {
    return c.json({ error: 'transcoder_unreachable' }, 502)
  }

  const sid = handoff.sessionId
  if (!sid || !handoff.manifestUrl) {
    return c.json({ error: 'transcoder_unavailable' }, 503)
  }

  // Wait for the transcoder to produce its first segment before handing the
  // manifest URL to the client. ffmpeg needs a moment to emit seg_00000.ts, and
  // until then the manifest route returns 503. The browser player (hls.js)
  // fetches the manifest ONCE and does not retry a 503, so returning too early
  // leaves an empty <video> ("grey rectangle"). Poll the transcoder directly
  // (the internal principal is shared across services) until the manifest is
  // ready, capped so a stuck encode can't hang the request. The internal
  // principal Bearer in `auth` is accepted by the transcoder too.
  //
  // The cap is WALL-CLOCK, not iteration count: each probe can itself take up
  // to LAN_TIMEOUT_MS against a slow transcoder, so the previous
  // "24 polls × 500ms sleep" bound only capped the sleeps — a transcoder that
  // answered slowly (but under its own timeout) stretched the loop from the
  // intended 12s toward minutes while the SPA's grant request hung.
  const manifestProbe = `${env.transcoderUrl}${handoff.manifestUrl}`
  const READY_DEADLINE_MS = 12_000
  const readyDeadline = Date.now() + READY_DEADLINE_MS
  while (Date.now() < readyDeadline) {
    try {
      // The manifest is a small text playlist — whole-transfer deadline so
      // the m.text() read below can't pin the poll loop on a stalled socket.
      const m = await fetchWithTimeout(
        manifestProbe,
        { method: 'GET', headers: auth },
        LAN_TIMEOUT_MS,
        'transcoder',
      )
      if (m.ok) {
        const body = await m.text()
        // `.ts` for MPEG-TS sessions, `.m4s` for fMP4 (HEVC copy) sessions.
        if (/\.(?:ts|m4s)(\?|\s|$)/m.test(body)) break // a segment is listed → ready
      }
    } catch {
      // transient — keep polling until the deadline
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  const token = signMediaToken({
    sub: session.sub,
    rid: mediaSessionResourceId(sid),
    kind: MEDIA_HLS_KIND,
  })
  const withToken = (u: string) => `${u}${u.includes('?') ? '&' : '?'}t=${token}`
  // Derive the stop URL from the manifest path so it tracks any prefix change.
  // The same session token authorizes it (transcodeAuth accepts a remux token
  // bound to media:session:<sid> on every /session/<sid>/* route). The client
  // POSTs this on player close so the transcoder frees its concurrency permit
  // immediately instead of pinning the (CPU-only → single) slot until the 30s
  // idle reaper runs — which otherwise 503s the next title the user opens.
  const stopPath = handoff.manifestUrl.replace(/\/index\.m3u8$/, '/stop')
  // Sidecar subtitle (transcode path only): the transcoder pre-extracts a
  // complete subtitles.vtt and media-core forwards its descriptor. The asset
  // is served by the same owner-bound /session/<id>/* route as the segments,
  // so it carries the SAME stream token; the player loads it as a <track>.
  const subtitle =
    handoff.subtitle && handoff.subtitle.url
      ? {
          url: withToken(handoff.subtitle.url),
          language: handoff.subtitle.language ?? null,
          forced: handoff.subtitle.forced ?? false,
        }
      : null
  return c.json({
    delivery: 'hls',
    url: withToken(handoff.manifestUrl),
    heartbeatUrl: handoff.heartbeatUrl ? withToken(handoff.heartbeatUrl) : null,
    stopUrl: withToken(stopPath),
    sessionId: sid,
    durationSecs,
    subtitle,
  })
})

// Catch-all proxy to media-core for the JSON/metadata routes and the direct
// `/stream` bytes. Auth was settled by mediaAuth above; here we only forward.
media.all('/*', async (c) => {
  const session = c.get('session')
  const url = new URL(c.req.url)
  const subpath = url.pathname.replace(/^\/api\/media/, '') || '/'
  // Strip the playback `?t=` token before forwarding — media-core authenticates
  // via the internal principal, not the stream token.
  const params = new URLSearchParams(url.search)
  params.delete('t')
  const query = params.toString() ? `?${params.toString()}` : ''
  const upstream = `${env.mediaCoreUrl}/api/media${subpath}${query}`

  let headers: Record<string, string>
  try {
    headers = principalHeader(session)
  } catch (e) {
    console.error('[media] failed to mint internal-principal, failing closed:', e)
    return c.json({ error: 'principal_mint_failed' }, 502)
  }

  for (const name of FORWARD_REQUEST_HEADERS) {
    const v = c.req.header(name)
    if (v) headers[name] = v
  }

  const method = c.req.method
  const hasBody = method !== 'GET' && method !== 'HEAD'
  let body: ArrayBuffer | undefined
  if (hasBody) {
    body = await c.req.arrayBuffer()
    const ct = c.req.header('content-type')
    if (ct) headers['content-type'] = ct
  }

  const r = await fetchStreamWithConnectTimeout(
    upstream,
    { method, headers, ...(hasBody && body !== undefined ? { body } : {}) },
    LAN_TIMEOUT_MS,
    'media-core',
  )

  const outHeaders = new Headers()
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const v = r.headers.get(name)
    if (v !== null) outHeaders.set(name, v)
  }
  if (!outHeaders.has('content-type')) {
    outHeaders.set('content-type', 'application/octet-stream')
  }

  return new Response(r.body, {
    status: r.status,
    statusText: r.statusText,
    headers: outHeaders,
  })
})
