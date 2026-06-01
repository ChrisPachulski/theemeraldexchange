// Route-level coverage for the owner-only invites + members management
// surface (server/routes/adminInvites.ts). The service layer
// (services/invites.ts, services/members.ts) is already well-tested; the GAP
// this file closes is the HTTP layer that sits on top:
//
//   - requireAdmin gating on BOTH routers (401 unauth, 403 admin_only),
//   - the POST /invites input-validation branches (label / expiresInDays /
//     maxUses type + range checks) that live ONLY in the route,
//   - the members owner-protection (cannot_revoke_owner) and the
//     ADMIN_SUBS-synthesis branch in GET /members.
//
// Pattern mirrors server/routes/plex-admin.test.ts (standalone Hono mount +
// session cookies) and server/services/invites.test.ts (throwaway temp DB).
//
// IMPORTANT — env MUST be set BEFORE the server modules are imported, because
// env.ts and serverDb.ts read process.env at module-evaluation time. We set
// SERVER_DB_PATH + ADMIN_SUBS first, then load every server module via a
// top-level `await import` so they observe the env we just wrote. (vi.hoisted
// is the alternative used by invites.test.ts; top-level dynamic import is the
// same idea without needing require() inside the hoisted block.)

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// Type-only import: erased at compile time, so it does NOT evaluate the module
// at runtime and is safe to place before the env bootstrap below.
import type { Env } from '../middleware/auth.js'

// --- env bootstrap, BEFORE any server module import ------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-invites-test-'))
process.env.SERVER_DB_PATH = path.join(tmpDir, 'server.db')
process.env.ADMIN_SUBS = 'plex:42'

// Dynamic imports so the modules read the env set above. Hono is imported the
// same way purely to keep all "load after env" imports in one place.
const { serverDb, closeServerDb } = await import('../services/serverDb.js')
const { adminInvites, adminMembers } = await import('./adminInvites.js')
const { createSession } = await import('../session.js')
const { Hono } = await import('hono')

const ADMIN_SUB = 'plex:42' // matches ADMIN_SUBS → memberStatus 'allowed' + role 'admin'
const USER_SUB = 'plex:7' // an ordinary active member → role 'user'

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/invites', adminInvites)
  app.route('/members', adminMembers)
  return app
}

// Admin cookie: sub === ADMIN_SUBS so requireAdmin → reconcileSession →
// memberStatus short-circuits 'allowed' and roleFor returns 'admin'.
// plexAuthToken is deliberately undefined so reconcileSession never probes
// plex.tv (it returns early when !session.plexAuthToken) — no fetch stub needed.
async function adminCookie() {
  return `eex.session=${await createSession({ sub: ADMIN_SUB, username: 'owner', role: 'admin' })}`
}

// Authenticated NON-admin: USER_SUB has an active members row so memberStatus
// returns 'allowed' (request reaches the handler) but roleFor returns 'user'
// (not in ADMIN_SUBS) → a real 403 admin_only, not a 401.
async function userCookie() {
  return `eex.session=${await createSession({ sub: USER_SUB, username: 'guest', role: 'user' })}`
}

/** Insert an active (non-revoked) member row directly. */
function insertActiveMember(sub: string, role: 'admin' | 'user' = 'user'): void {
  serverDb()
    .raw.prepare(
      `INSERT INTO members (sub, display_name, role, auth_mode, invited_by, joined_at, revoked_at)
       VALUES (?, ?, ?, 'plex', NULL, ?, NULL)`,
    )
    .run(sub, null, role, new Date().toISOString())
}

type InviteSummary = {
  code_hash_prefix: string
  label: string | null
  status: 'active' | 'expired' | 'revoked' | 'exhausted'
  max_uses: number
  used_count: number
  expires_at: string | null
}
type CreatedInvite = {
  code: string
  code_hash_prefix: string
  label: string | null
  max_uses: number
  expires_at: string | null
}
type MemberView = {
  sub: string
  display_name: string | null
  role: 'admin' | 'user'
  auth_mode: 'plex' | 'local' | 'apple'
  revoked_at: string | null
  is_admin: boolean
}

