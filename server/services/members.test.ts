import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'

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
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'members-test-'))
  process.env.SERVER_DB_PATH = nodePath.join(dir, 'server.db')
  return { tmpDbDir: dir }
})

import { serverDb, closeServerDb } from './serverDb.js'
import {
  isMember,
  listMembers,
  addMember,
  revokeMemberSafely,
  recordMemberLogin,
} from './members.js'

const ADMIN = 'plex:42'
const ALICE = 'apple:000001.0123456789abcdef0123456789abcdef.0001'
const BOB = 'plex:7'

function wipe(): void {
  serverDb().raw.exec('DELETE FROM members; DELETE FROM invites;')
}

function revokeForTest(sub: string): void {
  expect(
    revokeMemberSafely({
      targetSub: sub,
      actorSub: ADMIN,
      immutableAdminSubs: [ADMIN],
    }),
  ).toBe('revoked')
}

describe('members service', () => {
  beforeAll(() => {
    // Force the singleton open against the temp DB; applies migration 0003.
    serverDb()
  })
  afterAll(() => {
    closeServerDb()
    fs.rmSync(tmpDbDir, { recursive: true, force: true })
  })
  beforeEach(() => {
    wipe()
  })

  it('migration 0003 created the members + invites tables', () => {
    const tables = (
      serverDb()
        .raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all() as Array<{ name: string }>
    ).map(t => t.name)
    expect(tables).toContain('members')
    expect(tables).toContain('invites')
  })

  it('isMember returns null for an unknown sub', () => {
    expect(isMember(BOB)).toBeNull()
  })

  it('addMember creates an active member that isMember then returns', () => {
    const created = addMember({ sub: ALICE, displayName: 'Alice', authMode: 'apple', invitedBy: ADMIN })
    expect(created).not.toBeNull()
    expect(created?.sub).toBe(ALICE)
    expect(created?.role).toBe('user')
    expect(created?.revoked_at).toBeNull()

    const found = isMember(ALICE)
    expect(found).not.toBeNull()
    expect(found?.display_name).toBe('Alice')
    expect(found?.auth_mode).toBe('apple')
    expect(found?.invited_by).toBe(ADMIN)
  })

  it('addMember returns null when the sub is already an active member', () => {
    expect(addMember({ sub: BOB, authMode: 'plex' })).not.toBeNull()
    expect(addMember({ sub: BOB, authMode: 'plex' })).toBeNull()
  })

  it('addMember honors an explicit admin role', () => {
    const m = addMember({ sub: ADMIN, role: 'admin', authMode: 'plex' })
    expect(m?.role).toBe('admin')
  })

  it('addMember throws on a malformed sub (fail closed)', () => {
    expect(() => addMember({ sub: 'not-a-sub', authMode: 'plex' })).toThrow()
    expect(() => addMember({ sub: 'apple:BADHEX', authMode: 'apple' })).toThrow()
  })

  it('isMember rejects a malformed sub without touching the DB', () => {
    expect(isMember('garbage')).toBeNull()
  })

  describe('revokeMemberSafely', () => {
    it('protects an immutable configured owner before touching its row', () => {
      addMember({ sub: ADMIN, role: 'admin', authMode: 'plex' })
      const before = serverDb().raw.prepare(`SELECT * FROM members WHERE sub = ?`).get(ADMIN)

      expect(
        revokeMemberSafely({
          targetSub: ADMIN,
          actorSub: BOB,
          immutableAdminSubs: [ADMIN],
        }),
      ).toBe('owner')
      expect(serverDb().raw.prepare(`SELECT * FROM members WHERE sub = ?`).get(ADMIN)).toEqual(
        before,
      )
    })

    it('protects a DB-backed administrator from self-revocation', () => {
      addMember({ sub: ADMIN, role: 'admin', authMode: 'plex' })
      expect(
        revokeMemberSafely({
          targetSub: ADMIN,
          actorSub: ADMIN,
          immutableAdminSubs: [],
        }),
      ).toBe('self')
      expect(isMember(ADMIN)?.role).toBe('admin')
    })

    it('protects the final active DB-backed administrator', () => {
      addMember({ sub: ADMIN, role: 'admin', authMode: 'plex' })
      expect(
        revokeMemberSafely({
          targetSub: ADMIN,
          actorSub: BOB,
          immutableAdminSubs: [],
        }),
      ).toBe('final_admin')
      expect(isMember(ADMIN)?.role).toBe('admin')
    })

    it('serializes back-to-back admin revocations so the last authority remains', () => {
      addMember({ sub: ADMIN, role: 'admin', authMode: 'plex' })
      addMember({ sub: BOB, role: 'admin', authMode: 'plex' })

      expect(
        revokeMemberSafely({
          targetSub: ADMIN,
          actorSub: ALICE,
          immutableAdminSubs: [],
        }),
      ).toBe('revoked')
      expect(
        revokeMemberSafely({
          targetSub: BOB,
          actorSub: ALICE,
          immutableAdminSubs: [],
        }),
      ).toBe('final_admin')
      expect(isMember(ADMIN)).toBeNull()
      expect(isMember(BOB)?.role).toBe('admin')
    })

    it('revokes an ordinary member and reports absent/already-revoked uniformly', () => {
      addMember({ sub: BOB, role: 'user', authMode: 'plex' })
      const args = {
        targetSub: BOB,
        actorSub: ADMIN,
        immutableAdminSubs: [ADMIN],
      }
      expect(revokeMemberSafely(args)).toBe('revoked')
      expect(revokeMemberSafely(args)).toBe('not_found')
      expect(
        revokeMemberSafely({ ...args, targetSub: 'plex:999' }),
      ).toBe('not_found')
    })
  })

  it('addMember re-grants a previously revoked member', () => {
    addMember({ sub: ALICE, displayName: 'Alice', authMode: 'apple' })
    revokeForTest(ALICE)
    expect(isMember(ALICE)).toBeNull()

    const regranted = addMember({ sub: ALICE, displayName: 'Alice 2', authMode: 'apple' })
    expect(regranted).not.toBeNull()
    expect(regranted?.revoked_at).toBeNull()
    expect(isMember(ALICE)?.display_name).toBe('Alice 2')
  })

  it('recordMemberLogin updates display_name only for an active member', () => {
    addMember({ sub: ALICE, displayName: 'old', authMode: 'apple' })
    recordMemberLogin(ALICE, 'new')
    expect(isMember(ALICE)?.display_name).toBe('new')

    // null displayName never clobbers a stored value.
    recordMemberLogin(ALICE, null)
    expect(isMember(ALICE)?.display_name).toBe('new')
  })

  it('recordMemberLogin is a no-op for a non-member', () => {
    recordMemberLogin(BOB, 'whoever')
    expect(isMember(BOB)).toBeNull()
  })

  it('recordMemberLogin does not resurrect a revoked member', () => {
    addMember({ sub: ALICE, displayName: 'old', authMode: 'apple' })
    revokeForTest(ALICE)
    recordMemberLogin(ALICE, 'new')
    expect(isMember(ALICE)).toBeNull()
  })

  it('listMembers returns active and revoked rows, newest first', () => {
    addMember({ sub: BOB, authMode: 'plex' })
    addMember({ sub: ALICE, authMode: 'apple' })
    revokeForTest(BOB)

    const all = listMembers()
    expect(all.map(m => m.sub).sort()).toEqual([ALICE, BOB].sort())
    expect(all.find(m => m.sub === BOB)?.revoked_at).not.toBeNull()
  })
})
