import { Hono } from 'hono'
import { requireAuth, type Env } from '../middleware/auth.js'
import { env } from '../env.js'
import { fetchWithTimeout, LAN_TIMEOUT_MS } from '../services/upstream.js'
import { mintInternalPrincipal } from '../services/internalPrincipal.js'
import { recommenderCallerFromSession } from '../services/recommenderCaller.js'

export const media = new Hono<Env>()

media.use('*', requireAuth)

media.all('/*', async (c) => {
  const session = c.get('session')
  const url = new URL(c.req.url)
  const subpath = url.pathname.replace(/^\/api\/media/, '') || '/'
  const query = url.search
  const upstream = `${env.mediaCoreUrl}/api/media${subpath}${query}`

  const headers: Record<string, string> = {}

  const caller = recommenderCallerFromSession(session)
  if (caller && env.internalPrincipalSecret) {
    try {
      headers['authorization'] = `Bearer ${mintInternalPrincipal(caller)}`
    } catch (e) {
      console.warn('[media] failed to mint internal-principal:', e)
    }
  }

  const method = c.req.method
  const hasBody = method !== 'GET' && method !== 'HEAD'
  let body: ArrayBuffer | undefined
  if (hasBody) {
    body = await c.req.arrayBuffer()
    const ct = c.req.header('content-type')
    if (ct) headers['content-type'] = ct
  }

  const r = await fetchWithTimeout(
    upstream,
    { method, headers, ...(hasBody && body !== undefined ? { body } : {}) },
    LAN_TIMEOUT_MS,
    'media-core',
  )

  return new Response(r.body, {
    status: r.status,
    headers: { 'Content-Type': r.headers.get('Content-Type') ?? 'application/octet-stream' },
  })
})
