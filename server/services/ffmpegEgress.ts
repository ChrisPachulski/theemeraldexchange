// SSRF containment for ffmpeg's network inputs (live remux, feed fingerprint,
// DVR). ffmpeg follows any redirect the provider answers with, and its protocol
// whitelist cannot say "public addresses only", so a 302 to an internal service
// was dialled and, for the remux, streamed back to the viewer. ffmpeg therefore
// dials through this loopback proxy (`-http_proxy`): each hop, including every
// redirect, is a new proxy request, allowed only for the operator's provider
// host (trusted, like guardedFetchTrustedOrigin) or a host that is public and
// resolves public. Plain http arrives as absolute-URI requests, https as CONNECT
// tunnels. Closing either side closes the other, so no provider socket outlives
// the ffmpeg that opened it.

import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { env } from '../env.js'
import { assertResolvesPublic, isPublicUpstream } from './ssrfGuard.js'
import { createLogger } from './logger.js'

const log = createLogger('ffmpeg-egress')

function trustedHost(): string | null {
  try {
    return new URL(env.XTREAM_HOST).host
  } catch {
    return null
  }
}

async function allowed(url: URL): Promise<boolean> {
  if (url.host === trustedHost()) return true
  if (!isPublicUpstream(url)) return false
  try {
    await assertResolvesPublic(url.hostname)
    return true
  } catch {
    return false
  }
}

function pairClose(a: net.Socket, b: net.Socket): void {
  const close = () => {
    a.destroy()
    b.destroy()
  }
  for (const s of [a, b]) {
    s.on('error', close)
    s.on('close', close)
  }
}

const server = http.createServer(async (req, res) => {
  let url: URL
  try {
    url = new URL(req.url ?? '')
  } catch {
    res.writeHead(400).end()
    return
  }
  if (url.protocol !== 'http:' || !(await allowed(url))) {
    log.warn('blocked ffmpeg egress', { host: url.host })
    res.writeHead(403).end()
    return
  }
  const headers = { ...req.headers }
  delete headers['proxy-connection']
  delete headers['proxy-authorization']
  const upstream = http.request(url, { method: req.method, headers }, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.headers)
    upRes.pipe(res)
  })
  upstream.on('error', () => res.destroy())
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
})

server.on('connect', async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
  let target: URL
  try {
    target = new URL(`https://${req.url ?? ''}`)
  } catch {
    client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    return
  }
  if (!(await allowed(target))) {
    log.warn('blocked ffmpeg egress', { host: target.host })
    client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    return
  }
  const upstream = net.connect(Number(target.port || 443), target.hostname, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) upstream.write(head)
    upstream.pipe(client)
    client.pipe(upstream)
  })
  pairClose(client, upstream)
})

server.on('error', (err) => log.error('ffmpeg egress proxy failed', { err }))
server.listen(0, '127.0.0.1')
server.unref()

/** Protocols an ffmpeg network input needs when it dials through the proxy. */
export const FFMPEG_PROXIED_PROTOCOLS = 'http,https,tcp,tls,crypto,httpproxy'

/**
 * `-http_proxy` args routing an ffmpeg network input through the proxy, or
 * null in the moment before it is listening (callers treat that like a busy
 * upstream: a transient refusal the next attempt clears).
 */
export function ffmpegProxyArgs(): string[] | null {
  const addr = server.address() as AddressInfo | null
  return addr ? ['-http_proxy', `http://127.0.0.1:${addr.port}`] : null
}

/** Resolves once the proxy is listening (tests, boot). */
export function ffmpegEgressReady(): Promise<void> {
  return server.listening ? Promise.resolve() : new Promise((ok) => server.once('listening', () => ok()))
}
