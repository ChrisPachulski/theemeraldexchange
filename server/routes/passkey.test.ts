import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the ceremony engine, the shared authZ gate, the members data layer, and
// the session minter so these tests exercise ROUTE ORCHESTRATION only — most
// importantly the security-critical ordering: authZ runs BEFORE the credential
// is persisted, so a denied invite never leaves an orphan credential.

// vi.mock is hoisted above imports AND top-level consts, so the factory may not
// close over ordinary module-scope variables. vi.hoisted runs WITH the hoist,
// so these handles are initialized before the mocks reference them.
const webauthn = vi.hoisted(() => ({
  beginRegistration: vi.fn(),
  verifyRegistration: vi.fn(),
  persistCredential: vi.fn(),
  beginLogin: vi.fn(),
  verifyLogin: vi.fn(),
}))
vi.mock('../services/webauthn.js', () => webauthn)

const { authorizeOrRedeem, enforceAuthRateLimit, enforceAuthIdentityRateLimit } = vi.hoisted(() => ({
  authorizeOrRedeem: vi.fn(),
  // Default: never rate-limited (returns null). Individual tests can override.
  enforceAuthRateLimit: vi.fn(() => null),
  enforceAuthIdentityRateLimit: vi.fn<typeof import('../auth.js').enforceAuthIdentityRateLimit>(
    () => null,
  ),
}))
vi.mock('../auth.js', () => ({
  authorizeOrRedeem,
  enforceAuthRateLimit,
  enforceAuthIdentityRateLimit,
}))

const members = vi.hoisted(() => ({
  isMember: vi.fn(),
  recordMemberLogin: vi.fn(),
  addMember: vi.fn(),
}))
vi.mock('../services/members.js', () => members)

const { setSessionCookie } = vi.hoisted(() => ({ setSessionCookie: vi.fn() }))
vi.mock('../session.js', () => ({ setSessionCookie }))

// First-owner claim collaborators (plan 006 Phase 1). Default posture is a
// CLAIMED install (isClaimable false) so the legacy invite-flow tests keep
// exercising the shared authZ gate; the claim tests flip these per-case.
const setupState = vi.hoisted(() => ({
  isClaimable: vi.fn(() => false),
  verifySetupToken: vi.fn(() => false),
  markClaimed: vi.fn(),
  claimSourceAllowed: vi.fn(() => true),
  ensureSetupToken: vi.fn(),
}))
vi.mock('../services/setupState.js', () => setupState)

const connection = vi.hoisted(() => ({
  getConnInfo: vi.fn(() => ({ remote: { address: '192.168.1.25' } })),
}))
vi.mock('@hono/node-server/conninfo', () => connection)

const transactionHarness = vi.hoisted(() => ({
  events: [] as string[],
  modes: [] as Array<'deferred' | 'immediate'>,
  transaction: vi.fn((fn: (...args: unknown[]) => unknown) => {
    const run = (mode: 'deferred' | 'immediate') => {
      transactionHarness.modes.push(mode)
      transactionHarness.events.push('transaction:begin')
      const result = fn()
      transactionHarness.events.push('transaction:commit')
      return result
    }
    const deferred = () => run('deferred')
    deferred.immediate = () => run('immediate')
    return deferred
  }),
}))

// The route's DB collaborators are mocked, but the transaction boundary is
// recorded so orchestration tests can prove cookie/device work starts only
// after the invited member + credential unit commits.
vi.mock('../services/serverDb.js', () => ({
  serverDb: () => ({ raw: { transaction: transactionHarness.transaction } }),
}))

import { passkey } from './passkey.js'
import { env } from '../env.js'

const envRw = env as unknown as Record<string, unknown>

function post(path: string, body: unknown) {
  return passkey.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  envRw.trustClientIpHeaders = false
  connection.getConnInfo.mockReturnValue({ remote: { address: '192.168.1.25' } })
  setupState.claimSourceAllowed.mockReturnValue(true)
  transactionHarness.events.length = 0
  transactionHarness.modes.length = 0
  setSessionCookie.mockResolvedValue(undefined)
})

