// Auth flow tests with a fully mocked plex.tv. Specifically asserts:
//  - role assignment from the ADMINS env var
//  - the server-membership gate when PLEX_SERVER_ID is set vs unset
//  - the discoveredServers payload that helps the operator find their
//    machineIdentifier on first run
//  - /api/me round-trip (401 → set cookie → 200)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'

// ---------------------------------------------------------------------------
// Mock the sibling-owned authZ + SIWA modules. The members allowlist
// (membership.js) and the Apple JWKS verifier (appleAuth.js) are created
// on parallel branches; here we mock their documented surfaces so the
// route wiring can be tested in isolation.
// ---------------------------------------------------------------------------
type MemberStatus = 'allowed' | 'revoked' | 'not_member'
const allowlist = new Map<string, MemberStatus>()
const invites = new Map<string, { uses: number }>()
const redeemSpy = vi.fn(
  (
    code: string,
    sub: string,
    _displayName: string | null,
    _authMode: 'plex' | 'apple' | 'local' | 'google',
  ): { ok: true; created: boolean } | { ok: false; reason: string } => {
    const inv = invites.get(code)
    if (!inv || inv.uses <= 0) return { ok: false, reason: 'invalid' }
    inv.uses -= 1
    allowlist.set(sub, 'allowed')
    return { ok: true, created: true }
  },
)
vi.mock('./services/membership.js', () => ({
  memberStatus: (sub: string): MemberStatus => allowlist.get(sub) ?? 'not_member',
  redeemInvite: (
    code: string,
    sub: string,
    displayName: string | null,
    authMode: 'plex' | 'apple' | 'local' | 'google',
  ) => redeemSpy(code, sub, displayName, authMode),
}))

// members.js owns the allowlist write surface; the Plex-server-share
// auto-admit calls addMember to mint a row. Mock it so we can assert it
// fired without touching a real DB.
const addMemberSpy = vi.fn()
vi.mock('./services/members.js', () => ({
  addMember: (opts: unknown) => addMemberSpy(opts),
}))

// Apple verifier: success keyed on a fixed valid-token sentinel; otherwise
// returns a typed failure. The verified sub is a valid apple-pattern sub.
const APPLE_SUB = 'apple:000000.0123456789abcdef0123456789abcdef.0000'
const appleVerifyImpl: {
  fn: (idToken: string, opts: { expectedNonce?: string }) => Promise<
    | { ok: true; sub: { raw: string; provider: 'apple'; id: string }; email?: string; emailVerified?: boolean }
    | { ok: false; error: string }
  >
} = {
  fn: async (idToken) => {
    if (idToken === 'valid-apple-token') {
      return {
        ok: true,
        sub: { raw: APPLE_SUB, provider: 'apple', id: '000000.0123456789abcdef0123456789abcdef.0000' },
        email: 'mom@example.com',
        emailVerified: true,
      }
    }
    return { ok: false, error: 'invalid_signature' }
  },
}
vi.mock('./services/appleAuth.js', () => ({
  verifyAppleIdentityToken: (idToken: string, opts: { expectedNonce?: string }) =>
    appleVerifyImpl.fn(idToken, opts),
}))

// Google verifier: success keyed on a fixed valid-token sentinel; otherwise a
// typed failure. Mirrors the Apple mock so the /google route wiring (rate
// limit, 503, authZ gate, session) is testable without googleapis.com.
const GOOGLE_SUB = 'google:104223294318414512345'
const googleVerifyImpl: {
  fn: (idToken: string, opts: { expectedNonce?: string }) => Promise<
    | { ok: true; sub: { raw: string; provider: 'google'; id: string }; email?: string; emailVerified?: boolean; name?: string }
    | { ok: false; error: string }
  >
} = {
  fn: async (idToken) => {
    if (idToken === 'valid-google-token') {
      return {
        ok: true,
        sub: { raw: GOOGLE_SUB, provider: 'google', id: '104223294318414512345' },
        email: 'gary@example.com',
        emailVerified: true,
        name: 'Gary G',
      }
    }
    return { ok: false, error: 'invalid_signature' }
  },
}
vi.mock('./services/googleAuth.js', () => ({
  verifyGoogleIdentityToken: (idToken: string, opts: { expectedNonce?: string }) =>
    googleVerifyImpl.fn(idToken, opts),
}))

