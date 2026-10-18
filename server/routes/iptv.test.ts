// The /api/iptv and /api/dvr proxies against a local stub iptv service: one
// route of each gate class (session, ?t= bytes with Range, playlist.m3u, dvr
// play), plus the gzip pass-through. Auth and membership are stubbed; the
// policy store, stream tokens, principal minting and the forward are real.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { Hono } from 'hono'
import type { Session } from '../session.js'

const state = vi.hoisted(() => ({
  session: null as Session | null,
  member: 'allowed' as 'allowed' | 'revoked' | 'not_member',
}))

vi.mock('../middleware/auth.js', () => {
  const gate = (adminOnly: boolean) => async (c: { set: (k: string, v: unknown) => void; json: (b: unknown, s: number) => Response }, next: () => Promise<void>) => {
    if (!state.session) return c.json({ error: 'unauthenticated' }, 401)
    if (adminOnly && state.session.role !== 'admin') return c.json({ error: 'forbidden', reason: 'admin_only' }, 403)
    c.set('session', state.session)
    await next()
  }
  return { requireAuth: gate(false), requireAdmin: gate(true) }
})
vi.mock('../services/membership.js', () => ({ memberStatus: () => state.member }))

const { startIptvStub } = await import('../test/iptvStub.js')
const { iptv } = await import('./iptv.js')
const { dvr } = await import('./dvr.js')
const { signStreamToken } = await import('../services/iptvStreamToken.js')
const { setPolicy, defaultPolicy, _setUserPoliciesPathForTests } = await import('../services/userPolicies.js')
const { env } = await import('../env.js')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eex-iptv-proxy-'))
_setUserPoliciesPathForTests(path.join(tmpDir, 'policies.json'))
const stub = await startIptvStub()
const app = new Hono()
app.route('/api/iptv', iptv)
app.route('/api/dvr', dvr)

const USER: Session = { sub: 'plex:5', username: 'viewer', role: 'user' }
const token = (kind: 'live' | 'playlist' | 'recording', rid: string, sub = USER.sub) =>
  signStreamToken(env.streamTokenSecret, { kind, resourceId: rid, sub, ttlSecs: 300 })
const calls = () => stub.calls.map((c) => `${c.method} ${c.url}`)