describe('passkey register/options', () => {
  it('400s an empty/invalid handle', async () => {
    expect((await post('/register/options', { handle: '' })).status).toBe(400)
    expect((await post('/register/options', { handle: 'x'.repeat(65) })).status).toBe(400)
    expect((await post('/register/options', {})).status).toBe(400)
    expect(webauthn.beginRegistration).not.toHaveBeenCalled()
  })

  it('returns options + challengeId for a valid handle', async () => {
    webauthn.beginRegistration.mockResolvedValue({
      options: { challenge: 'abc' },
      challengeId: 'cid-1',
    })
    const res = await post('/register/options', { handle: 'Chris' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ options: { challenge: 'abc' }, challengeId: 'cid-1' })
    // Second arg is the request-derived RP override (plan 006 Phase 2) —
    // undefined here because the test request has no same-host Origin.
    expect(webauthn.beginRegistration).toHaveBeenCalledWith('Chris', undefined)
  })
})

describe('passkey register/verify', () => {
  const verified = {
    sub: 'local:01ARZ3NDEKTSV4RRFFQ69G5FAV',
    handle: 'Chris',
    credential: { id: 'cred1', publicKey: new Uint8Array([1]), counter: 0, transports: [], backedUp: true },
  }

  it('mints a member then persists the credential on a valid invite', async () => {
    webauthn.verifyRegistration.mockResolvedValue(verified)
    authorizeOrRedeem.mockImplementation(() => {
      transactionHarness.events.push('invite:redeemed')
      return { allowed: true }
    })
    webauthn.persistCredential.mockImplementation(() => {
      transactionHarness.events.push('credential:persisted')
    })
    members.isMember.mockImplementation(() => {
      transactionHarness.events.push('role:read')
      return { role: 'user' }
    })
    setSessionCookie.mockImplementation(async () => {
      transactionHarness.events.push('session:minted')
    })

    const res = await post('/register/verify', {
      challengeId: 'cid-1',
      response: { id: 'cred1' },
      inviteCode: 'INVITE',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      user: { sub: verified.sub, username: 'Chris', role: 'user' },
    })
    expect(authorizeOrRedeem).toHaveBeenCalledWith(verified.sub, 'INVITE', 'Chris', 'local')
    expect(webauthn.persistCredential).toHaveBeenCalledTimes(1)
    expect(setSessionCookie).toHaveBeenCalledTimes(1)
    expect(transactionHarness.modes).toEqual(['immediate'])
    expect(transactionHarness.events).toEqual([
      'transaction:begin',
      'invite:redeemed',
      'credential:persisted',
      'role:read',
      'transaction:commit',
      'session:minted',
    ])
  })

  it('SECURITY: denied invite leaves NO orphan credential and mints no session', async () => {
    webauthn.verifyRegistration.mockResolvedValue(verified)
    authorizeOrRedeem.mockReturnValue({ allowed: false })

    const res = await post('/register/verify', {
      challengeId: 'cid-1',
      response: { id: 'cred1' },
      inviteCode: 'BAD',
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'no_invite' })
    expect(webauthn.persistCredential).not.toHaveBeenCalled()
    expect(setSessionCookie).not.toHaveBeenCalled()
  })

  it('400s a failed/expired attestation without ever reaching authZ', async () => {
    webauthn.verifyRegistration.mockRejectedValue(new Error('challenge_invalid'))
    const res = await post('/register/verify', { challengeId: 'x', response: { id: 'c' } })
    expect(res.status).toBe(400)
    expect(authorizeOrRedeem).not.toHaveBeenCalled()
    expect(webauthn.persistCredential).not.toHaveBeenCalled()
  })

  it('400s a malformed request body', async () => {
    expect((await post('/register/verify', { challengeId: 'x' })).status).toBe(400)
    expect((await post('/register/verify', { response: {} })).status).toBe(400)
  })
})

