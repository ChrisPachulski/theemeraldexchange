// setupState (plan 006 Phase 1) — real serverDb, real crypto. What we lock:
//   - claimable ⇔ no durable ownership gate AND unclaimed
//   - the boot mint stores only sha256; verify is constant-time and only
//     answers while claimable; markClaimed burns the hash
//   - the private-address gate (nginx-ui advisory: bind setup locally)

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const { tmpDbDir } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM init
  const nodeFs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM init
  const nodePath = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM init
  const nodeOs = require('node:os') as typeof import('node:os')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'setup-test-'))
  process.env.SERVER_DB_PATH = nodePath.join(dir, 'server.db')
  return { tmpDbDir: dir }
})

import { serverDb, closeServerDb } from './serverDb.js'
import {
  isClaimable,
  ensureSetupToken,
  verifySetupToken,
  markClaimed,
  isPrivateAddress,
} from './setupState.js'
import { addMember, revokeMemberSafely } from './members.js'
import { env } from '../env.js'

const OWNER = 'local:01ARZ3NDEKTSV4RRFFQ69G5FAV'
const envRw = env as unknown as Record<string, unknown>
const originalOwnershipEnv = {
  serverDbPath: env.SERVER_DB_PATH,
  plexServerId: env.plexServerId,
  adminSubs: env.adminSubs,
  appleClientId: env.appleClientId,
  googleClientIds: env.googleClientIds,
}

function wipe(): void {
  serverDb().raw.exec(
    `DELETE FROM members;
     DELETE FROM server_state WHERE key IN ('setup_token_hash','setup_claimed_by');`,
  )
}

/** The plaintext token the boot banner printed (read back from the 0600 file). */
function tokenFromFile(): string {
  const p = path.join(path.dirname(process.env.SERVER_DB_PATH!), '.setup-token')
  return fs.readFileSync(p, 'utf8').trim()
}

