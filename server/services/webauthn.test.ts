import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server'

// Point the server.db singleton at a throwaway temp file BEFORE env.ts is
// evaluated. vi.hoisted runs before the static imports below (including the
// fs/path/os imports), so it must require its own node builtins. env.ts reads
// process.env.SERVER_DB_PATH at its own import time.
const { tmpDbDir } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM init
  const nodeFs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM init
  const nodePath = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM init
  const nodeOs = require('node:os') as typeof import('node:os')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'webauthn-test-'))
  process.env.SERVER_DB_PATH = nodePath.join(dir, 'server.db')
  return { tmpDbDir: dir }
})

// Mock ONLY the @simplewebauthn/server crypto functions — they require a real
// authenticator. Everything this module OWNS around them (challenge store,
// persistence, counter bump, error paths) runs against the REAL temp SQLite DB.
// vi.mock is hoisted above imports AND top-level consts, so the factory may not
// close over ordinary module-scope variables. vi.hoisted runs WITH the hoist,
// so these handles are initialized before the mock references them.
const swa = vi.hoisted(() => ({
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}))
vi.mock('@simplewebauthn/server', () => swa)

import { serverDb, closeServerDb } from './serverDb.js'
import {
  beginRegistration,
  verifyRegistration,
  persistCredential,
  beginLogin,
  verifyLogin,
  hasAnyCredential,
} from './webauthn.js'

interface ChallengeRow {
  challenge_id: string
  challenge: string
  ceremony: 'register' | 'login'
  pending_sub: string | null
  pending_handle: string | null
  created_at: string
  expires_at: string
}

interface CredentialRow {
  credential_id: string
  sub: string
  public_key: Buffer
  counter: number
  transports: string | null
  device_label: string | null
  backed_up: number
  last_used_at: string | null
}

function getChallenge(challengeId: string): ChallengeRow | undefined {
  return serverDb()
    .raw.prepare(`SELECT * FROM webauthn_challenges WHERE challenge_id = ?`)
    .get(challengeId) as ChallengeRow | undefined
}

function getCredential(credentialId: string): CredentialRow | undefined {
  return serverDb()
    .raw.prepare(`SELECT * FROM webauthn_credentials WHERE credential_id = ?`)
    .get(credentialId) as CredentialRow | undefined
}