import { auth, me, _resetAuthRateLimitsForTests } from './auth.js'
import { env, isAppleConfigured } from './env.js'
import { createSession } from './session.js'
import {
  _primeSessionGateCache,
  _resetSessionGateCacheForTests,
} from './services/sessionGate.js'

function app() {
  const a = new Hono()
  a.route('/auth', auth)
  a.route('/me', me)
  return a
}

beforeEach(() => {
  // Clean any prior PLEX_SERVER_ID so different tests can flip it on
  // by mutating env directly. (We mutate the const-asserted object via
  // a cast — fine for tests, ugly in prod.)
  ;(env as Record<string, unknown>).plexServerId = null
  ;(env as Record<string, unknown>).trustClientIpHeaders = false
  // sessionGate's membership cache is module-scoped — clear between
  // tests so the revoked-access tests below don't carry primed state
  // into the next case.
  _resetSessionGateCacheForTests()
  _resetAuthRateLimitsForTests()
  // Reset the mocked allowlist / invites / SIWA verifier between tests.
  allowlist.clear()
  invites.clear()
  redeemSpy.mockClear()
  addMemberSpy.mockClear()
  appleVerifyImpl.fn = async (idToken) => {
    if (idToken === 'valid-apple-token') {
      return {
        ok: true,
        sub: { raw: APPLE_SUB, provider: 'apple', id: '000000.0123456789abcdef0123456789abcdef.0000' },
        email: 'mom@example.com',
        emailVerified: true,
      }
    }
    return { ok: false, error: 'invalid_signature' }
  }
  ;(env as Record<string, unknown>).googleClientIds = []
  googleVerifyImpl.fn = async (idToken) => {
    if (idToken === 'valid-google-token') {
      return {
        ok: true,
        sub: { raw: GOOGLE_SUB, provider: 'google', id: '104223294318414512345' },
        email: 'gary@example.com',
        emailVerified: true,
        name: 'Gary G',
      }
    }
    return { ok: false, error: 'invalid_signature' }
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubPlex(opts: {
  pinId?: number
  authToken?: string | null
  username?: string
  resources?: Array<{ name: string; clientIdentifier: string; owned: boolean; provides: string }>
}) {
  const {
    pinId = 12345,
    authToken = null,
    username = 'test-user',
    resources = [],
  } = opts
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

      if (url.startsWith('https://plex.tv/api/v2/pins/') && url.endsWith(`/${pinId}`) === false) {
        // GET /pins/:id
        return new Response(JSON.stringify({ id: pinId, code: 'abc', authToken }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/api/v2/pins/' + pinId)) {
        return new Response(JSON.stringify({ id: pinId, code: 'abc', authToken }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/api/v2/pins')) {
        // POST /pins
        return new Response(JSON.stringify({ id: pinId, code: 'abc', authToken: null }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/api/v2/user')) {
        return new Response(
          JSON.stringify({
            id: 999,
            uuid: 'uuid-999',
            username,
            email: `${username}@example.com`,
            thumb: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/api/v2/resources')) {
        return new Response(JSON.stringify(resources), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not stubbed: ' + url, { status: 599 })
    }),
  )
}

describe('GET /auth/plex/config', () => {
  it('returns the public X-Plex-Client-Identifier + product (no PIN created server-side)', async () => {
    const r = await app().request('/auth/plex/config')
    expect(r.status).toBe(200)
    const body = (await r.json()) as { clientId: string; product: string }
    expect(body.clientId).toBe(env.plexClientId)
    expect(typeof body.product).toBe('string')
    expect(body.product.length).toBeGreaterThan(0)
  })
})

describe('POST /auth/plex/check', () => {
  it('returns pending while plex.tv hasn\'t set authToken yet', async () => {
    stubPlex({ authToken: null })
    const r = await app().request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinId: 12345 }),
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ status: 'pending' })
  })

  it('allows normal polling but does not let rotated forwarding headers bypass PIN-check limits', async () => {
    ;(env as Record<string, unknown>).trustClientIpHeaders = true
    stubPlex({ authToken: null })
    // 60 sequential requests through the rate limiter; reuse one app
    // instance (state is module-scoped, reset in beforeEach) instead of
    // rebuilding the Hono router 63×. The generous timeout covers a
    // slow shared CI runner — the prior 5000ms default flaked at
    // ~5.1s on GitHub's 2-core hosts under parallel job load.
    const a = app()
    for (let i = 0; i < 60; i++) {
      const headers = { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.20', 'x-forwarded-for': `203.0.113.${i}` }
      const r = await a.request('/auth/plex/check', {
        method: 'POST',
        headers,
        body: JSON.stringify({ pinId: 12345 }),
      })
      expect(r.status).toBe(200)
    }
    const r = await a.request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.20', 'x-forwarded-for': '203.0.113.200' },
      body: JSON.stringify({ pinId: 12345 }),
    })
    expect(r.status).toBe(429)
    expect(await r.json()).toEqual({ error: 'rate_limited' })

    const other = await a.request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.21' },
      body: JSON.stringify({ pinId: 12346 }),
    })
    expect(other.status).toBe(200)
  }, 15_000)

  it('400s a missing pinId', async () => {
    const r = await app().request('/auth/plex/check', { method: 'POST' })
    expect(r.status).toBe(400)
  })

  it('does not trust proxy client-IP headers unless explicitly enabled', async () => {
    stubPlex({ authToken: null })
    const a = app()
    for (let i = 0; i < 61; i++) {
      const r = await a.request('/auth/plex/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '198.51.100.20' },
        body: JSON.stringify({ pinId: 12345 }),
      })
      expect(r.status).toBe(200)
    }
  })

  it('400s a non-numeric pinId', async () => {
    const r = await app().request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinId: 'foo' }),
    })
    expect(r.status).toBe(400)
  })

  it('400s a query-string pinId', async () => {
    const r = await app().request('/auth/plex/check?pinId=12345', { method: 'POST' })
    expect(r.status).toBe(400)
  })

  it('promotes ADMINS-listed username to admin role', async () => {
    allowlist.set('plex:999', 'allowed')
    stubPlex({ authToken: 'real-token', username: 'admin-user' })
    const r = await app().request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinId: 12345 }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      status?: string
      reason?: string
      user: { username: string; role: string }
      discoveredServers?: { name: string; id: string; owned: boolean }[]
    }
    expect(body.status).toBe('authorized')
    expect(body.user.role).toBe('admin')
    expect(r.headers.get('set-cookie')).toContain('eex.session=')
  })

  it('assigns user role to non-listed usernames', async () => {
    allowlist.set('plex:999', 'allowed')
    stubPlex({ authToken: 'real-token', username: 'random-guest' })
    const r = await app().request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinId: 12345 }),
    })
    const body = (await r.json()) as {
      status?: string
      reason?: string
      user: { username: string; role: string }
      discoveredServers?: { name: string; id: string; owned: boolean }[]
    }
    expect(body.user.role).toBe('user')
  })

  it('denies a Plex identity that is not a member and presents no invite (403 no_invite)', async () => {
    // The Plex identity is valid, but authZ is now the invite/members
    // allowlist — NOT the Plex machineId. With no member row and no
    // invite, access is refused. This is the central invitation-only gate.
    stubPlex({ authToken: 'real-token', username: 'random-guest' })
    const r = await app().request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinId: 12345 }),
    })
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ status: 'denied', reason: 'no_invite' })
    // No PLEX_SERVER_ID configured here (beforeEach nulls it), so the
    // Plex-server-share auto-admit must NOT fire.
    expect(addMemberSpy).not.toHaveBeenCalled()
  })

  it('auto-admits a Plex identity shared on the owner server (mints a member, no invite)', async () => {
    // The headline behavior: being shared on the owner's Plex server grants
    // app access automatically — no separate invite. PLEX_SERVER_ID is set
    // and the user's resources include that server (owned:false = invited).
    ;(env as Record<string, unknown>).plexServerId = 'home-server-id'
    stubPlex({
      authToken: 'real-token',
      username: 'shared-friend',
      resources: [
        { name: 'Home', clientIdentifier: 'home-server-id', owned: false, provides: 'server' },
      ],
    })
    const r = await app().request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinId: 12345 }),
    })
    expect(r.status).toBe(200)
    expect(((await r.json()) as { status?: string }).status).toBe('authorized')
    expect(addMemberSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'plex:999', authMode: 'plex', invitedBy: 'plex:server-share' }),
    )
  })

  it('does NOT auto-admit a Plex identity that is not on the owner server (403)', async () => {
    ;(env as Record<string, unknown>).plexServerId = 'home-server-id'
    stubPlex({
      authToken: 'real-token',
      username: 'stranger',
      resources: [
        // Only a server they own / a different server — not the owner's.
        { name: 'Someone Else', clientIdentifier: 'other-server', owned: false, provides: 'server' },
      ],
    })
    const r = await app().request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinId: 12345 }),
    })
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ status: 'denied', reason: 'no_invite' })
    expect(addMemberSpy).not.toHaveBeenCalled()
  })

  it('does NOT auto-admit a REVOKED member even if still shared on the server (explicit revoke wins)', async () => {
    // A revoked member is status 'revoked', not 'not_member', so the
    // auto-admit (gated to brand-new identities) must not silently re-grant.
    ;(env as Record<string, unknown>).plexServerId = 'home-server-id'
    allowlist.set('plex:999', 'revoked')
    stubPlex({
      authToken: 'real-token',
      username: 'kicked',
      resources: [
        { name: 'Home', clientIdentifier: 'home-server-id', owned: false, provides: 'server' },
      ],
    })
    const r = await app().request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinId: 12345 }),
    })
    expect(r.status).toBe(403)
    expect(addMemberSpy).not.toHaveBeenCalled()
  })

  it('admits an existing Plex member (allowlist hit, no invite needed)', async () => {
    allowlist.set('plex:999', 'allowed')
    stubPlex({ authToken: 'real-token', username: 'random-guest' })
    const r = await app().request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinId: 12345 }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { status?: string }
    expect(body.status).toBe('authorized')
    expect(redeemSpy).not.toHaveBeenCalled()
  })

  it('admits a new Plex identity that redeems a valid invite (mints membership)', async () => {
    invites.set('GOODCODE', { uses: 1 })
    stubPlex({ authToken: 'real-token', username: 'random-guest' })
    const r = await app().request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinId: 12345, inviteCode: 'GOODCODE' }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { status?: string }
    expect(body.status).toBe('authorized')
    expect(redeemSpy).toHaveBeenCalledWith('GOODCODE', 'plex:999', 'random-guest', 'plex')
  })

  it('denies a new Plex identity with an invalid invite (403 no_invite)', async () => {
    stubPlex({ authToken: 'real-token', username: 'random-guest' })
    const r = await app().request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinId: 12345, inviteCode: 'WRONG' }),
    })
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ status: 'denied', reason: 'no_invite' })
  })

  it('returns discoveredServers when PLEX_SERVER_ID is unset (first-run aid)', async () => {
    ;(env as Record<string, unknown>).plexServerId = null
    allowlist.set('plex:999', 'allowed')
    stubPlex({
      authToken: 'real-token',
      username: 'admin-user',
      resources: [
        { name: 'My NAS', clientIdentifier: 'nas-id', owned: true, provides: 'server' },
        { name: 'Friend\'s', clientIdentifier: 'friend-id', owned: false, provides: 'server' },
        // Non-server resources should be filtered out
        { name: 'Some Player', clientIdentifier: 'player-id', owned: false, provides: 'player' },
      ],
    })
    const r = await app().request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinId: 12345 }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      status?: string
      reason?: string
      user: { username: string; role: string }
      discoveredServers?: { name: string; id: string; owned: boolean }[]
    }
    expect(body.discoveredServers).toEqual([
      { name: 'My NAS', id: 'nas-id', owned: true },
      { name: "Friend's", id: 'friend-id', owned: false },
    ])
  })
})

