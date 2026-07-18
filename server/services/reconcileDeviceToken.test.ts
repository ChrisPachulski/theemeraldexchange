import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'

// Point the server.db singleton at a throwaway temp file BEFORE env.ts is
// evaluated. vi.hoisted runs before the static imports below (including the
// fs/path/os imports), so it must require its own node builtins. env.ts reads
// process.env.SERVER_DB_PATH at its own import time. We also delete every gate
// env var so the install starts UN-bootstrapped — individual tests opt back
// into a configured gate via importReconcile(overrides).
const { tmpDbDir } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM init
  const nodeFs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM init
  const nodePath = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM init
  const nodeOs = require('node:os') as typeof import('node:os')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'reconcile-device-test-'))
  process.env.SERVER_DB_PATH = nodePath.join(dir, 'server.db')
  delete process.env.PLEX_SERVER_ID
  delete process.env.ADMIN_SUBS
  delete process.env.ADMINS
  delete process.env.APPLE_CLIENT_ID
  delete process.env.ENABLE_APPLE_SIGN_IN
  return { tmpDbDir: dir }
})

import { serverDb, closeServerDb } from './serverDb.js'
import { addMember, revokeMemberSafely } from './members.js'
import type { DeviceTokenClaims } from '../session.js'

type ReconcileModule = typeof import('./reconcileDeviceToken.js')

// Re-import reconcileDeviceToken.js so its captured `env` (and the membership
// facade it calls) observe the freshly-set gate env vars. SERVER_DB_PATH is
// NEVER touched here, so the re-imported serverDb reopens the SAME temp file
// and every seeded row persists across the reset.
async function importReconcile(
  envOverrides: Record<string, string | undefined> = {},
): Promise<ReconcileModule> {
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  vi.resetModules()
  return await import('./reconcileDeviceToken.js')
}

const ADMIN_SUB = 'plex:42'
const OTHER_ADMIN = 'plex:9999'

function makeClaims(jti: string, sub: string, overrides: Partial<DeviceTokenClaims> = {}): DeviceTokenClaims {
  return {
    aud: 'device',
    iss: 'eex',
    sub,
    role: 'user',
    auth_mode: 'plex',
    device_id: 'dev-' + jti,
    device_platform: 'ios',
    server_id: 'srv',
    jti,
    iat: 1_700_000_000,
    nbf: 1_700_000_000,
    exp: 1_700_000_000 + 180 * 24 * 60 * 60,
    ...overrides,
  }
}

function seedDeviceToken(jti: string, sub: string, deviceName = 'iPhone', username: string | null = null): void {
  serverDb()
    .raw.prepare(
      `INSERT INTO device_tokens
         (jti, sub, device_id, device_name, username, platform, server_id, issued_at, expires_at, last_seen_at, last_seen_version)
       VALUES (?, ?, ?, ?, ?, 'ios', 'srv', datetime('now'), datetime('now','+180 day'), NULL, NULL)`,
    )
    .run(jti, sub, 'dev-' + jti, deviceName, username)
}

function tokenRow(jti: string): { last_seen_at: string | null; last_seen_version: string | null } | undefined {
  return serverDb()
    .raw.prepare(`SELECT last_seen_at, last_seen_version FROM device_tokens WHERE jti = ?`)
    .get(jti) as { last_seen_at: string | null; last_seen_version: string | null } | undefined
}

function revocation(jti: string): { reason: string } | undefined {
  return serverDb()
    .raw.prepare(`SELECT reason FROM device_token_revocations WHERE jti = ?`)
    .get(jti) as { reason: string } | undefined
}

function revocationCount(): number {
  return (
    serverDb()
      .raw.prepare(`SELECT COUNT(*) AS n FROM device_token_revocations`)
      .get() as { n: number }
  ).n
}

