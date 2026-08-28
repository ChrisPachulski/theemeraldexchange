// /api/auth/workos/native/* — the Apple app's in-app AuthKit sign-in (PKCE).
// start builds the authorize URL with the native redirect + code challenge and
// hands back a one-shot state; the exchange forwards code + verifier to WorkOS
// and mints a device token for an existing member.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { auth, _resetAuthRateLimitsForTests } from './auth.js'
import { env } from './env.js'
import { serverDb } from './services/serverDb.js'
import type { Env } from './middleware/auth.js'

const SUB = 'workos:user_01M12813GMJQQ4DXDWTBRC75G2'
const VERIFIER = 'a'.repeat(43)
const CHALLENGE = 'b'.repeat(43)
const DEVICE = { device_id: 'ulid-phone-1', device_name: 'Ana’s iPhone', device_platform: 'ios' }

function app() {
  const a = new Hono<Env>()
  a.route('/', auth)
  return a
}
const post = (a: Hono<Env>, path: string, body: unknown) =>
  a.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })

const saved = { id: env.workosClientId, key: env.workosApiKey, uri: env.workosRedirectUri }
let workosCalls: Array<{ url: string; body: Record<string, unknown> }> = []

beforeEach(() => {
  _resetAuthRateLimitsForTests()
  workosCalls = []
  Object.assign(env as Record<string, unknown>, { workosClientId: 'client_test', workosApiKey: 'sk_test', workosRedirectUri: 'https://api.example.test/api/auth/workos/callback' })
  serverDb().raw.prepare(`INSERT OR REPLACE INTO members (sub, display_name, role, auth_mode, invited_by, joined_at, revoked_at) VALUES (?, 'ana', 'user', 'workos', NULL, ?, NULL)`).run(SUB, new Date().toISOString())
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    workosCalls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    return new Response(JSON.stringify({ user: { id: SUB.slice('workos:'.length), email: 'ana@example.test', first_name: 'Ana' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
})
afterEach(() => {
  Object.assign(env as Record<string, unknown>, { workosClientId: saved.id, workosApiKey: saved.key, workosRedirectUri: saved.uri })
  vi.unstubAllGlobals()
})

describe('POST /workos/native/start', () => {
  it('returns an AuthKit URL bound to the native redirect and the PKCE challenge', async () => {
    const res = await post(app(), '/workos/native/start', { code_challenge: CHALLENGE })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { url: string; state: string; redirect_uri: string }
    const u = new URL(body.url)
    expect(u.searchParams.get('redirect_uri')).toBe('emerald://auth/workos')
    expect(u.searchParams.get('code_challenge')).toBe(CHALLENGE)
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('state')).toBe(body.state)
    expect(body.redirect_uri).toBe('emerald://auth/workos')
  })
  it('rejects a malformed challenge', async () => {
    expect((await post(app(), '/workos/native/start', { code_challenge: 'short' })).status).toBe(400)
  })
})

describe('POST /workos/native', () => {
  it('exchanges code + verifier with WorkOS and mints a device token', async () => {
    const a = app()
    const { state } = (await (await post(a, '/workos/native/start', { code_challenge: CHALLENGE })).json()) as { state: string }
    const res = await post(a, '/workos/native', { code: 'code_123', code_verifier: VERIFIER, state, ...DEVICE })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; token: string; user: { sub: string; username: string } }
    expect(body.status).toBe('authorized')
    expect(body.user).toMatchObject({ sub: SUB, username: 'Ana' })
    expect(body.token.length).toBeGreaterThan(100)
    expect(workosCalls[0]?.body).toMatchObject({ grant_type: 'authorization_code', code: 'code_123', code_verifier: VERIFIER })
  })
  it('refuses a replayed or unknown state', async () => {
    const a = app()
    const { state } = (await (await post(a, '/workos/native/start', { code_challenge: CHALLENGE })).json()) as { state: string }
    await post(a, '/workos/native', { code: 'c', code_verifier: VERIFIER, state, ...DEVICE })
    expect((await post(a, '/workos/native', { code: 'c', code_verifier: VERIFIER, state, ...DEVICE })).status).toBe(400)
    expect((await post(a, '/workos/native', { code: 'c', code_verifier: VERIFIER, state: 'nope', ...DEVICE })).status).toBe(400)
  })
  it('denies a non-member without an invite', async () => {
    serverDb().raw.prepare('DELETE FROM members WHERE sub = ?').run(SUB)
    const a = app()
    const { state } = (await (await post(a, '/workos/native/start', { code_challenge: CHALLENGE })).json()) as { state: string }
    const res = await post(a, '/workos/native', { code: 'c', code_verifier: VERIFIER, state, ...DEVICE })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ status: 'denied', reason: 'no_invite' })
  })
})