describe('first-owner claim (plan 006 Phase 1)', () => {
  const verified = {
    sub: 'local:01ARZ3NDEKTSV4RRFFQ69G5FAV',
    handle: 'Owner',
    credential: { id: 'cred1', publicKey: new Uint8Array([1]), counter: 0, transports: [], backedUp: true },
  }
  const claimBody = {
    challengeId: 'cid-1',
    response: { id: 'cred1' },
    setupToken: 'a'.repeat(64),
  }

  it('valid token claims the server: admin member row + credential + burned token + admin session', async () => {
    webauthn.verifyRegistration.mockResolvedValue(verified)
    setupState.isClaimable.mockReturnValue(true)
    setupState.verifySetupToken.mockReturnValue(true)

    const res = await post('/register/verify', claimBody)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      claimed: true,
      user: { sub: verified.sub, username: 'Owner', role: 'admin' },
    })
    expect(members.addMember).toHaveBeenCalledWith(
      expect.objectContaining({ sub: verified.sub, role: 'admin', authMode: 'local' }),
    )
    expect(webauthn.persistCredential).toHaveBeenCalledTimes(1)
    expect(setupState.markClaimed).toHaveBeenCalledWith(verified.sub)
    expect(setSessionCookie).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ role: 'admin', auth_mode: 'local' }),
    )
    expect(transactionHarness.modes).toEqual(['immediate'])
    // The claim never consults the invite gate.
    expect(authorizeOrRedeem).not.toHaveBeenCalled()
  })

  it('SECURITY: bad token → 403, no member, no credential, no session', async () => {
    webauthn.verifyRegistration.mockResolvedValue(verified)
    setupState.isClaimable.mockReturnValue(true)
    setupState.verifySetupToken.mockReturnValue(false)

    const res = await post('/register/verify', claimBody)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'invalid_setup_token' })
    expect(members.addMember).not.toHaveBeenCalled()
    expect(webauthn.persistCredential).not.toHaveBeenCalled()
    expect(setSessionCookie).not.toHaveBeenCalled()
  })

  it('SECURITY: blocked source address → 403 before the token is even checked', async () => {
    webauthn.verifyRegistration.mockResolvedValue(verified)
    setupState.isClaimable.mockReturnValue(true)
    setupState.claimSourceAllowed.mockReturnValue(false)

    const res = await post('/register/verify', claimBody)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'claim_source_blocked' })
    expect(setupState.verifySetupToken).not.toHaveBeenCalled()
    expect(webauthn.persistCredential).not.toHaveBeenCalled()
    setupState.claimSourceAllowed.mockReturnValue(true)
  })

  it.each([
    {
      name: 'blocks a public Cloudflare client instead of trusting the private proxy socket',
      trusted: true,
      socket: '127.0.0.1',
      headers: { 'cf-connecting-ip': '203.0.113.9' },
      expectedSource: '203.0.113.9',
      allowed: false,
    },
    {
      name: 'allows a private Cloudflare client',
      trusted: true,
      socket: '127.0.0.1',
      headers: { 'cf-connecting-ip': '192.168.50.7' },
      expectedSource: '192.168.50.7',
      allowed: true,
    },
    {
      name: 'uses True-Client-IP when Cloudflare connecting IP is absent',
      trusted: true,
      socket: '127.0.0.1',
      headers: { 'true-client-ip': '203.0.113.11' },
      expectedSource: '203.0.113.11',
      allowed: false,
    },
    {
      name: 'rejects a malformed trusted address instead of falling back to the proxy socket',
      trusted: true,
      socket: '127.0.0.1',
      headers: { 'cf-connecting-ip': '127.example.invalid' },
      expectedSource: '127.example.invalid',
      allowed: false,
    },
    {
      name: 'ignores a spoofed private header when proxy trust is off',
      trusted: false,
      socket: '203.0.113.10',
      headers: { 'cf-connecting-ip': '192.168.50.8' },
      expectedSource: '203.0.113.10',
      allowed: false,
    },
    {
      name: 'allows a direct private-LAN socket',
      trusted: false,
      socket: '192.168.1.55',
      headers: {},
      expectedSource: '192.168.1.55',
      allowed: true,
    },
    {
      name: 'allows a Tailscale Serve CGNAT socket',
      trusted: false,
      socket: '100.64.12.34',
      headers: {},
      expectedSource: '100.64.12.34',
      allowed: true,
    },
    {
      name: 'does not use X-Forwarded-For without a validated proxy chain',
      trusted: true,
      socket: '203.0.113.12',
      headers: { 'x-forwarded-for': '192.168.1.56' },
      expectedSource: '203.0.113.12',
      allowed: false,
    },
  ])('$name', async ({ trusted, socket, headers, expectedSource, allowed }) => {
    envRw.trustClientIpHeaders = trusted
    connection.getConnInfo.mockReturnValue({ remote: { address: socket } })
    setupState.claimSourceAllowed.mockReturnValue(allowed)
    webauthn.verifyRegistration.mockResolvedValue(verified)
    setupState.isClaimable.mockReturnValue(true)
    setupState.verifySetupToken.mockReturnValue(true)

    const res = await passkey.request('/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(claimBody),
    })

    expect(res.status).toBe(allowed ? 200 : 403)
    expect(setupState.claimSourceAllowed).toHaveBeenCalledWith(expectedSource)
  })

  it('SECURITY: race — claim already taken inside the transaction → 403 already_claimed', async () => {
    webauthn.verifyRegistration.mockResolvedValue(verified)
    setupState.verifySetupToken.mockReturnValue(true)
    // Token check passes (pre-transaction) but the transactional re-check
    // sees another claim landed first.
    setupState.isClaimable.mockReturnValue(false)

    const res = await post('/register/verify', claimBody)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'already_claimed' })
    expect(setupState.markClaimed).not.toHaveBeenCalled()
    expect(setSessionCookie).not.toHaveBeenCalled()
  })

  it('SECURITY: while claimable, an un-tokened registration is refused', async () => {
    webauthn.verifyRegistration.mockResolvedValue(verified)
    setupState.isClaimable.mockReturnValue(true)

    const res = await post('/register/verify', { challengeId: 'cid-1', response: { id: 'cred1' } })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'server_unclaimed' })
    expect(authorizeOrRedeem).not.toHaveBeenCalled()
    expect(webauthn.persistCredential).not.toHaveBeenCalled()
  })
})

