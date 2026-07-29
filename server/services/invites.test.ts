import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'

// Point server.db at a throwaway temp file before env.ts evaluates. vi.hoisted
// runs before the static fs/path/os imports, so it requires its own builtins.
const { tmpDbDir } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM init
  const nodeFs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM init
  const nodePath = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM init
  const nodeOs = require('node:os') as typeof import('node:os')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'invites-test-'))
  process.env.SERVER_DB_PATH = nodePath.join(dir, 'server.db')
  return { tmpDbDir: dir }
})

import { serverDb, closeServerDb } from './serverDb.js'
import { issueInvite, redeemInvite, listInvites, revokeInvite } from './invites.js'
import { isMember } from './members.js'

const ADMIN = 'plex:42'
const ALICE = 'apple:000001.0123456789abcdef0123456789abcdef.0001'
const BOB = 'plex:7'
const CARL = 'plex:8'
const GABRIEL = 'google:118234567890123456789'

function wipe(): void {
  serverDb().raw.exec('DELETE FROM members; DELETE FROM invites;')
}

/** Read an invite row by the plaintext code's hash prefix (test helper). */
function inviteByPrefix(prefix: string): { used_count: number; max_uses: number } | undefined {
  return serverDb()
    .raw.prepare(`SELECT used_count, max_uses FROM invites WHERE code_hash LIKE ?`)
    .get(`${prefix}%`) as { used_count: number; max_uses: number } | undefined
}

