import { Hono } from 'hono'
import { requireAuth, type Env } from '../middleware/auth.js'
import { env } from '../env.js'
import { fetchStreamWithConnectTimeout, LAN_TIMEOUT_MS } from '../services/upstream.js'
import { mintInternalPrincipal } from '../services/internalPrincipal.js'
import { recommenderCallerFromSession } from '../services/recommenderCaller.js'

export const media = new Hono<Env>()

media.use('*', requireAuth)

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
] as const

media.all('/*', async (c) => {
  const session = c.get('session')
  const url = new URL(c.req.url)
  const subpath = url.pathname.replace(/^\/api\/media/, '') || '/'
  const query = url.search
  const upstream = `${env.mediaCoreUrl}/api/media${subpath}${query}`

  const headers: Record<string, string> = {}

  const caller = recommenderCallerFromSession(session)
  if (caller && env.internalPrincipalSecret) {
    // A caller and a secret are present → we are not in off posture. The
    // internal-principal MUST be minted; if minting fails we fail closed with
    // a 502 rather than silently proxying an unauthenticated (anonymous) write.
    try {
      headers['authorization'] = `Bearer ${mintInternalPrincipal(caller)}`
    } catch (e) {
      console.error('[media] failed to mint internal-principal, failing closed:', e)
      return c.json({ error: 'internal-principal mint failed' }, 502)
    }
  }

  // Forward range / conditional headers so seeking works on /stream.
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

  // Stream the upstream body straight through. LAN_TIMEOUT_MS bounds only
  // time-to-first-byte here (media-core answering with headers), NOT the body
  // transfer — a direct-play of a multi-GB file must neither be buffered into
  // heap nor truncated by a body deadline.
  const r = await fetchStreamWithConnectTimeout(
    upstream,
    { method, headers, ...(hasBody && body !== undefined ? { body } : {}) },
    LAN_TIMEOUT_MS,
    'media-core',
  )

  // Copy through the relevant upstream headers, preserving the upstream status
  // (including 206 Partial Content and 304 Not Modified) so HTTP range/seeking
  // is not silently broken.
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