describe('reconcileDeviceToken', () => {
  beforeAll(() => {
    // Force the singleton open against the temp DB; applies all migrations
    // (incl. 0002 device_tokens + 0003 members/invites).
    serverDb()
  })
  afterAll(() => {
    closeServerDb()
    fs.rmSync(tmpDbDir, { recursive: true, force: true })
    // Restore the shared process.env + module registry so this file's gate-env
    // mutations (set via importReconcile) cannot leak into sibling test files
    // that Vitest co-locates in the same worker — the source of the prior
    // intermittent failures in devices.test.ts.
    delete process.env.PLEX_SERVER_ID
    delete process.env.ADMIN_SUBS
    delete process.env.ADMINS
    delete process.env.APPLE_CLIENT_ID
    delete process.env.ENABLE_APPLE_SIGN_IN
    vi.resetModules()
  })
  beforeEach(() => {
    delete process.env.PLEX_SERVER_ID
    delete process.env.ADMIN_SUBS
    delete process.env.ADMINS
    delete process.env.APPLE_CLIENT_ID
    delete process.env.ENABLE_APPLE_SIGN_IN
    serverDb().raw.exec(
      'DELETE FROM device_tokens; DELETE FROM device_token_revocations; DELETE FROM members; DELETE FROM invites;',
    )
  })

  it('migration 0002 created the device_tokens + device_token_revocations tables', () => {
    const tables = (
      serverDb()
        .raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all() as Array<{ name: string }>
    ).map(t => t.name)
    expect(tables).toContain('device_tokens')
    expect(tables).toContain('device_token_revocations')
  })

  // A) ALLOWED PATH — happy reconcile.
  it('allowed sub: touches last_seen_at/version and returns claims + device_name', async () => {
    const { reconcileDeviceToken } = await importReconcile({ ADMIN_SUBS: ADMIN_SUB })
    seedDeviceToken('jti-A', ADMIN_SUB, 'Chris iPhone')

    const result = reconcileDeviceToken(makeClaims('jti-A', ADMIN_SUB, { role: 'admin' }), 'app-1.2.3')

    expect(result).not.toBeNull()
    expect(result?.device_name).toBe('Chris iPhone')
    expect(result?.sub).toBe(ADMIN_SUB)
    expect(result?.role).toBe('admin')
    expect(result?.jti).toBe('jti-A')

    const row = tokenRow('jti-A')
    expect(row?.last_seen_at).not.toBeNull()
    expect(row?.last_seen_version).toBe('app-1.2.3')
  })

  // B) ALLOWED PATH — appVersion null preserves prior last_seen_version (COALESCE).
  it('allowed sub with null appVersion: COALESCE keeps the prior version, refreshes last_seen_at', async () => {
    const { reconcileDeviceToken } = await importReconcile({ ADMIN_SUBS: ADMIN_SUB })
    seedDeviceToken('jti-B', ADMIN_SUB)
    serverDb().raw.prepare(`UPDATE device_tokens SET last_seen_version = 'old-ver' WHERE jti = ?`).run('jti-B')

    const result = reconcileDeviceToken(makeClaims('jti-B', ADMIN_SUB), null)

    expect(result).not.toBeNull()
    const row = tokenRow('jti-B')
    expect(row?.last_seen_version).toBe('old-ver')
    expect(row?.last_seen_at).not.toBeNull()
  })

  it('recomputes admin role from the stored pairing username on every request', async () => {
    const { reconcileDeviceToken } = await importReconcile({
      ADMIN_SUBS: OTHER_ADMIN,
      ADMINS: 'admin-user',
    })
    const sub = 'plex:7'
    addMember({ sub, authMode: 'plex' })
    seedDeviceToken('jti-role-admin', sub, 'Chris iPhone', 'admin-user')

    const result = reconcileDeviceToken(makeClaims('jti-role-admin', sub, { role: 'user' }), null)

    expect(result?.role).toBe('admin')
  })

  it('promotes and demotes a DB-backed admin role without trusting the token claim', async () => {
    const { reconcileDeviceToken } = await importReconcile({ ADMIN_SUBS: OTHER_ADMIN })
    const sub = 'local:01ARZ3NDEKTSV4RRFFQ69G5FAV'
    addMember({ sub, role: 'admin', authMode: 'local' })
    seedDeviceToken('jti-db-admin', sub, 'Owner passkey')

    const promoted = reconcileDeviceToken(
      makeClaims('jti-db-admin', sub, { role: 'user', auth_mode: 'local' }),
      null,
    )
    expect(promoted?.role).toBe('admin')

    serverDb().raw.prepare(`UPDATE members SET role = 'user' WHERE sub = ?`).run(sub)
    const demoted = reconcileDeviceToken(
      makeClaims('jti-db-admin', sub, { role: 'admin', auth_mode: 'local' }),
      null,
    )
    expect(demoted?.role).toBe('user')
  })

  it('fails closed to user for legacy rows without a stored username', async () => {
    const { reconcileDeviceToken } = await importReconcile({
      ADMIN_SUBS: OTHER_ADMIN,
      ADMINS: 'admin-user',
    })
    const sub = 'plex:8'
    addMember({ sub, authMode: 'plex' })
    seedDeviceToken('jti-role-legacy', sub)

    const result = reconcileDeviceToken(makeClaims('jti-role-legacy', sub, { role: 'admin' }), null)

    expect(result?.role).toBe('user')
  })

  // C) ALLOWED PATH — jti row vanished → returns null, no revocation written.
  it('allowed sub but no matching jti row: returns null and writes NO revocation', async () => {
    const { reconcileDeviceToken } = await importReconcile({ ADMIN_SUBS: ADMIN_SUB })
    // Seed a DIFFERENT jti for the same sub; the claims jti has no row.
    seedDeviceToken('jti-present', ADMIN_SUB)

    const result = reconcileDeviceToken(makeClaims('jti-missing', ADMIN_SUB), 'app-9')

    expect(result).toBeNull()
    expect(revocationCount()).toBe(0)
  })

  // D) REVOKED MEMBER → null + cascade revoke with reason 'member_revoked'.
  it('revoked member: returns null and cascade-revokes ALL of the sub\'s tokens as member_revoked', async () => {
    // Configure a gate (ADMIN_SUBS for a DIFFERENT sub) so the install is
    // bootstrapped and this sub is NOT an implicit admin.
    const { reconcileDeviceToken } = await importReconcile({ ADMIN_SUBS: OTHER_ADMIN })
    const sub = 'plex:7'
    addMember({ sub, authMode: 'plex' })
    expect(
      revokeMemberSafely({
        targetSub: sub,
        actorSub: OTHER_ADMIN,
        immutableAdminSubs: [OTHER_ADMIN],
      }),
    ).toBe('revoked')
    seedDeviceToken('jti-D1', sub)
    seedDeviceToken('jti-D2', sub)

    const result = reconcileDeviceToken(makeClaims('jti-D1', sub), 'app-1')

    expect(result).toBeNull()
    expect(revocationCount()).toBe(2)
    expect(revocation('jti-D1')?.reason).toBe('member_revoked')
    expect(revocation('jti-D2')?.reason).toBe('member_revoked')
  })

  // E) NON-MEMBER under a configured gate → null + cascade with reason 'not_member'.
  it('non-member under a configured gate: returns null and revokes the token as not_member', async () => {
    const { reconcileDeviceToken } = await importReconcile({ ADMIN_SUBS: OTHER_ADMIN })
    const sub = 'plex:5150' // no members row, not in ADMIN_SUBS
    seedDeviceToken('jti-E', sub)

    const result = reconcileDeviceToken(makeClaims('jti-E', sub), 'app-1')

    expect(result).toBeNull()
    expect(revocation('jti-E')?.reason).toBe('not_member')
  })

  // F) cascadeRevokeForSub unit, direct.
  it('cascadeRevokeForSub revokes exactly the sub\'s tokens, is idempotent, and returns 0 for nobody', async () => {
    const { cascadeRevokeForSub } = await importReconcile({})
    seedDeviceToken('x1', 'plex:X')
    seedDeviceToken('x2', 'plex:X')
    seedDeviceToken('x3', 'plex:X')
    seedDeviceToken('y1', 'plex:Y')

    expect(cascadeRevokeForSub('plex:X', 'member_revoked')).toBe(3)
    expect(revocationCount()).toBe(3)
    expect(revocation('x1')?.reason).toBe('member_revoked')
    expect(revocation('x2')?.reason).toBe('member_revoked')
    expect(revocation('x3')?.reason).toBe('member_revoked')
    expect(revocation('y1')).toBeUndefined()

    // Idempotent: re-running still reports 3 tokens and INSERT OR IGNORE
    // neither duplicates nor throws.
    expect(cascadeRevokeForSub('plex:X', 'member_revoked')).toBe(3)
    expect(revocationCount()).toBe(3)

    // No tokens for the sub → 0, nothing added.
    expect(cascadeRevokeForSub('plex:NOBODY', 'not_member')).toBe(0)
    expect(revocationCount()).toBe(3)
  })

  // G) ALLOWED via ADMIN_SUBS short-circuit even with NO members row.
  it('ADMIN_SUBS short-circuit: allowed with no members row, refreshes last_seen, no revocation', async () => {
    const { reconcileDeviceToken } = await importReconcile({ ADMIN_SUBS: ADMIN_SUB })
    // No addMember call — the sub is allowed purely via ADMIN_SUBS bootstrap.
    seedDeviceToken('jti-G', ADMIN_SUB)

    const result = reconcileDeviceToken(makeClaims('jti-G', ADMIN_SUB, { role: 'admin' }), 'app-2')

    expect(result).not.toBeNull()
    const row = tokenRow('jti-G')
    expect(row?.last_seen_at).not.toBeNull()
    expect(row?.last_seen_version).toBe('app-2')
    expect(revocationCount()).toBe(0)
  })
})