describe('passkey login/verify', () => {
  it('admits an active member and mints a session', async () => {
    webauthn.verifyLogin.mockResolvedValue({ sub: 'local:01ARZ3NDEKTSV4RRFFQ69G5FAV' })
    members.isMember.mockReturnValue({ role: 'user', display_name: 'Chris' })

    const res = await post('/login/verify', { challengeId: 'cid', response: { id: 'cred1' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      user: { sub: 'local:01ARZ3NDEKTSV4RRFFQ69G5FAV', username: 'Chris', role: 'user' },
    })
    expect(members.recordMemberLogin).toHaveBeenCalledWith(
      'local:01ARZ3NDEKTSV4RRFFQ69G5FAV',
      'Chris',
    )
    expect(setSessionCookie).toHaveBeenCalledTimes(1)
  })

  it('SECURITY: a valid signature for a REVOKED member is denied (403)', async () => {
    webauthn.verifyLogin.mockResolvedValue({ sub: 'local:01ARZ3NDEKTSV4RRFFQ69G5FAV' })
    members.isMember.mockReturnValue(null) // revoked → collapsed to null

    const res = await post('/login/verify', { challengeId: 'cid', response: { id: 'cred1' } })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'access_revoked' })
    expect(setSessionCookie).not.toHaveBeenCalled()
  })

  it('400s a failed assertion', async () => {
    webauthn.verifyLogin.mockRejectedValue(new Error('credential_unknown'))
    const res = await post('/login/verify', { challengeId: 'cid', response: { id: 'c' } })
    expect(res.status).toBe(400)
    expect(members.isMember).not.toHaveBeenCalled()
  })
})

describe('passkey identity-keyed rate limiting', () => {
  it('login/verify keys an identity bucket on the attempted credential id BEFORE verification', async () => {
    webauthn.verifyLogin.mockResolvedValue({ sub: 'local:01ARZ3NDEKTSV4RRFFQ69G5FAV' })
    members.isMember.mockReturnValue({ role: 'user', display_name: 'Chris' })
    await post('/login/verify', { challengeId: 'cid', response: { id: 'cred-xyz' } })
    expect(enforceAuthIdentityRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      'passkey',
      'cred:cred-xyz',
    )
  })

  it('register/verify keys an identity bucket on the attempted credential id', async () => {
    webauthn.verifyRegistration.mockRejectedValue(new Error('challenge_invalid'))
    await post('/register/verify', { challengeId: 'cid', response: { id: 'cred-abc' } })
    expect(enforceAuthIdentityRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      'passkey',
      'cred:cred-abc',
    )
  })

  it('register/options keys an identity bucket on the attempted handle', async () => {
    webauthn.beginRegistration.mockResolvedValue({ options: {}, challengeId: 'cid' })
    await post('/register/options', { handle: 'Chris' })
    expect(enforceAuthIdentityRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      'passkey',
      'handle:Chris',
    )
  })

  it('a limited identity short-circuits login/verify before the ceremony runs', async () => {
    enforceAuthIdentityRateLimit.mockImplementationOnce(
      (c: { json: (b: unknown, s: number) => Response }) =>
        c.json({ error: 'rate_limited' }, 429),
    )
    const res = await post('/login/verify', { challengeId: 'cid', response: { id: 'cred-xyz' } })
    expect(res.status).toBe(429)
    expect(webauthn.verifyLogin).not.toHaveBeenCalled()
  })
})
