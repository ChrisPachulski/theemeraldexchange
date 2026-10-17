// 2026-10-16 review item 14: ffmpeg's network inputs followed provider
// redirects into internal services. They now dial through this proxy; it must
// pass the operator's provider host and refuse internal hosts on both its
// plain-http and CONNECT paths.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, request, type Server } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { env } from '../env.js'
import { ffmpegEgressReady, ffmpegProxyArgs } from './ffmpegEgress.js'

let provider: Server
let internal: Server
let internalHits = 0
const port = (s: Server) => (s.address() as AddressInfo).port
const proxyPort = () => Number(new URL(ffmpegProxyArgs()![1]).port)

beforeAll(async () => {
  const listen = (s: Server) => new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok))
  provider = createServer((_req, res) => res.end('stream'))
  internal = createServer((_req, res) => {
    internalHits += 1
    res.end('secret')
  })
  await Promise.all([listen(provider), listen(internal), ffmpegEgressReady()])
  ;(env as Record<string, unknown>).XTREAM_HOST = `http://127.0.0.1:${port(provider)}`
})
afterAll(() => {
  provider.close()
  internal.close()
})

const viaProxy = (url: string): Promise<{ status: number; body: string }> =>
  new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port: proxyPort(), path: url, headers: { host: new URL(url).host } }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => ok({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', fail)
    req.end()
  })

const connectVia = (target: string): Promise<string> =>
  new Promise((ok, fail) => {
    const s = connect(proxyPort(), '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`))
    s.once('data', (d) => {
      ok(d.toString().split('\r\n')[0])
      s.destroy()
    })
    s.on('error', fail)
  })

describe('ffmpeg egress proxy', () => {
  it('passes the configured provider host', async () => {
    expect(await viaProxy(`http://127.0.0.1:${port(provider)}/live/u/p/1.ts`)).toEqual({ status: 200, body: 'stream' })
  })

  it('refuses an internal host (a redirect target) on the plain-http path', async () => {
    expect((await viaProxy(`http://127.0.0.1:${port(internal)}/internal`)).status).toBe(403)
    expect(internalHits).toBe(0)
  })

  it('refuses a CONNECT tunnel to an internal host', async () => {
    expect(await connectVia(`127.0.0.1:${port(internal)}`)).toBe('HTTP/1.1 403 Forbidden')
    expect(await connectVia('recommender:8000')).toBe('HTTP/1.1 403 Forbidden')
  })
})
