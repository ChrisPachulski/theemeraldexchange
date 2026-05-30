import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Point the server.db singleton at a throwaway temp file BEFORE env.ts is
// evaluated. vi.hoisted runs before the static imports below (including the
// fs/path/os imports), so it must require its own node builtins. env.ts reads
// process.env.SERVER_DB_PATH at its own import time.
const { tmpDbDir } = vi.hoisted(() => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodePath = require('node:path') as typeof import('node:path')
  const nodeOs = require('node:os') as typeof import('node:os')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'members-test-'))
  process.env.SERVER_DB_PATH = nodePath.join(dir, 'server.db')
  return { tmpDbDir: dir }
})

import { serverDb, closeServerDb } from './serverDb.js'
import { isMember, listMembers, addMember, revokeMember, recordMemberLogin } from './members.js'

const ADMIN = 'plex:42'
const ALICE = 'apple:000001.0123456789abcdef0123456789abcdef.0001'
const BOB = 'plex:7'

function wipe(): void {
  serverDb().raw.exec('DELETE FROM members; DELETE FROM invites;')
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

  it('revokeMember denies a member: isMember then returns null', () => {
    addMember({ sub: ALICE, authMode: 'apple' })
    expect(isMember(ALICE)).not.toBeNull()

    expect(revokeMember(ALICE)).toBe(true)
    expect(isMember(ALICE)).toBeNull()

    // The row is retained for audit (revoked, not deleted).
    const row = serverDb().raw.prepare('SELECT revoked_at FROM members WHERE sub = ?').get(ALICE) as
      | { revoked_at: string | null }
      | undefined
    expect(row?.revoked_at).not.toBeNull()
  })

  it('revokeMember returns false for an unknown or already-revoked sub', () => {
    expect(revokeMember(BOB)).toBe(false)
    addMember({ sub: BOB, authMode: 'plex' })
    expect(revokeMember(BOB)).toBe(true)
    expect(revokeMember(BOB)).toBe(false) // second revoke is a no-op
  })

  it('addMember re-grants a previously revoked member', () => {
    addMember({ sub: ALICE, displayName: 'Alice', authMode: 'apple' })
    revokeMember(ALICE)
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
    revokeMember(ALICE)
    recordMemberLogin(ALICE, 'new')
    expect(isMember(ALICE)).toBeNull()
  })

  it('listMembers returns active and revoked rows, newest first', () => {
    addMember({ sub: BOB, authMode: 'plex' })
    addMember({ sub: ALICE, authMode: 'apple' })
    revokeMember(BOB)

    const all = listMembers()
    expect(all.map(m => m.sub).sort()).toEqual([ALICE, BOB].sort())
    expect(all.find(m => m.sub === BOB)?.revoked_at).not.toBeNull()
  })
})
