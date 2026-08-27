// setupState — real serverDb. What we lock: the verified-admin seal writes a
// one-way, first-wins ownership marker and rejects malformed identities.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'

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
import { markClaimed, sealVerifiedAdminOwnership } from './setupState.js'
import { addMember, isMember } from './members.js'

function claimedBy(): unknown {
  return serverDb()
    .raw.prepare(`SELECT value FROM server_state WHERE key = 'setup_claimed_by'`)
    .pluck()
    .get()
}

describe('setupState', () => {
  beforeAll(() => {
    serverDb()
  })
  beforeEach(() => {
    serverDb().raw.exec(
      `DELETE FROM members;
       DELETE FROM server_state WHERE key IN ('setup_token_hash','setup_claimed_by');`,
    )
  })
  afterAll(() => {
    closeServerDb()
    fs.rmSync(tmpDbDir, { recursive: true, force: true })
  })

  it('a proven admin login seals ownership without touching member rows', () => {
    sealVerifiedAdminOwnership('plex:42')
    expect(claimedBy()).toBe('plex:42')
    expect(isMember('plex:42')).toBeNull()
  })

  it('a proven legacy ADMINS login seals ownership without promoting its user row', () => {
    addMember({ sub: 'plex:42', displayName: 'legacy-owner', role: 'user', authMode: 'plex' })
    sealVerifiedAdminOwnership('plex:42')
    expect(claimedBy()).toBe('plex:42')
    expect(isMember('plex:42')).toMatchObject({ role: 'user', revoked_at: null })
  })

  it('rejects malformed identities and preserves first-owner provenance', () => {
    expect(() => sealVerifiedAdminOwnership('not-a-provider-sub')).toThrow(/sub_/)
    expect(claimedBy()).toBeUndefined()

    markClaimed('plex:42')
    sealVerifiedAdminOwnership('google:104223294318414512345')
    expect(claimedBy()).toBe('plex:42')
  })
})