describe('setupState', () => {
  beforeAll(() => {
    serverDb()
  })
  beforeEach(() => {
    wipe()
    envRw.SERVER_DB_PATH = originalOwnershipEnv.serverDbPath
    envRw.plexServerId = null
    envRw.adminSubs = []
    envRw.appleClientId = null
    envRw.googleClientIds = []
  })

  afterAll(() => {
    envRw.SERVER_DB_PATH = originalOwnershipEnv.serverDbPath
    envRw.plexServerId = originalOwnershipEnv.plexServerId
    envRw.adminSubs = originalOwnershipEnv.adminSubs
    envRw.appleClientId = originalOwnershipEnv.appleClientId
    envRw.googleClientIds = originalOwnershipEnv.googleClientIds
    closeServerDb()
    fs.rmSync(tmpDbDir, { recursive: true, force: true })
  })

  it('fresh install is claimable; boot mints a token; the plaintext verifies', () => {
    expect(isClaimable()).toBe(true)
    ensureSetupToken()
    const token = tokenFromFile()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    // Only the sha256 is persisted.
    const row = serverDb()
      .raw.prepare(`SELECT value FROM server_state WHERE key = 'setup_token_hash'`)
      .get() as { value: string }
    expect(row.value).not.toBe(token)
    expect(verifySetupToken(token)).toBe(true)
    expect(verifySetupToken('0'.repeat(64))).toBe(false)
  })

  it('claim burns the token and closes the door', () => {
    ensureSetupToken()
    const token = tokenFromFile()
    addMember({ sub: OWNER, role: 'admin', authMode: 'local' })
    markClaimed(OWNER)
    expect(isClaimable()).toBe(false)
    expect(verifySetupToken(token)).toBe(false)
    // ensureSetupToken is a no-op once claimed — no new hash appears.
    ensureSetupToken()
    const hash = serverDb()
      .raw.prepare(`SELECT value FROM server_state WHERE key = 'setup_token_hash'`)
      .get()
    expect(hash).toBeUndefined()
  })

  it.each([
    ['active', false],
    ['revoked', true],
  ])('an %s members row ends claimability — the one-way door', (_state, revoke) => {
    ensureSetupToken()
    const token = tokenFromFile()
    addMember({ sub: OWNER, authMode: 'local' })
    if (revoke) {
      expect(
        revokeMemberSafely({
          targetSub: OWNER,
          actorSub: 'plex:999999999',
          actorUsername: 'setup-test-owner',
          immutableAdminSubs: ['plex:999999999'],
          legacyAdminUsernames: [],
        }),
      ).toBe('revoked')
    }
    expect(isClaimable()).toBe(false)
    ensureSetupToken()
    expect(verifySetupToken(token)).toBe(false)
  })

  it.each([
    ['Apple', () => { envRw.appleClientId = 'com.example.exchange' }],
    ['Google', () => { envRw.googleClientIds = ['web.example.apps.googleusercontent.com'] }],
  ])('%s configuration alone remains claimable', (_provider, configure) => {
    configure()
    expect(isClaimable()).toBe(true)
  })

  it.each([
    ['Plex server ownership gate', () => { envRw.plexServerId = 'home-machine' }],
    ['ADMIN_SUBS ownership gate', () => { envRw.adminSubs = ['plex:42'] }],
  ])('%s closes claimability', (_gate, configure) => {
    configure()
    expect(isClaimable()).toBe(false)
  })

  it('the explicit claimed marker closes claimability without provider config', () => {
    markClaimed(OWNER)
    expect(isClaimable()).toBe(false)
  })

  it('warns that configured identity providers still require a passkey claim', () => {
    envRw.appleClientId = 'SECRET-APPLE-ID'
    envRw.googleClientIds = ['SECRET-GOOGLE-ID']
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
      ensureSetupToken()
      const line = warn.mock.calls.flat().join(' ')
      expect(line).toContain('passkey')
      expect(line).toContain('setup token')
      expect(line).toContain('apple')
      expect(line).toContain('google')
      expect(line).not.toContain('SECRET-APPLE-ID')
      expect(line).not.toContain('SECRET-GOOGLE-ID')
      expect(line).not.toContain(tokenFromFile())
    } finally {
      warn.mockRestore()
      info.mockRestore()
    }
  })

  it('redacts the setup-token file path and raw write error from warnings', () => {
    envRw.appleClientId = 'SECRET-APPLE-ID'
    envRw.SERVER_DB_PATH = path.join(tmpDbDir, 'SECRET-DB-PATH', 'server.db')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
      ensureSetupToken()
      const line = warn.mock.calls.flat().join(' ')
      expect(line).toContain('setup token')
      expect(line).not.toContain('SECRET-APPLE-ID')
      expect(line).not.toContain('SECRET-DB-PATH')
      expect(line).not.toContain('ENOENT')
    } finally {
      warn.mockRestore()
      info.mockRestore()
    }
  })

  it('does not emit the provider warning after ownership is claimed', () => {
    envRw.appleClientId = 'SECRET-APPLE-ID'
    envRw.googleClientIds = ['SECRET-GOOGLE-ID']
    markClaimed(OWNER)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
      ensureSetupToken()
      expect(warn).not.toHaveBeenCalled()
      expect(info).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      info.mockRestore()
    }
  })

  it('re-boot while unclaimed rotates the token (old plaintext stops verifying)', () => {
    ensureSetupToken()
    const first = tokenFromFile()
    ensureSetupToken()
    const second = tokenFromFile()
    expect(second).not.toBe(first)
    expect(verifySetupToken(first)).toBe(false)
    expect(verifySetupToken(second)).toBe(true)
  })

  it('isPrivateAddress: loopback/RFC1918/CGNAT/v6-local in, public out', () => {
    for (const ok of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.50',
      '172.16.0.1',
      '172.31.255.255',
      '100.64.0.1', // tailnet / CGNAT
      '100.127.255.254',
      '169.254.10.10',
      '::1',
      '::ffff:192.168.1.2', // v4-mapped
      'fe80::1',
      'fd12:3456::1', // ULA
    ]) {
      expect(isPrivateAddress(ok), ok).toBe(true)
    }
    for (const bad of [
      '8.8.8.8',
      '100.128.0.1', // just past CGNAT
      '172.32.0.1', // just past RFC1918 /12
      '2001:4860:4860::8888',
      '203.0.113.7',
      '',
    ]) {
      expect(isPrivateAddress(bad), bad).toBe(false)
    }
  })
})
