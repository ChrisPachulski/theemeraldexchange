// server/services/membership.test.ts — branch coverage for memberStatus(),
// the single provider-agnostic authZ decision shared by the Plex + Apple
// login paths and the per-request session gate.
//
// env.ts builds `export const env = {...} as const` from process.env at
// module-evaluation time, so memberStatus's env-driven branches (ADMIN_SUBS,
// PLEX_SERVER_ID, APPLE_CLIENT_ID) cannot be flipped by mutating env.* at
// runtime. We use the env.test.ts idiom: mutate process.env, vi.resetModules(),
// then dynamically `import('./membership.js')` to bind a fresh module to the
// new env. SERVER_DB_PATH is held STABLE across re-imports so every freshly
// re-imported serverDb singleton reopens the SAME temp file — rows seeded via
// the statically-imported members.ts persist in the file, not module memory.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'

// Point the server.db singleton at a throwaway temp file BEFORE env.ts is
// evaluated, and clear the gate env vars so the file's default env is
// UN-bootstrapped except where a test opts in. vi.hoisted runs before the
// static imports below, so it must require its own node builtins.
const { tmpDbDir } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM init
  const nodeFs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM init
  const nodePath = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM init
  const nodeOs = require('node:os') as typeof import('node:os')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'membership-test-'))
  process.env.SERVER_DB_PATH = nodePath.join(dir, 'server.db')

  // Start UN-bootstrapped: no env gate configured. Tests opt into each gate.
  delete process.env.PLEX_SERVER_ID
  delete process.env.ADMIN_SUBS
  delete process.env.APPLE_CLIENT_ID
  delete process.env.ENABLE_APPLE_SIGN_IN
  return { tmpDbDir: dir }
})

import { serverDb, closeServerDb } from './serverDb.js'
import { addMember, revokeMember, isMember } from './members.js'
import { issueInvite } from './invites.js'

const ADMIN = 'plex:42'
const ALICE = 'apple:000001.0123456789abcdef0123456789abcdef.0001'
const BOB = 'plex:7'

function wipe(): void {
  serverDb().raw.exec('DELETE FROM members; DELETE FROM invites;')
}

/**
 * Apply env overrides, reset the module registry, and dynamically import a
 * fresh membership module bound to the new env. SERVER_DB_PATH is never
 * touched, so the re-imported serverDb reopens the same temp file and any
 * rows seeded beforehand (via the static members.ts) are still visible.
 */
async function importMembership(
  envOverrides: Record<string, string | undefined>,
): Promise<typeof import('./membership.js')> {
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  vi.resetModules()
  return await import('./membership.js')
}