describe('POST /auth/apple (Sign in with Apple)', () => {
  // SIWA is gated on APPLE_CLIENT_ID; tests that exercise the verified
  // path stub env.appleClientId so isAppleConfigured() is true.
  async function withApple<T>(fn: () => Promise<T>): Promise<T> {
    const before = (env as Record<string, unknown>).appleClientId
    ;(env as Record<string, unknown>).appleClientId = 'com.example.eex'
    try {
      return await fn()
    } finally {
      ;(env as Record<string, unknown>).appleClientId = before
    }
  }

  it('503s when SIWA is not configured', async () => {
    expect(isAppleConfigured()).toBe(false)
    const r = await app().request('/auth/apple', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identityToken: 'valid-apple-token' }),
    })
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'apple_not_configured' })
  })

  it('400s a missing identity token', async () => {
    await withApple(async () => {
      const r = await app().request('/auth/apple', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(r.status).toBe(400)
      expect(await r.json()).toEqual({ error: 'missing identity_token' })
    })
  })

  it('401s an invalid identity token', async () => {
    await withApple(async () => {
      const r = await app().request('/auth/apple', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityToken: 'forged' }),
      })
      expect(r.status).toBe(401)
      const body = (await r.json()) as { error: string; reason: string }
      expect(body.error).toBe('invalid_identity_token')
      expect(body.reason).toBe('invalid_signature')
    })
  })

  it('503s when Apple JWKS is unavailable (transient, not the user\'s fault)', async () => {
    await withApple(async () => {
      appleVerifyImpl.fn = async () => ({ ok: false, error: 'jwks_unavailable' })
      const r = await app().request('/auth/apple', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityToken: 'valid-apple-token' }),
      })
      expect(r.status).toBe(503)
    })
  })

  it('throttles repeated attempts against ONE Apple identity even with untrusted IP headers', async () => {
    await withApple(async () => {
      // TRUST_CLIENT_IP_HEADERS is off (beforeEach default) — the per-client
      // IP buckets never engage, which used to leave only the coarse global
      // bucket (200/min) biting behind the tunnel. The identity bucket keys
      // on the token's (unverified) sub, so rotating source IPs doesn't help.
      expect(env.trustClientIpHeaders).toBe(false)
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
      const fakeJwt = (sub: string) => `${b64({ alg: 'RS256' })}.${b64({ sub })}.sig`
      const a = app()
      const stuffedToken = fakeJwt('001234.deadbeefdeadbeefdeadbeefdeadbeef.5678')
      for (let i = 0; i < 20; i++) {
        const r = await a.request('/auth/apple', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'cf-connecting-ip': `203.0.113.${i}`, // rotating, untrusted
          },
          body: JSON.stringify({ identityToken: stuffedToken }),
        })
        // Verifier rejects the forgery, but the limiter hasn't tripped yet.
        expect(r.status).toBe(401)
      }
      const limited = await a.request('/auth/apple', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.250' },
        body: JSON.stringify({ identityToken: stuffedToken }),
      })
      expect(limited.status).toBe(429)
      expect(await limited.json()).toEqual({ error: 'rate_limited' })
      expect(limited.headers.get('Retry-After')).toBeTruthy()

      // A DIFFERENT identity is not collateral damage of the stuffed one.
      const other = await a.request('/auth/apple', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityToken: fakeJwt('009999.feedfacefeedfacefeedfacefeedface.1111') }),
      })
      expect(other.status).toBe(401)
    })
  }, 15_000)

  it('a token without a parseable sub still passes through to verification (global bucket only)', async () => {
    await withApple(async () => {
      const r = await app().request('/auth/apple', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityToken: 'not-a-jwt-at-all' }),
      })
      // No identity to key on → no identity bucket; the verifier rejects it.
      expect(r.status).toBe(401)
    })
  })

  it('verified Apple identity with a valid invite creates a member and mints a session', async () => {
    await withApple(async () => {
      invites.set('APPLECODE', { uses: 1 })
      const r = await app().request('/auth/apple', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityToken: 'valid-apple-token', inviteCode: 'APPLECODE' }),
      })
      expect(r.status).toBe(200)
      const body = (await r.json()) as { status: string; user: { sub: string; email?: string } }
      expect(body.status).toBe('authorized')
      expect(body.user.sub).toBe(APPLE_SUB)
      expect(body.user.email).toBe('mom@example.com')
      expect(redeemSpy).toHaveBeenCalledWith('APPLECODE', APPLE_SUB, 'mom', 'apple')
      expect(r.headers.get('set-cookie')).toContain('eex.session=')
    })
  })

  it('verified Apple member re-login is allowed without an invite', async () => {
    await withApple(async () => {
      allowlist.set(APPLE_SUB, 'allowed')
      const r = await app().request('/auth/apple', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityToken: 'valid-apple-token' }),
      })
      expect(r.status).toBe(200)
      expect(redeemSpy).not.toHaveBeenCalled()
    })
  })

  it('verified Apple identity with no member row and no invite is denied (403 no_invite)', async () => {
    await withApple(async () => {
      const r = await app().request('/auth/apple', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityToken: 'valid-apple-token' }),
      })
      expect(r.status).toBe(403)
      expect(await r.json()).toEqual({ status: 'denied', reason: 'no_invite' })
    })
  })

  it('mints an apple-mode session (no plexAuthToken) that /me reports as auth_mode apple', async () => {
    await withApple(async () => {
      allowlist.set(APPLE_SUB, 'allowed')
      const r1 = await app().request('/auth/apple', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityToken: 'valid-apple-token' }),
      })
      const cookie = r1.headers.get('set-cookie')!.split(';')[0]
      const r2 = await app().request('/me', { headers: { Cookie: cookie } })
      expect(r2.status).toBe(200)
      const body = (await r2.json()) as { user: { sub: string; auth_mode: string } }
      expect(body.user.sub).toBe(APPLE_SUB)
      expect(body.user.auth_mode).toBe('apple')
    })
  })
})