/** Issue an invite via the route and return the parsed CreatedInvite. */
async function issueViaRoute(body?: Record<string, unknown>): Promise<CreatedInvite> {
  const res = await appUnderTest().request('/invites', {
    method: 'POST',
    headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as CreatedInvite
}

async function listInvitesViaRoute(): Promise<InviteSummary[]> {
  const res = await appUnderTest().request('/invites', { headers: { Cookie: await adminCookie() } })
  expect(res.status).toBe(200)
  return ((await res.json()) as { invites: InviteSummary[] }).invites
}

async function listMembersViaRoute(): Promise<MemberView[]> {
  const res = await appUnderTest().request('/members', { headers: { Cookie: await adminCookie() } })
  expect(res.status).toBe(200)
  return ((await res.json()) as { members: MemberView[] }).members
}

describe('admin invites + members routes', () => {
  beforeAll(() => {
    serverDb() // run migrations against the throwaway DB
  })

  afterAll(() => {
    // IR-3 leak-guard: this suite MUTATES process.env (ADMIN_SUBS,
    // SERVER_DB_PATH) to bootstrap an isolated admin + temp DB. If we leave
    // those set, sibling suites in the same vitest worker inherit a phantom
    // ADMIN_SUBS owner and a stale DB path — the exact cross-suite-leak class
    // commits cea20ce / 8d1d418 fixed. Restore the env, close the DB handle,
    // and delete the temp dir so no state escapes this file.
    delete process.env.ADMIN_SUBS
    delete process.env.SERVER_DB_PATH
    closeServerDb()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    serverDb().raw.exec('DELETE FROM members; DELETE FROM invites;')
  })

  // -------------------------------------------------------------------------
  // A) Auth gates — both routers, mirroring plex-admin's gate tests.
  // -------------------------------------------------------------------------
  describe('auth gates', () => {
    it('GET /invites with no cookie → 401 unauthenticated', async () => {
      const r = await appUnderTest().request('/invites')
      expect(r.status).toBe(401)
      expect((await r.json()) as { error: string }).toEqual({ error: 'unauthenticated' })
    })

    it('GET /invites as an authenticated non-admin → 403 admin_only', async () => {
      insertActiveMember(USER_SUB) // make memberStatus 'allowed' so we reach the role gate
      const r = await appUnderTest().request('/invites', {
        headers: { Cookie: await userCookie() },
      })
      expect(r.status).toBe(403)
      expect((await r.json()) as { error: string; reason: string }).toEqual({
        error: 'forbidden',
        reason: 'admin_only',
      })
    })

    it('POST /invites with no cookie → 401 (write path is gated too)', async () => {
      const r = await appUnderTest().request('/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(r.status).toBe(401)
    })

    it('GET /members with no cookie → 401; as non-admin → 403 admin_only', async () => {
      const noCookie = await appUnderTest().request('/members')
      expect(noCookie.status).toBe(401)

      insertActiveMember(USER_SUB)
      const asUser = await appUnderTest().request('/members', {
        headers: { Cookie: await userCookie() },
      })
      expect(asUser.status).toBe(403)
      expect((await asUser.json()) as { reason: string }).toMatchObject({ reason: 'admin_only' })
    })

    it('DELETE /members/:sub as a non-admin → 403 (gate runs before the handler)', async () => {
      insertActiveMember(USER_SUB)
      const r = await appUnderTest().request('/members/plex:99', {
        method: 'DELETE',
        headers: { Cookie: await userCookie() },
      })
      expect(r.status).toBe(403)
      expect((await r.json()) as { reason: string }).toMatchObject({ reason: 'admin_only' })
    })
  })

  // -------------------------------------------------------------------------
  // B) POST /invites — input validation branches (route-only logic).
  // -------------------------------------------------------------------------
  describe('POST /invites — validation + defaults', () => {
    it('empty body → 201 with a one-time code, hash prefix, default max_uses + 14-day expiry', async () => {
      const created = await issueViaRoute()
      expect(created.code).toMatch(/^[A-Za-z0-9_-]{22}$/)
      expect(created.code_hash_prefix).toMatch(/^[0-9a-f]{8}$/)
      expect(created.max_uses).toBe(1)
      expect(created.expires_at).not.toBeNull()

      // Visible in the listing as an active, never-used invite — proves the
      // session sub was threaded into issued_by (otherwise the insert/list
      // would have failed on a bad admin sub).
      const list = await listInvitesViaRoute()
      const found = list.find((i) => i.code_hash_prefix === created.code_hash_prefix)
      expect(found?.status).toBe('active')
      expect(found?.used_count).toBe(0)
    })

    it('full valid body → 201 with trimmed label and pass-through maxUses', async () => {
      const created = await issueViaRoute({ label: "  Mom's iPad  ", expiresInDays: 30, maxUses: 3 })
      expect(created.label).toBe("Mom's iPad") // trimmed
      expect(created.max_uses).toBe(3)
      expect(created.expires_at).not.toBeNull()
    })

    it('non-string label → 400 invalid_body mentioning label', async () => {
      const r = await appUnderTest().request('/invites', {
        method: 'POST',
        headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 123 }),
      })
      expect(r.status).toBe(400)
      const body = (await r.json()) as { error: string; message: string }
      expect(body.error).toBe('invalid_body')
      expect(body.message).toContain('label')
    })

    it('non-number expiresInDays → 400; explicit null expiresInDays → 201 with no expiry', async () => {
      const bad = await appUnderTest().request('/invites', {
        method: 'POST',
        headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresInDays: 'soon' }),
      })
      expect(bad.status).toBe(400)
      const badBody = (await bad.json()) as { error: string; message: string }
      expect(badBody.error).toBe('invalid_body')
      expect(badBody.message).toContain('expiresInDays')

      // null is a DISTINCT branch from the 14-day default: it disables expiry.
      const created = await issueViaRoute({ expiresInDays: null })
      expect(created.expires_at).toBeNull()
    })

    it('maxUses 0 and 1.5 → 400 mentioning maxUses', async () => {
      for (const maxUses of [0, 1.5]) {
        const r = await appUnderTest().request('/invites', {
          method: 'POST',
          headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ maxUses }),
        })
        expect(r.status).toBe(400)
        const body = (await r.json()) as { error: string; message: string }
        expect(body.error).toBe('invalid_body')
        expect(body.message).toContain('maxUses')
      }
    })

    it('explicit null label → 201 with label null (distinct from the invalid-type branch)', async () => {
      const created = await issueViaRoute({ label: null })
      expect(created.label).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // C) DELETE /invites/:prefix — revoke lifecycle.
  // -------------------------------------------------------------------------
  describe('DELETE /invites/:prefix', () => {
    it('revokes an issued invite → 200 ok, then shows as revoked in the listing', async () => {
      const created = await issueViaRoute()
      const del = await appUnderTest().request(`/invites/${created.code_hash_prefix}`, {
        method: 'DELETE',
        headers: { Cookie: await adminCookie() },
      })
      expect(del.status).toBe(200)
      expect((await del.json()) as { ok: boolean }).toEqual({ ok: true })

      const list = await listInvitesViaRoute()
      expect(list.find((i) => i.code_hash_prefix === created.code_hash_prefix)?.status).toBe(
        'revoked',
      )
    })

    it('unknown prefix → 404 not_found', async () => {
      const r = await appUnderTest().request('/invites/deadbeef', {
        method: 'DELETE',
        headers: { Cookie: await adminCookie() },
      })
      expect(r.status).toBe(404)
      expect((await r.json()) as { error: string }).toEqual({ error: 'not_found' })
    })

    it('double-revoke → second call is 404 (already revoked)', async () => {
      const created = await issueViaRoute()
      const first = await appUnderTest().request(`/invites/${created.code_hash_prefix}`, {
        method: 'DELETE',
        headers: { Cookie: await adminCookie() },
      })
      expect(first.status).toBe(200)
      const second = await appUnderTest().request(`/invites/${created.code_hash_prefix}`, {
        method: 'DELETE',
        headers: { Cookie: await adminCookie() },
      })
      expect(second.status).toBe(404)
    })
  })

  // -------------------------------------------------------------------------
  // D) GET /members — synthesis + is_admin view flag.
  // -------------------------------------------------------------------------
  describe('GET /members — synthesis', () => {
    it('synthesizes the ADMIN_SUBS owner row when the members table is empty', async () => {
      const members = await listMembersViaRoute()
      const owner = members.find((m) => m.sub === ADMIN_SUB)
      expect(owner).toBeDefined()
      expect(owner?.is_admin).toBe(true)
      expect(owner?.role).toBe('admin')
      expect(owner?.auth_mode).toBe('plex') // plex:42 → 'plex' (apple: → 'apple')
    })

    it('returns both a real member and the synthesized owner without double-adding', async () => {
      insertActiveMember(USER_SUB, 'user')
      const members = await listMembersViaRoute()

      const real = members.find((m) => m.sub === USER_SUB)
      expect(real?.is_admin).toBe(false)

      const owner = members.find((m) => m.sub === ADMIN_SUB)
      expect(owner?.is_admin).toBe(true)

      // The owner sub appears exactly once (not double-added).
      expect(members.filter((m) => m.sub === ADMIN_SUB)).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // E) DELETE /members/:sub — owner protection + revoke.
  // -------------------------------------------------------------------------
  describe('DELETE /members/:sub — owner protection', () => {
    it('refuses to revoke the ADMIN_SUBS owner → 409 cannot_revoke_owner', async () => {
      const r = await appUnderTest().request(`/members/${ADMIN_SUB}`, {
        method: 'DELETE',
        headers: { Cookie: await adminCookie() },
      })
      expect(r.status).toBe(409)
      expect((await r.json()) as { error: string }).toEqual({ error: 'cannot_revoke_owner' })

      // Owner is implicit — no row should have been written for it.
      const row = serverDb().raw.prepare('SELECT 1 FROM members WHERE sub = ?').get(ADMIN_SUB)
      expect(row).toBeUndefined()
    })

    it('revokes an ordinary member → 200; the row is retained with revoked_at set', async () => {
      insertActiveMember(USER_SUB, 'user')
      const del = await appUnderTest().request(`/members/${USER_SUB}`, {
        method: 'DELETE',
        headers: { Cookie: await adminCookie() },
      })
      expect(del.status).toBe(200)
      expect((await del.json()) as { ok: boolean }).toEqual({ ok: true })

      const members = await listMembersViaRoute()
      const revoked = members.find((m) => m.sub === USER_SUB)
      expect(revoked).toBeDefined() // retained for audit, not removed
      expect(revoked?.revoked_at).not.toBeNull()
    })

    it('revoking a non-existent member → 404 not_found', async () => {
      const r = await appUnderTest().request('/members/plex:8', {
        method: 'DELETE',
        headers: { Cookie: await adminCookie() },
      })
      expect(r.status).toBe(404)
      expect((await r.json()) as { error: string }).toEqual({ error: 'not_found' })
    })
  })
})