describe('membership facade — memberStatus', () => {
  beforeAll(() => {
    // Force the singleton open against the temp DB; applies migration 0003.
    serverDb()
  })
  afterAll(() => {
    closeServerDb()
    fs.rmSync(tmpDbDir, { recursive: true, force: true })
  })
  beforeEach(() => {
    // Reset to UN-bootstrapped env between cases; individual tests opt in.
    delete process.env.PLEX_SERVER_ID
    delete process.env.ADMIN_SUBS
    delete process.env.APPLE_CLIENT_ID
    delete process.env.ENABLE_APPLE_SIGN_IN
    wipe()
  })

  // A) line-47 guard wins over the line-78 fall-through.
  it('malformed sub fails closed to not_member without a DB read', async () => {
    const m = await importMembership({})
    // Env is UN-bootstrapped and there are no members rows, so a VALID sub
    // would fall through to 'allowed'. An INVALID sub must short-circuit to
    // 'not_member' FIRST, proving the validity guard wins.
    expect(m.memberStatus('garbage')).toBe('not_member')
    expect(m.memberStatus('not-a-sub')).toBe('not_member')
  })

  // B) line-53 owner-bootstrap short-circuit, before any members row exists.
  it('ADMIN_SUBS sub is allowed before any members row exists', async () => {
    const m = await importMembership({ ADMIN_SUBS: ADMIN })
    // No members row inserted — ADMIN is allowed purely via env.adminSubs.
    expect(m.memberStatus(ADMIN)).toBe('allowed')
    // Configuring ADMIN_SUBS also bootstraps the gate, so a non-admin valid
    // sub with no row is now denied.
    expect(m.memberStatus(BOB)).toBe('not_member')
  })

  // C) line-61 active row → 'allowed'.
  it('active members row -> allowed', async () => {
    addMember({ sub: ALICE, authMode: 'apple' })
    const m = await importMembership({ ADMIN_SUBS: ADMIN })
    expect(m.memberStatus(ALICE)).toBe('allowed')
  })

  // D) line-61 revoked row → 'revoked' (the distinction members.isMember
  //    collapses to null).
  it('revoked members row -> revoked (not not_member)', async () => {
    addMember({ sub: ALICE, authMode: 'apple' })
    revokeMember(ALICE)
    const m = await importMembership({ ADMIN_SUBS: ADMIN })
    const status = m.memberStatus(ALICE)
    expect(status).toBe('revoked')
    // Explicitly: a revoked member is NOT the same verdict as a stranger.
    expect(status).not.toBe('not_member')
  })

  // E) line-77 bootstrapped + unknown sub → 'not_member'.
  it('unknown valid sub with a gate configured -> not_member', async () => {
    const m = await importMembership({ ADMIN_SUBS: ADMIN })
    expect(m.memberStatus(BOB)).toBe('not_member')
  })

  // F) line-78 UN-bootstrapped fall-through admits any valid sub.
  it('UN-bootstrapped install admits any valid sub (fall-through)', async () => {
    const m = await importMembership({
      PLEX_SERVER_ID: undefined,
      ADMIN_SUBS: undefined,
      APPLE_CLIENT_ID: undefined,
      ENABLE_APPLE_SIGN_IN: undefined,
    })
    expect(m.memberStatus(BOB)).toBe('allowed')
  })

  // G) isAuthzBootstrapped line-91: a single members row flips the install
  //    to bootstrapped even with zero env gate.
  it('a single members row flips the install to bootstrapped (fall-through gone)', async () => {
    addMember({ sub: ALICE, authMode: 'apple' }) // one row exists
    const m = await importMembership({}) // still no env gate
    // The lone members row makes isAuthzBootstrapped() true, so a stranger is
    // denied even though no env gate is set.
    expect(m.memberStatus(BOB)).toBe('not_member')
    // The seeded member itself is still allowed (it has an active row).
    expect(m.memberStatus(ALICE)).toBe('allowed')
  })

  // H) isAuthzBootstrapped line-88: PLEX_SERVER_ID alone bootstraps.
  it('PLEX_SERVER_ID alone bootstraps the gate', async () => {
    const m = await importMembership({ PLEX_SERVER_ID: 'machineid123' })
    expect(m.memberStatus(BOB)).toBe('not_member')
  })

  // I) isAuthzBootstrapped line-90: APPLE_CLIENT_ID alone bootstraps.
  it('APPLE_CLIENT_ID alone bootstraps the gate', async () => {
    const m = await importMembership({ APPLE_CLIENT_ID: 'com.example.app' })
    expect(m.memberStatus(BOB)).toBe('not_member')
  })

  // J) re-export passthrough: the invite-redeem surface is wired through the
  //    facade so callers can import authZ decision + membership-minting from
  //    one module.
  it('re-export: redeemInvite is callable through the facade and mints a member', async () => {
    const m = await importMembership({ ADMIN_SUBS: ADMIN })
    expect(typeof m.redeemInvite).toBe('function')

    // Prove the passthrough is actually wired: issue an invite, redeem it
    // through the facade, and confirm the member was minted.
    const { code } = issueInvite(ADMIN)
    const r = m.redeemInvite(code, BOB, 'Bob', 'plex')
    expect(r).toEqual({ ok: true, created: true })
    expect(isMember(BOB)).not.toBeNull()
    // And the freshly-minted member now reads as allowed via the facade.
    expect(m.memberStatus(BOB)).toBe('allowed')
  })
})