describe('POST /auth/google (Google Sign-In)', () => {
  // Gated on GOOGLE_CLIENT_ID; configured-path tests set env.googleClientIds.
  async function withGoogle<T>(fn: () => Promise<T>): Promise<T> {
    const before = (env as Record<string, unknown>).googleClientIds
    ;(env as Record<string, unknown>).googleClientIds = ['123-abc.apps.googleusercontent.com']
    try {
      return await fn()
    } finally {
      ;(env as Record<string, unknown>).googleClientIds = before
    }
  }

  it('503s when Google is not configured', async () => {
    const r = await app().request('/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identityToken: 'valid-google-token' }),
    })
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'google_not_configured' })
  })

  it('400s a missing identity token', async () => {
    await withGoogle(async () => {
      const r = await app().request('/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(r.status).toBe(400)
      expect(await r.json()).toEqual({ error: 'missing identity_token' })
    })
  })

  it('accepts Google\'s own idToken claim name (not just identityToken)', async () => {
    await withGoogle(async () => {
      allowlist.set(GOOGLE_SUB, 'allowed')
      const r = await app().request('/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: 'valid-google-token' }),
      })
      expect(r.status).toBe(200)
      expect(((await r.json()) as { status?: string }).status).toBe('authorized')
    })
  })

  it('401s an invalid identity token', async () => {
    await withGoogle(async () => {
      const r = await app().request('/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityToken: 'forged' }),
      })
      expect(r.status).toBe(401)
      const body = (await r.json()) as { error: string; reason: string }
      expect(body.error).toBe('invalid_identity_token')
      expect(body.reason).toBe('invalid_signature')
    })
  })

  it('503s when Google JWKS is unavailable (transient, not the user\'s fault)', async () => {
    await withGoogle(async () => {
      googleVerifyImpl.fn = async () => ({ ok: false, error: 'jwks_unavailable' })
      const r = await app().request('/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityToken: 'valid-google-token' }),
      })
      expect(r.status).toBe(503)
    })
  })

  it('verified Google identity with a valid invite creates a member and mints a session', async () => {
    await withGoogle(async () => {
      invites.set('GOOGCODE', { uses: 1 })
      const r = await app().request('/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityToken: 'valid-google-token', inviteCode: 'GOOGCODE' }),
      })
      expect(r.status).toBe(200)
      const body = (await r.json()) as { status: string; user: { sub: string; email?: string } }
      expect(body.status).toBe('authorized')
      expect(body.user.sub).toBe(GOOGLE_SUB)
      expect(body.user.email).toBe('gary@example.com')
      expect(redeemSpy).toHaveBeenCalledWith('GOOGCODE', GOOGLE_SUB, 'Gary G', 'google')
      expect(r.headers.get('set-cookie')).toContain('eex.session=')
    })
  })

  it('verified Google member re-login is allowed without an invite', async () => {
    await withGoogle(async () => {
      allowlist.set(GOOGLE_SUB, 'allowed')
      const r = await app().request('/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityToken: 'valid-google-token' }),
      })
      expect(r.status).toBe(200)
      expect(redeemSpy).not.toHaveBeenCalled()
    })
  })

  it('verified Google identity with no member row and no invite is denied (403 no_invite)', async () => {
    await withGoogle(async () => {
      const r = await app().request('/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityToken: 'valid-google-token' }),
      })
      expect(r.status).toBe(403)
      expect(await r.json()).toEqual({ status: 'denied', reason: 'no_invite' })
    })
  })

  it('mints a session cookie for a verified Google member', async () => {
    // NOTE: the /me round-trip (read the cookie back, assert auth_mode
    // 'google') is intentionally NOT asserted here. readSession →
    // tryNormaliseLegacySub → parseSub goes through the compiled N-API
    // contracts addon, and the checked-in addon predates the google: sub
    // contract — it rejects google: until rebuilt at deploy
    // (`npm --prefix crates/emerald-contracts-napi run build`). The WRITE
    // side (this test) is addon-independent; the read-back is verified once
    // the addon is rebuilt. The google: contract itself is proven by the
    // Rust + Swift sub-namespace suites.
    await withGoogle(async () => {
      allowlist.set(GOOGLE_SUB, 'allowed')
      const r = await app().request('/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityToken: 'valid-google-token' }),
      })
      expect(r.status).toBe(200)
      expect(((await r.json()) as { status?: string }).status).toBe('authorized')
      expect(r.headers.get('set-cookie')).toContain('eex.session=')
    })
  })
})

