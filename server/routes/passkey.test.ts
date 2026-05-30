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

const { authorizeOrRedeem } = vi.hoisted(() => ({ authorizeOrRedeem: vi.fn() }))
vi.mock('../auth.js', () => ({ authorizeOrRedeem }))

const members = vi.hoisted(() => ({ isMember: vi.fn(), recordMemberLogin: vi.fn() }))
vi.mock('../services/members.js', () => members)

const { setSessionCookie } = vi.hoisted(() => ({ setSessionCookie: vi.fn() }))
vi.mock('../session.js', () => ({ setSessionCookie }))

import { passkey } from './passkey.js'

function post(path: string, body: unknown) {
  return passkey.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
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
    expect(webauthn.beginRegistration).toHaveBeenCalledWith('Chris')
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
    authorizeOrRedeem.mockReturnValue({ allowed: true })
    members.isMember.mockReturnValue({ role: 'user' })

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
