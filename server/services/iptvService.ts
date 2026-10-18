// The iptv service (crates/iptv) owns iptv.db and is the only process that
// dials the IPTV provider. Hono keeps the auth, live-section, rating and
// membership gates (routes/iptv.ts, routes/dvr.ts) and forwards here with a
// 60 s internal principal, the way routes/media.ts reaches media-core.

import type { Context } from 'hono'
import type { Env } from '../middleware/auth.js'
import type { Session } from '../session.js'
import { env } from '../env.js'
import { mintInternalPrincipal } from './internalPrincipal.js'
import { recommenderCallerFromSession } from './recommenderCaller.js'
import { verifyStreamToken } from './iptvStreamToken.js'
import { memberStatus } from './membership.js'
import { parseSub } from './sub.js'
import { requireSection } from './userPolicies.js'
import { createLogger } from './logger.js'

const log = createLogger('iptv')

// Range for seeking, Accept-Encoding for the gzipped guide, the client IP pair
// for the sessions widget.
const FORWARD_REQUEST_HEADERS = [
  'range',
  'if-range',
  'accept-encoding',
  'content-type',
  'cf-connecting-ip',
  'x-forwarded-for',
] as const

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
])

// Bounds the wait for response headers only; a byte stream then runs for as
// long as the viewer watches. A live grant can sit behind the 15 s panel probe
// and a raw live tune behind the upstream drain wait, so this is wider than
// the 15 s LAN budget media.ts uses.
const IPTV_TTFB_TIMEOUT_MS = 60_000
const INTERNAL_TIMEOUT_MS = 10_000

/** A session for a verified stream token's sub (cookieless ?t= routes). */
export function sessionFromSub(sub: string, role: Session['role'] = 'user'): Session {
  return { sub, username: '', role }
}

/** Authorization for one iptv-service call, or {} in the no-secret dev
 *  posture. Throws on mint failure so the caller fails closed. */
function principalHeader(session: Session, requestId?: string): Record<string, string> {
  const caller = recommenderCallerFromSession(session, requestId)
  if (caller && env.internalPrincipalSecret) {
    return { authorization: `Bearer ${mintInternalPrincipal(caller)}` }
  }
  return {}
}

/** requireSection('live') as a check, for gates composed in one handler. */
export async function liveSectionDenied(c: Context<Env>): Promise<Response | null> {
  let allowed = false
  const denied = await requireSection('live')(c, async () => {
    allowed = true
  })
  return allowed ? null : (denied ?? c.json({ error: 'section_blocked' }, 403))
}

/**
 * Hono's half of a ?t= / ?u= stream token: signature, time window and the
 * holder's membership, re-checked on every request so a revocation reaches an
 * already-minted grant. The iptv service re-verifies kind and resource.
 * Returns the canonical sub, or the 401 to send.
 */
export function verifyStreamTokenMember(c: Context<Env>, token: string): string | Response {
  let tokenSub: string
  try {
    tokenSub = verifyStreamToken(env.streamTokenSecret, token).sub
  } catch (err) {
    return c.json({ error: 'invalid_token', detail: err instanceof Error ? err.message : String(err) }, 401)
  }
  let sub: string
  try {
    sub = parseSub(tokenSub).raw
  } catch {
    return c.json({ error: 'invalid_token', detail: 'sub_invalid_format' }, 401)
  }
  if (memberStatus(sub) !== 'allowed') return c.json({ error: 'access_revoked' }, 401)
  return sub
}

/** Forward the request as-is (path, query, body) under `session`'s principal
 *  and stream the response back. */
export async function forwardToIptv(c: Context<Env>, session: Session): Promise<Response> {
  let headers: Record<string, string>
  try {
    headers = principalHeader(session, c.get('requestId'))
  } catch (e) {
    log.error('failed to mint internal-principal, failing closed', { err: e })
    return c.json({ error: 'principal_mint_failed' }, 502)
  }
  for (const name of FORWARD_REQUEST_HEADERS) {
    const v = c.req.header(name)
    if (v) headers[name] = v
  }
  // Playlist URLs are minted against the public origin the client used.
  const url = new URL(c.req.url)
  headers['x-forwarded-proto'] = c.req.header('x-forwarded-proto') ?? url.protocol.slice(0, -1)
  headers['x-forwarded-host'] = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? url.host

  const method = c.req.method
  const body = method === 'GET' || method === 'HEAD' ? undefined : await c.req.arrayBuffer()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), IPTV_TTFB_TIMEOUT_MS)
  // A viewer who leaves closes our upstream socket, which is how the iptv
  // service learns to release the concurrency slot and the provider stream.
  c.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true })
  let r: Response
  try {
    r = await fetch(`${env.iptvServiceUrl}${url.pathname}${url.search}`, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: controller.signal,
    })
  } catch (err) {
    const reason = (err as { name?: string }).name === 'AbortError' ? 'upstream_timeout' : 'upstream_unreachable'
    log.error(`iptv ${reason}: ${err instanceof Error ? err.message : String(err)}`)
    return c.json({ error: reason, service: 'iptv' }, 504)
  } finally {
    clearTimeout(timer)
  }

  const out = new Headers()
  r.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name)) out.set(name, value)
  })
  let stream = r.body
  // fetch inflates a gzipped body but keeps Content-Encoding; gzip it again so
  // the header stays true (the guide grid is ~12x smaller compressed).
  if (stream && out.has('content-encoding')) {
    out.delete('content-length')
    stream = stream.pipeThrough(new CompressionStream('gzip'))
  }
  return new Response(stream, { status: r.status, statusText: r.statusText, headers: out })
}

/** Call an iptv `/internal/*` endpoint. These are Hono-only (the service
 *  answers them for an admin principal), so Hono mints one for `sub`. */
async function iptvInternal(method: 'POST' | 'DELETE', path: string, sub: string, body?: unknown, timeoutMs = INTERNAL_TIMEOUT_MS): Promise<unknown> {
  const headers = principalHeader(sessionFromSub(sub, 'admin'))
  if (body !== undefined) headers['content-type'] = 'application/json'
  const r = await fetch(`${env.iptvServiceUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  // No path in the message: it carries the member sub, and this lands in logs.
  if (!r.ok) throw new Error(`iptv internal ${method} answered ${r.status}`)
  return r.json()
}

/** Revoke every playlist token `sub` holds (membership revoked). */
export async function revokeIptvPlaylistTokens(sub: string): Promise<void> {
  if (env.IPTV_DISABLED) return
  await iptvInternal('POST', `/internal/members/${encodeURIComponent(sub)}/revoke-playlist-tokens`, sub)
}

/** Revoke `sub`'s playlist tokens and delete their favorites and watch
 *  history, in one transaction on the iptv side (account deletion). */
export async function eraseIptvMember(sub: string): Promise<void> {
  if (env.IPTV_DISABLED) return
  await iptvInternal('DELETE', `/internal/members/${encodeURIComponent(sub)}`, sub)
}

/** Which of these TMDB ids a live IPTV catalog title links to. */
export async function iptvLinkedTmdbIds(sub: string, ids: number[], timeoutMs: number): Promise<number[]> {
  if (env.IPTV_DISABLED || ids.length === 0) return []
  const body = (await iptvInternal('POST', '/internal/availability', sub, { tmdb_ids: ids }, timeoutMs)) as { tmdb_ids?: unknown }
  return Array.isArray(body.tmdb_ids) ? body.tmdb_ids.filter((id): id is number => typeof id === 'number') : []
}