describe('invites service', () => {
  beforeAll(() => {
    serverDb()
  })
  afterAll(() => {
    closeServerDb()
    fs.rmSync(tmpDbDir, { recursive: true, force: true })
  })
  beforeEach(() => {
    wipe()
  })

  it('issueInvite returns a 128-bit plaintext code shown once, stores only the hash', () => {
    const res = issueInvite(ADMIN, { label: "Mom's iPad" })
    // base64url of 16 random bytes ~= 22 chars, no padding.
    expect(res.code).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(res.code_hash_prefix).toMatch(/^[0-9a-f]{8}$/)
    expect(res.label).toBe("Mom's iPad")
    expect(res.max_uses).toBe(1)
    expect(res.expires_at).not.toBeNull()

    // No plaintext is persisted anywhere.
    const row = serverDb()
      .raw.prepare('SELECT code_hash FROM invites')
      .get() as { code_hash: string }
    expect(row.code_hash).not.toContain(res.code)
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('issueInvite generates distinct codes each call', () => {
    const a = issueInvite(ADMIN)
    const b = issueInvite(ADMIN)
    expect(a.code).not.toBe(b.code)
  })

  it('issueInvite throws on a malformed admin sub (fail closed)', () => {
    expect(() => issueInvite('garbage')).toThrow()
  })

  it('redeem of a valid code creates a member attributed to the issuing admin', () => {
    const { code } = issueInvite(ADMIN)
    const r = redeemInvite(code, ALICE, 'Alice', 'apple')
    expect(r).toEqual({ ok: true, created: true })

    const m = isMember(ALICE)
    expect(m).not.toBeNull()
    expect(m?.display_name).toBe('Alice')
    expect(m?.auth_mode).toBe('apple')
    expect(m?.role).toBe('user')
    // Verdict A7: invited_by was provisioned+indexed but hardcoded NULL —
    // the redeem must attribute the member to the invite's issuer.
    const row = serverDb()
      .raw.prepare(`SELECT invited_by FROM members WHERE sub = ?`)
      .get(ALICE) as { invited_by: string | null }
    expect(row.invited_by).toBe(ADMIN)
  })

  it('redeems an invite for a Google identity with its role and issuer intact', () => {
    const { code } = issueInvite(ADMIN)
    expect(redeemInvite(code, GABRIEL, 'Gabriel', 'google')).toEqual({
      ok: true,
      created: true,
    })

    expect(isMember(GABRIEL)).toMatchObject({
      sub: GABRIEL,
      display_name: 'Gabriel',
      role: 'user',
      auth_mode: 'google',
    })
    const row = serverDb()
      .raw.prepare(`SELECT invited_by FROM members WHERE sub = ?`)
      .get(GABRIEL) as { invited_by: string | null }
    expect(row.invited_by).toBe(ADMIN)
  })

  it('redeem of an unknown code is invalid and creates no member', () => {
    const r = redeemInvite('totally-bogus-code', BOB, null, 'plex')
    expect(r).toEqual({ ok: false, reason: 'invalid' })
    expect(isMember(BOB)).toBeNull()
  })

  it('single-use code is exhausted on the second distinct redeemer (reuse rejected)', () => {
    const { code, code_hash_prefix } = issueInvite(ADMIN, { maxUses: 1 })
    expect(redeemInvite(code, ALICE, null, 'apple')).toEqual({ ok: true, created: true })

    const second = redeemInvite(code, BOB, null, 'plex')
    expect(second).toEqual({ ok: false, reason: 'exhausted' })
    expect(isMember(BOB)).toBeNull()
    expect(inviteByPrefix(code_hash_prefix)?.used_count).toBe(1)
  })

  it('re-presenting a code by an already-active member is idempotent and burns no use', () => {
    const { code, code_hash_prefix } = issueInvite(ADMIN, { maxUses: 1 })
    expect(redeemInvite(code, ALICE, null, 'apple')).toEqual({ ok: true, created: true })

    // Same member redeems again — allowed, created:false, used_count unchanged.
    const again = redeemInvite(code, ALICE, null, 'apple')
    expect(again).toEqual({ ok: true, created: false })
    expect(inviteByPrefix(code_hash_prefix)?.used_count).toBe(1)
  })

  it('multi-use code admits up to max_uses distinct members', () => {
    const { code, code_hash_prefix } = issueInvite(ADMIN, { maxUses: 2 })
    expect(redeemInvite(code, ALICE, null, 'apple').ok).toBe(true)
    expect(redeemInvite(code, BOB, null, 'plex').ok).toBe(true)
    expect(redeemInvite(code, CARL, null, 'plex')).toEqual({ ok: false, reason: 'exhausted' })
    expect(inviteByPrefix(code_hash_prefix)?.used_count).toBe(2)
    expect(isMember(ALICE)).not.toBeNull()
    expect(isMember(BOB)).not.toBeNull()
    expect(isMember(CARL)).toBeNull()
  })

  it('expired code is rejected and creates no member', () => {
    const { code } = issueInvite(ADMIN, { expiresInDays: -1 }) // already expired
    const r = redeemInvite(code, ALICE, null, 'apple')
    expect(r).toEqual({ ok: false, reason: 'expired' })
    expect(isMember(ALICE)).toBeNull()
  })

  it('revoked invite is rejected', () => {
    const { code, code_hash_prefix } = issueInvite(ADMIN)
    expect(revokeInvite(code_hash_prefix)).toBe(true)
    expect(redeemInvite(code, ALICE, null, 'apple')).toEqual({ ok: false, reason: 'revoked' })
    expect(isMember(ALICE)).toBeNull()
  })

  it('redeem re-grants a previously revoked member (revoked member denied until re-invite)', () => {
    const first = issueInvite(ADMIN)
    expect(redeemInvite(first.code, ALICE, 'Alice', 'apple').ok).toBe(true)

    // Member revoked by an admin.
    serverDb().raw.prepare(`UPDATE members SET revoked_at = ? WHERE sub = ?`).run(new Date().toISOString(), ALICE)
    expect(isMember(ALICE)).toBeNull()

    // A fresh invite re-grants access and burns one of its uses.
    const second = issueInvite(ADMIN)
    const r = redeemInvite(second.code, ALICE, 'Alice', 'apple')
    expect(r).toEqual({ ok: true, created: true })
    expect(isMember(ALICE)).not.toBeNull()
    expect(inviteByPrefix(second.code_hash_prefix)?.used_count).toBe(1)
  })

  it('redeem rejects a malformed sub before any DB write', () => {
    const { code, code_hash_prefix } = issueInvite(ADMIN)
    expect(redeemInvite(code, 'not-a-sub', null, 'plex')).toEqual({ ok: false, reason: 'invalid' })
    expect(inviteByPrefix(code_hash_prefix)?.used_count).toBe(0)
  })

  it('listInvites never leaks the plaintext or full hash, and derives status', () => {
    const active = issueInvite(ADMIN, { label: 'active' })
    issueInvite(ADMIN, { label: 'expired', expiresInDays: -1 })
    const revoked = issueInvite(ADMIN, { label: 'revoked' })
    revokeInvite(revoked.code_hash_prefix)
    const exhausted = issueInvite(ADMIN, { label: 'exhausted', maxUses: 1 })
    redeemInvite(exhausted.code, ALICE, null, 'apple')

    const list = listInvites()
    const byLabel = (l: string) => list.find(i => i.label === l)

    expect(byLabel('active')?.status).toBe('active')
    expect(byLabel('expired')?.status).toBe('expired')
    expect(byLabel('revoked')?.status).toBe('revoked')
    expect(byLabel('exhausted')?.status).toBe('exhausted')

    for (const i of list) {
      expect(i.code_hash_prefix).toMatch(/^[0-9a-f]{8}$/)
      expect(i).not.toHaveProperty('code')
      expect(i).not.toHaveProperty('code_hash')
    }
    // The actual plaintext must never appear in the listing.
    const serialized = JSON.stringify(list)
    expect(serialized).not.toContain(active.code)
  })

  it('revokeInvite rejects ambiguous / unknown / already-revoked prefixes', () => {
    expect(revokeInvite('deadbeef')).toBe(false) // unknown
    const { code_hash_prefix } = issueInvite(ADMIN)
    expect(revokeInvite('')).toBe(false) // empty -> not valid hex
    expect(revokeInvite('XYZ')).toBe(false) // non-hex
    expect(revokeInvite(code_hash_prefix)).toBe(true)
    expect(revokeInvite(code_hash_prefix)).toBe(false) // already revoked
  })

  it('concurrent-ish double redeem of a single-use code yields exactly one member', () => {
    // Sequential calls within the same process exercise the used_count guard.
    const { code, code_hash_prefix } = issueInvite(ADMIN, { maxUses: 1 })
    const r1 = redeemInvite(code, ALICE, null, 'apple')
    const r2 = redeemInvite(code, BOB, null, 'plex')
    const successes = [r1, r2].filter(r => r.ok && r.created).length
    expect(successes).toBe(1)
    expect(inviteByPrefix(code_hash_prefix)?.used_count).toBe(1)
  })
})
