// 2026-10-16 review item 14: the IPTV availability probe went through
// fetchWithTimeout, whose fetch follows redirects, so a panel 302 to an
// internal address was dialled. Real fetch + ssrfGuard against two loopback
// servers: the panel (trusted, operator-configured) and an "internal" service.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const envState = vi.hoisted(() => ({ XTREAM_HOST: '', XTREAM_USERNAME: 'u', XTREAM_PASSWORD: 'p', plexServerUrl: '' }))
vi.mock('../env.js', () => ({ env: envState }))

import { resolveSourcePrecedence } from './sourcePrecedence.js'

let internalHits = 0
const servers: Server[] = []
const listen = (handler: Parameters<typeof createServer>[1]): Promise<number> =>
  new Promise((ok) => {
    const s = createServer(handler).listen(0, '127.0.0.1', () => ok((s.address() as AddressInfo).port))
    servers.push(s)
  })

beforeAll(async () => {
  const internal = await listen((_req, res) => {
    internalHits += 1
    res.end('{}')
  })
  const panel = await listen((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${internal}/internal` }).end()
  })
  envState.XTREAM_HOST = `http://127.0.0.1:${panel}`
})
afterAll(() => {
  for (const s of servers) s.close()
})

describe('IPTV availability probe SSRF containment', () => {
  it('never follows a panel redirect into an internal address', async () => {
    const result = await resolveSourcePrecedence({ kind: 'live', id: '1' })
    expect(result.resolved).toBeNull()
    expect(internalHits).toBe(0)
  })
})