afterAll(async () => {
  await stub.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(async () => {
  stub.reset()
  state.session = USER
  state.member = 'allowed'
  await setPolicy(USER.sub, defaultPolicy())
})

describe('session routes', () => {
  it('forwards path, query and body under a principal with the public origin', async () => {
    stub.respond((_call, res) => {
      res.setHeader('content-type', 'application/json')
      res.end('{"categories":[]}')
    })
    const r = await app.request('/api/iptv/stream/live/10/grant?client=avplayer', {
      method: 'POST',
      headers: { host: 'api.example.test', 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.7', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ categories: [] })
    expect(calls()).toEqual(['POST /api/iptv/stream/live/10/grant?client=avplayer'])
    const h = stub.calls[0].headers
    expect(h.authorization).toMatch(/^Bearer /)
    expect(h['x-forwarded-host']).toBe('api.example.test')
    expect(h['x-forwarded-proto']).toBe('https')
    expect(h['cf-connecting-ip']).toBe('203.0.113.7')
    expect(stub.calls[0].body).toBe('{}')
  })

  it('401s without a session and never reaches the service', async () => {
    state.session = null
    expect((await app.request('/api/iptv/categories')).status).toBe(401)
    expect(calls()).toEqual([])
  })

  it('applies the live section, except on the caller\'s own sessions list', async () => {
    await setPolicy(USER.sub, { ...defaultPolicy(), allowedSections: { live: false, downloads: true, arr: true } })
    const denied = await app.request('/api/iptv/categories')
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'section_blocked' })
    expect((await app.request('/api/iptv/sessions')).status).toBe(200)
    expect(calls()).toEqual(['GET /api/iptv/sessions'])
  })

  it('a rating cap blocks grants and the playlist mint but not browsing', async () => {
    await setPolicy(USER.sub, { ...defaultPolicy(), kid: true })
    for (const p of ['/api/iptv/stream/live/10/grant', '/api/iptv/playlist/token']) {
      const r = await app.request(p, { method: 'POST' })
      expect(r.status).toBe(403)
      expect(await r.json()).toEqual({ error: 'rating_blocked' })
    }
    expect((await app.request('/api/iptv/categories')).status).toBe(200)
    expect(calls()).toEqual(['GET /api/iptv/categories'])
  })

  it('re-gzips a body fetch inflated, so Content-Encoding stays true', async () => {
    const json = JSON.stringify({ channels: Array.from({ length: 50 }, (_, i) => ({ id: i })) })
    stub.respond((_call, res) => {
      const gz = gzipSync(json)
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': gz.length })
      res.end(gz)
    })
    const r = await app.request('/api/iptv/epg/grid', { headers: { 'accept-encoding': 'gzip' } })
    expect(stub.calls[0].headers['accept-encoding']).toBe('gzip')
    expect(r.headers.get('content-encoding')).toBe('gzip')
    expect(r.headers.get('content-length')).toBeNull()
    expect(gunzipSync(Buffer.from(await r.arrayBuffer())).toString()).toBe(json)
  })

  it('answers 504 when the service is down', async () => {
    const live = env.iptvServiceUrl
    ;(env as { iptvServiceUrl: string }).iptvServiceUrl = 'http://127.0.0.1:1'
    try {
      const r = await app.request('/api/iptv/categories')
      expect(r.status).toBe(504)
      expect(await r.json()).toEqual({ error: 'upstream_unreachable', service: 'iptv' })
    } finally {
      ;(env as { iptvServiceUrl: string }).iptvServiceUrl = live
    }
  })
})

describe('?t= byte routes', () => {
  it('forwards Range and the token, and passes 206 + streaming headers back', async () => {
    stub.respond((_call, res) => {
      res.writeHead(206, { 'content-type': 'video/mp2t', 'content-range': 'bytes 0-3/100', 'x-accel-buffering': 'no' })
      res.end('abcd')
    })
    const t = token('live', '10')
    state.session = null // cookieless: the token is the credential
    const r = await app.request(`/api/iptv/stream/live/10.ts?t=${t}`, { headers: { range: 'bytes=0-3' } })
    expect(r.status).toBe(206)
    expect(await r.text()).toBe('abcd')
    expect(r.headers.get('content-range')).toBe('bytes 0-3/100')
    expect(r.headers.get('x-accel-buffering')).toBe('no')
    expect(calls()).toEqual([`GET /api/iptv/stream/live/10.ts?t=${t}`])
    expect(stub.calls[0].headers.range).toBe('bytes=0-3')
    expect(stub.calls[0].headers.authorization).toMatch(/^Bearer /)
  })

  it('refuses a revoked member and a forged token before forwarding', async () => {
    state.member = 'revoked'
    const revoked = await app.request(`/api/iptv/stream/live/10.ts?t=${token('live', '10')}`)
    expect(revoked.status).toBe(401)
    expect(await revoked.json()).toEqual({ error: 'access_revoked' })
    state.member = 'allowed'
    const forged = await app.request('/api/iptv/stream/segment?u=not-a-token')
    expect(forged.status).toBe(401)
    expect(((await forged.json()) as { error: string }).error).toBe('invalid_token')
    const bareSub = await app.request(`/api/iptv/stream/live/10.ts?t=${token('live', '10', '42')}`)
    expect(await bareSub.json()).toEqual({ error: 'invalid_token', detail: 'sub_invalid_format' })
    expect(calls()).toEqual([])
  })
})

describe('/playlist.m3u', () => {
  it('forwards for an allowed member with the section and no cap', async () => {
    state.session = null
    const t = token('playlist', 'iptv-channels-all')
    expect((await app.request(`/api/iptv/playlist.m3u?t=${t}`)).status).toBe(200)
    expect(calls()).toEqual([`GET /api/iptv/playlist.m3u?t=${t}`])
  })

  it('revokes every playlist token of a revoked member, then 401s', async () => {
    state.member = 'revoked'
    const r = await app.request(`/api/iptv/playlist.m3u?t=${token('playlist', 'iptv-channels-all')}`)
    expect(r.status).toBe(401)
    expect(await r.json()).toEqual({ error: 'access_revoked' })
    expect(calls()).toEqual([`POST /internal/members/${encodeURIComponent(USER.sub)}/revoke-playlist-tokens`])
  })

  it('re-checks the live section and the rating cap at serve time', async () => {
    const t = token('playlist', 'iptv-channels-all')
    await setPolicy(USER.sub, { ...defaultPolicy(), allowedSections: { live: false, downloads: true, arr: true } })
    expect(await (await app.request(`/api/iptv/playlist.m3u?t=${t}`)).json()).toEqual({ error: 'section_blocked' })
    await setPolicy(USER.sub, { ...defaultPolicy(), maxContentRating: 'PG-13' })
    expect(await (await app.request(`/api/iptv/playlist.m3u?t=${t}`)).json()).toEqual({ error: 'rating_blocked' })
    expect(calls()).toEqual([])
  })
})

describe('/api/dvr', () => {
  it('play forwards a ?t= recording token with Range and no session', async () => {
    state.session = null
    const t = token('recording', 'rec-1')
    const r = await app.request(`/api/dvr/recordings/rec-1/play?t=${t}`, { headers: { range: 'bytes=5-' } })
    expect(r.status).toBe(200)
    expect(calls()).toEqual([`GET /api/dvr/recordings/rec-1/play?t=${t}`])
    expect(stub.calls[0].headers.range).toBe('bytes=5-')
  })

  it('tokenless play re-applies the grant gates; mutations are admin-only', async () => {
    await setPolicy(USER.sub, { ...defaultPolicy(), kid: true })
    const capped = await app.request('/api/dvr/recordings/rec-1/play')
    expect(capped.status).toBe(403)
    expect(await capped.json()).toEqual({ error: 'rating_blocked' })
    expect((await app.request('/api/dvr/recordings', { method: 'POST', body: '{}' })).status).toBe(403)
    expect((await app.request('/api/dvr/recordings')).status).toBe(200) // listing is not capped
    expect(calls()).toEqual(['GET /api/dvr/recordings'])
  })
})