function insertChallengeRow(row: {
  challenge_id: string
  challenge: string
  ceremony: 'register' | 'login'
  pending_sub: string | null
  pending_handle: string | null
  created_at: string
  expires_at: string
}): void {
  serverDb()
    .raw.prepare(
      `INSERT INTO webauthn_challenges
         (challenge_id, challenge, ceremony, pending_sub, pending_handle, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.challenge_id,
      row.challenge,
      row.ceremony,
      row.pending_sub,
      row.pending_handle,
      row.created_at,
      row.expires_at,
    )
}

describe('webauthn ceremony engine', () => {
  beforeAll(() => {
    // Force the singleton open against the temp DB; applies migration 0004.
    serverDb()
  })
  afterAll(() => {
    closeServerDb()
    fs.rmSync(tmpDbDir, { recursive: true, force: true })
  })
  beforeEach(() => {
    serverDb().raw.exec('DELETE FROM webauthn_credentials; DELETE FROM webauthn_challenges;')
    vi.clearAllMocks()
  })

  // ── A. migration sanity ─────────────────────────────────────────────────────
  it('migration 0004 created the webauthn tables', () => {
    const tables = (
      serverDb()
        .raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all() as Array<{ name: string }>
    ).map(t => t.name)
    expect(tables).toContain('webauthn_credentials')
    expect(tables).toContain('webauthn_challenges')
  })

  // ── B. beginRegistration ────────────────────────────────────────────────────
  it('beginRegistration mints a sub, stores a register challenge, and returns a challengeId', async () => {
    swa.generateRegistrationOptions.mockResolvedValue({ challenge: 'chal-reg-abc' })

    const { options, challengeId } = await beginRegistration('Chris')

    expect(options).toEqual({ challenge: 'chal-reg-abc' })
    expect(typeof challengeId).toBe('string')
    expect(challengeId.length).toBeGreaterThan(0)

    const row = getChallenge(challengeId)
    expect(row).toBeDefined()
    expect(row?.ceremony).toBe('register')
    expect(row?.challenge).toBe('chal-reg-abc')
    expect(row?.pending_handle).toBe('Chris')
    expect(row?.pending_sub).toMatch(/^local:/)
    expect(row?.expires_at).toBeDefined()
    expect(row && row.expires_at > row.created_at).toBe(true)

    expect(swa.generateRegistrationOptions).toHaveBeenCalledTimes(1)
    const arg = swa.generateRegistrationOptions.mock.calls[0][0] as {
      userName: string
      authenticatorSelection: { residentKey: string }
    }
    expect(arg.userName).toBe('Chris')
    expect(arg.authenticatorSelection.residentKey).toBe('required')
  })

  // ── C. verifyRegistration happy path + single-use ───────────────────────────
  it('verifyRegistration returns the validated credential and consumes the challenge (single-use)', async () => {
    swa.generateRegistrationOptions.mockResolvedValue({ challenge: 'chal-reg-abc' })
    const { challengeId } = await beginRegistration('Chris')

    swa.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'cred-1',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ['internal'],
        },
        credentialBackedUp: true,
      },
    })

    const result = await verifyRegistration(challengeId, {} as RegistrationResponseJSON)

    expect(result.sub).toMatch(/^local:/)
    expect(result.handle).toBe('Chris')
    expect(result.credential).toEqual({
      id: 'cred-1',
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      transports: ['internal'],
      backedUp: true,
    })

    // expectedChallenge passed to the crypto verifier matches the stored value.
    const verifyArg = swa.verifyRegistrationResponse.mock.calls[0][0] as {
      expectedChallenge: string
    }
    expect(verifyArg.expectedChallenge).toBe('chal-reg-abc')

    // SINGLE-USE: the challenge row was deleted; a second verify with the same id throws.
    expect(getChallenge(challengeId)).toBeUndefined()
    await expect(verifyRegistration(challengeId, {} as RegistrationResponseJSON)).rejects.toThrow(
      'challenge_invalid',
    )
  })

  // ── D. verifyRegistration failure paths ─────────────────────────────────────
  it('verifyRegistration throws challenge_invalid for an unknown challengeId (crypto never called)', async () => {
    await expect(
      verifyRegistration('does-not-exist', {} as RegistrationResponseJSON),
    ).rejects.toThrow('challenge_invalid')
    expect(swa.verifyRegistrationResponse).not.toHaveBeenCalled()
  })

  it('verifyRegistration throws registration_unverified when the attestation does not verify', async () => {
    swa.generateRegistrationOptions.mockResolvedValue({ challenge: 'chal-reg-def' })
    const { challengeId } = await beginRegistration('Chris')

    swa.verifyRegistrationResponse.mockResolvedValue({ verified: false })

    await expect(verifyRegistration(challengeId, {} as RegistrationResponseJSON)).rejects.toThrow(
      'registration_unverified',
    )
  })

  it('verifyRegistration rejects an EXPIRED register challenge and still consumes the row', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const older = new Date(Date.now() - 120_000).toISOString()
    insertChallengeRow({
      challenge_id: 'expired-reg',
      challenge: 'chal-expired',
      ceremony: 'register',
      pending_sub: 'local:01ARZ3NDEKTSV4RRFFQ69G5FAV',
      pending_handle: 'Chris',
      created_at: older,
      expires_at: past,
    })

    await expect(verifyRegistration('expired-reg', {} as RegistrationResponseJSON)).rejects.toThrow(
      'challenge_invalid',
    )
    expect(swa.verifyRegistrationResponse).not.toHaveBeenCalled()
    // takeChallenge deletes the row even when expired.
    expect(getChallenge('expired-reg')).toBeUndefined()
  })

  // ── E. persistCredential + hasAnyCredential ─────────────────────────────────
  it('hasAnyCredential is false on an empty table and true after persistCredential', () => {
    expect(hasAnyCredential()).toBe(false)

    persistCredential(
      'local:01ARZ3NDEKTSV4RRFFQ69G5FAV',
      {
        id: 'cred-1',
        publicKey: new Uint8Array([9, 9]),
        counter: 0,
        transports: ['hybrid'],
        backedUp: true,
      },
      "Chris's iPhone",
    )

    expect(hasAnyCredential()).toBe(true)

    const row = getCredential('cred-1')
    expect(row).toBeDefined()
    expect(row?.sub).toBe('local:01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(row?.backed_up).toBe(1)
    expect(row?.device_label).toBe("Chris's iPhone")
    expect(JSON.parse(row?.transports ?? '[]')).toEqual(['hybrid'])
    expect([...new Uint8Array(row?.public_key ?? Buffer.alloc(0))]).toEqual([9, 9])
  })

  // ── F. beginLogin ───────────────────────────────────────────────────────────
  it('beginLogin stores a discoverable login challenge with null pending sub/handle', async () => {
    swa.generateAuthenticationOptions.mockResolvedValue({ challenge: 'chal-login-xyz' })

    const { challengeId } = await beginLogin()

    const row = getChallenge(challengeId)
    expect(row?.ceremony).toBe('login')
    expect(row?.challenge).toBe('chal-login-xyz')
    expect(row?.pending_sub).toBeNull()
    expect(row?.pending_handle).toBeNull()

    const arg = swa.generateAuthenticationOptions.mock.calls[0][0] as {
      allowCredentials: unknown[]
    }
    expect(arg.allowCredentials).toEqual([])
  })

  // ── G. verifyLogin happy path + counter bump ────────────────────────────────
  it('verifyLogin authenticates, bumps the counter, stamps last_used_at, and passes stored key', async () => {
    persistCredential(
      'local:01ARZ3NDEKTSV4RRFFQ69G5FAV',
      {
        id: 'cred-1',
        publicKey: new Uint8Array([4, 5, 6]),
        counter: 0,
        transports: ['internal'],
        backedUp: false,
      },
      null,
    )

    swa.generateAuthenticationOptions.mockResolvedValue({ challenge: 'chal-login-xyz' })
    const { challengeId } = await beginLogin()

    swa.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 7 },
    })

    const result = await verifyLogin(challengeId, { id: 'cred-1' } as AuthenticationResponseJSON)
    expect(result.sub).toBe('local:01ARZ3NDEKTSV4RRFFQ69G5FAV')

    const row = getCredential('cred-1')
    expect(row?.counter).toBe(7)
    expect(row?.last_used_at).not.toBeNull()

    // The crypto verifier received the STORED public key + counter.
    const arg = swa.verifyAuthenticationResponse.mock.calls[0][0] as {
      credential: { id: string; publicKey: Uint8Array; counter: number }
    }
    expect(arg.credential.id).toBe('cred-1')
    expect([...arg.credential.publicKey]).toEqual([4, 5, 6])
    expect(arg.credential.counter).toBe(0)
  })

  // ── H. verifyLogin failure paths ────────────────────────────────────────────
  it('verifyLogin throws challenge_invalid for an unknown challengeId', async () => {
    await expect(
      verifyLogin('nope', { id: 'cred-1' } as AuthenticationResponseJSON),
    ).rejects.toThrow('challenge_invalid')
  })

  it('verifyLogin throws credential_unknown when no stored credential matches response.id', async () => {
    swa.generateAuthenticationOptions.mockResolvedValue({ challenge: 'chal-login-xyz' })
    const { challengeId } = await beginLogin()

    await expect(
      verifyLogin(challengeId, { id: 'no-such-cred' } as AuthenticationResponseJSON),
    ).rejects.toThrow('credential_unknown')
    expect(swa.verifyAuthenticationResponse).not.toHaveBeenCalled()
  })

  it('verifyLogin throws authentication_unverified when the assertion does not verify', async () => {
    persistCredential(
      'local:01ARZ3NDEKTSV4RRFFQ69G5FAV',
      {
        id: 'cred-1',
        publicKey: new Uint8Array([1]),
        counter: 0,
        transports: [],
        backedUp: false,
      },
      null,
    )
    swa.generateAuthenticationOptions.mockResolvedValue({ challenge: 'chal-login-xyz' })
    const { challengeId } = await beginLogin()

    swa.verifyAuthenticationResponse.mockResolvedValue({ verified: false })

    await expect(
      verifyLogin(challengeId, { id: 'cred-1' } as AuthenticationResponseJSON),
    ).rejects.toThrow('authentication_unverified')
  })

  // ── I. sweepExpiredChallenges side-effect ───────────────────────────────────
  it('beginRegistration sweeps expired challenges while leaving the fresh one', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const older = new Date(Date.now() - 120_000).toISOString()
    insertChallengeRow({
      challenge_id: 'stale',
      challenge: 'chal-stale',
      ceremony: 'login',
      pending_sub: null,
      pending_handle: null,
      created_at: older,
      expires_at: past,
    })
    expect(getChallenge('stale')).toBeDefined()

    swa.generateRegistrationOptions.mockResolvedValue({ challenge: 'chal-fresh' })
    const { challengeId } = await beginRegistration('Chris')

    expect(getChallenge('stale')).toBeUndefined()
    expect(getChallenge(challengeId)).toBeDefined()
  })
})
