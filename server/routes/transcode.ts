import { Hono, type Context, type Next } from 'hono'
import { requireAuth, type Env } from '../middleware/auth.js'
import { env } from '../env.js'
import { fetchStreamWithConnectTimeout, LAN_TIMEOUT_MS } from '../services/upstream.js'
import { mintInternalPrincipal } from '../services/internalPrincipal.js'
import { recommenderCallerFromSession } from '../services/recommenderCaller.js'
import type { Session } from '../session.js'
import {
  verifyMediaToken,
  mediaSessionResourceId,
  MEDIA_HLS_KIND,
} from '../services/mediaStreamToken.js'
import { memberStatus } from '../services/membership.js'

// Authenticated proxy for the transcoder's HLS surface. When a library file
// cannot direct-play, media-core's /playback grant routes the client to an HLS
// session whose manifest/segment URLs live under /api/transcode/* on the
// transcoder. The browser can only reach the backend, so this proxy forwards
// those requests (minting the internal-principal the transcoder enforces) and
// streams the manifest (.m3u8) + segments (.ts) straight back.
//
// Like routes/media.ts, it accepts a `?t=` stream token (bound to the session)
// so a cross-origin <video>/hls.js can authenticate without a cookie.
export const transcode = new Hono<Env>()

// Inbound request headers forwarded verbatim so range/seeking on .ts segments
// and conditional revalidation of the manifest work end-to-end.
const FORWARD_REQUEST_HEADERS = [
  'range',
  'if-range',
  'if-none-match',
  'if-modified-since',
] as const

// Upstream response headers copied back so byte-range streaming (206),
// seeking, caching and revalidation are preserved through the proxy.
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'accept-ranges',
  'content-range',
  'etag',
  'last-modified',
  'cache-control',
] as const

function sessionFromSub(sub: string): Session {
  // auth_mode omitted: recommenderCallerFromSession re-derives it from `sub`.
  return { sub, username: '', role: 'user' }
}

// Token-or-cookie auth. A `?t=` token must be a remux-kind media token bound to
// the session id in the path (`media:session:<sid>`); otherwise fall back to
// the session cookie/bearer (e.g. the GET /sessions admin/list path, which has
// no per-session token). BOTH branches set `session`, and the catch-all proxy
// below mints the internal principal (sub + role) from that session on every
// forwarded request — the transcoder's owner-binding (stop/seek/heartbeat
// enforcement, non-admin sessions filtering) depends on the principal being
// present on ALL proxied paths, not just /session/* ones.
async function transcodeAuth(c: Context<Env>, next: Next) {
  const subpath = new URL(c.req.url).pathname.replace(/^\/api\/transcode/, '') || '/'
  const token = c.req.query('t')
  const sessMatch = subpath.match(/^\/session\/([^/?]+)/)
  if (token && sessMatch) {
    const rid = mediaSessionResourceId(sessMatch[1])
    const v = verifyMediaToken(token, { kinds: [MEDIA_HLS_KIND], rid })
    if (!v.ok) return c.json({ error: v.error }, 401)
    if (memberStatus(v.sub) !== 'allowed') return c.json({ error: 'access_revoked' }, 401)
    c.set('session', sessionFromSub(v.sub))
    return next()
  }
  return requireAuth(c, next)
}

transcode.use('*', transcodeAuth)

transcode.all('/*', async (c) => {
  const session = c.get('session')
  const url = new URL(c.req.url)
  const subpath = url.pathname.replace(/^\/api\/transcode/, '') || '/'
  const token = url.searchParams.get('t')
  // Forward the original query MINUS our `?t=` (the transcoder authenticates via
  // the internal principal, not the stream token).
  const params = new URLSearchParams(url.search)
  params.delete('t')
  const query = params.toString() ? `?${params.toString()}` : ''
  const upstream = `${env.transcoderUrl}/api/transcode${subpath}${query}`

  const headers: Record<string, string> = {}

  const caller = recommenderCallerFromSession(session)
  if (caller && env.internalPrincipalSecret) {
    // A caller and a secret are present → we are not in off posture. The
    // internal-principal MUST be minted; if minting fails we fail closed with
    // a 502 rather than silently proxying an unauthenticated request that the
    // transcoder (enforce mode) would reject anyway.
    try {
      headers['authorization'] = `Bearer ${mintInternalPrincipal(caller)}`
    } catch (e) {
      console.error('[transcode] failed to mint internal-principal, failing closed:', e)
      return c.json({ error: 'internal-principal mint failed' }, 502)
    }
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
    'transcoder',
  )

  const outHeaders = new Headers()
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const v = r.headers.get(name)
    if (v !== null) outHeaders.set(name, v)
  }
  if (!outHeaders.has('content-type')) {
    outHeaders.set('content-type', 'application/octet-stream')
  }

  // HLS manifest rewrite: hls.js resolves segment URIs relative to the manifest
  // URL and DROPS its query string, so the `?t=` token would be lost on every
  // segment fetch. Buffer the (small) manifest and append the same token to each
  // segment line so the proxy can re-authenticate them. Only .m3u8 is buffered;
  // .ts segments stream straight through.
  if (token && r.ok && subpath.endsWith('.m3u8')) {
    const text = await r.text()
    const rewritten = appendTokenToManifest(text, token)
    outHeaders.delete('content-length')
    return new Response(rewritten, {
      status: r.status,
      statusText: r.statusText,
      headers: outHeaders,
    })
  }

  return new Response(r.body, {
    status: r.status,
    statusText: r.statusText,
    headers: outHeaders,
  })
})

/** Append `?t=<token>` to each segment/variant URI line in an HLS manifest.
 *  Comment/tag lines (`#…`), blank lines, and absolute URLs are left untouched;
 *  the transcoder emits relative segment names (`seg_00000.ts`) with no query,
 *  so a plain `?t=` is always correct. Exported for unit testing. */
export function appendTokenToManifest(manifest: string, token: string): string {
  return manifest
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) return line
      if (/^https?:\/\//i.test(trimmed)) return line
      const sep = trimmed.includes('?') ? '&' : '?'
      return `${trimmed}${sep}t=${token}`
    })
    .join('\n')
}