describe('GET /me + POST /auth/logout', () => {
  it('returns 401 without a session', async () => {
    const r = await app().request('/me')
    expect(r.status).toBe(401)
  })

  it('returns the user after a successful pin check (round-trip)', async () => {
    allowlist.set('plex:999', 'allowed')
    stubPlex({ authToken: 'real-token', username: 'admin-user' })
    const r1 = await app().request('/auth/plex/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinId: 12345 }),
    })
    const cookie = r1.headers.get('set-cookie')!
    const sessionCookie = cookie.split(';')[0]

    const r2 = await app().request('/me', {
      headers: { Cookie: sessionCookie },
    })
    expect(r2.status).toBe(200)
    const body = (await r2.json()) as { user: { username: string; role: string } }
    expect(body.user.username).toBe('admin-user')
    expect(body.user.role).toBe('admin')
  })

  it('logout clears the cookie', async () => {
    const r = await app().request('/auth/logout', { method: 'POST' })
    expect(r.status).toBe(200)
    const setCookie = r.headers.get('set-cookie') ?? ''
    // deleteCookie sets Max-Age=0
    expect(setCookie.toLowerCase()).toMatch(/max-age=0|expires=/)
  })

  it('/me 401s + clears the cookie when membership has been revoked', async () => {
    // Reads of /api/me used to bypass the reconcile pipeline that every
    // protected route already runs through, so a revoked user could
    // keep the SPA in a signed-in state until they tried a protected
    // action. Now /me runs the same reconcileSession + clearSessionCookie
    // path and surfaces the revoke immediately. Set up: a configured
    // Plex gate, a session whose membership cache says not_member,
    // confirms /me returns 401 with access_revoked AND drops the cookie.
    ;(env as Record<string, unknown>).plexServerId = 'home-machine-id'
    const token = await createSession({
      sub: '777',
      username: 'admin-user',
      role: 'admin',
      plexAuthToken: 'still-valid-but-no-longer-a-member',
    })
    _primeSessionGateCache('777', 'not_member')
    const r = await app().request('/me', {
      headers: { Cookie: `eex.session=${token}` },
    })
    expect(r.status).toBe(401)
    expect(await r.json()).toEqual({
      error: 'unauthenticated',
      reason: 'access_revoked',
    })
    const setCookie = (r.headers.get('set-cookie') ?? '').toLowerCase()
    expect(setCookie).toMatch(/eex\.session=/)
    expect(setCookie).toMatch(/max-age=0|expires=/)
  })

  it('/me reflects the recomputed role on the next call after an ADMINS demotion', async () => {
    // Cookie says 'admin' (issued when the user was in ADMINS), then
    // the operator edits ADMINS to drop them. /me must reflect the
    // recomputed 'user' role on the next call rather than echoing the
    // stale role from the cookie.
    allowlist.set('plex:555', 'allowed')
    const token = await createSession({
      sub: '555',
      username: 'admin-user',
      role: 'admin',
      plexAuthToken: 'token-555',
    })
    // Snapshot, demote, restore at end of test.
    const adminsBefore = env.admins
    ;(env as Record<string, unknown>).admins = []
    try {
      const r = await app().request('/me', {
        headers: { Cookie: `eex.session=${token}` },
      })
      expect(r.status).toBe(200)
      const body = (await r.json()) as { user: { role: string } }
      expect(body.user.role).toBe('user')
    } finally {
      ;(env as Record<string, unknown>).admins = adminsBefore
    }
  })
})
