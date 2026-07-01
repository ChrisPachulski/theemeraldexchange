import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Hono } from 'hono'
import { policy, adminPolicy } from './policy.js'
import { sonarr } from './sonarr.js'
import { sab } from './sab.js'
import { createSession } from '../session.js'
import {
  _setUserPoliciesPathForTests,
  getPolicy,
  setPolicy,
  type Policy,
} from '../services/userPolicies.js'
import { __resetRateLimitsForTests } from '../middleware/rateLimit.js'
import type { Env } from '../middleware/auth.js'

// Caller-facing router at /api/policy plus the admin router at /api/users
// (mirrors app.ts's dual mount on /api/users).
function policyApp() {
  const app = new Hono<Env>()
  app.route('/api/policy', policy)
  app.route('/api/users', adminPolicy)
  return app
}

async function adminCookie() {
  const t = await createSession({ sub: 'plex:1', username: 'admin-user', role: 'admin' })
  return `eex.session=${t}`
}
async function userCookie(sub = 'plex:2') {
  const t = await createSession({ sub, username: 'guest', role: 'user' })
  return `eex.session=${t}`
}

let tmpRoot: string
let policyPath: string

beforeEach(async () => {
  __resetRateLimitsForTests()
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'policy-route-'))
  policyPath = join(tmpRoot, 'user-policies.json')
  _setUserPoliciesPathForTests(policyPath)
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

const OPEN: Policy = { maxContentRating: null, allowedSections: null, kid: false }

describe('GET /api/policy — caller owns policy', () => {
  it('rejects unauthenticated', async () => {
    expect((await policyApp().request('/api/policy')).status).toBe(401)
  })

  it('returns default-open when unset', async () => {
    const r = await policyApp().request('/api/policy', { headers: { Cookie: await userCookie() } })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual(OPEN)
  })

  it('reflects the stored policy for the caller', async () => {
    await setPolicy('plex:2', {
      maxContentRating: 'PG',
      allowedSections: { live: false, downloads: true, arr: true },
      kid: true,
    })
    const r = await policyApp().request('/api/policy', { headers: { Cookie: await userCookie() } })
    expect(await r.json()).toMatchObject({ maxContentRating: 'PG', kid: true })
  })
})

describe('GET /api/users/policies — admin listing', () => {
  it('403 for non-admin', async () => {
    const r = await policyApp().request('/api/users/policies', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(403)
  })

  it('returns all policies for admin', async () => {
    await setPolicy('plex:2', {
      maxContentRating: 'R',
      allowedSections: null,
      kid: false,
    })
    const r = await policyApp().request('/api/users/policies', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { policies: Record<string, Policy> }
    expect(body.policies['plex:2'].maxContentRating).toBe('R')
  })
})

describe('PUT /api/users/:sub/policy — admin set', () => {
  const put = (cookie: string, sub: string, body: unknown) =>
    policyApp().request(`/api/users/${sub}/policy`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('403 for non-admin', async () => {
    const r = await put(await userCookie(), 'plex:2', {
      maxContentRating: null,
      allowedSections: null,
      kid: false,
    })
    expect(r.status).toBe(403)
  })

  it('round-trips a valid policy and returns the stored value', async () => {
    const cookie = await adminCookie()
    const p: Policy = {
      maxContentRating: 'TV-14',
      allowedSections: { live: true, downloads: false, arr: true },
      kid: false,
    }
    const r = await put(cookie, 'plex:2', p)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual(p)
    // Persisted — a fresh read agrees.
    expect(await getPolicy('plex:2')).toEqual(p)
  })

  it('rejects unknown top-level keys', async () => {
    const r = await put(await adminCookie(), 'plex:2', {
      maxContentRating: null,
      allowedSections: null,
      kid: false,
      wat: 1,
    })
    expect(r.status).toBe(400)
  })

  it('rejects an unknown section key', async () => {
    const r = await put(await adminCookie(), 'plex:2', {
      maxContentRating: null,
      allowedSections: { live: true, downloads: true, arr: true, extra: true },
      kid: false,
    })
    expect(r.status).toBe(400)
  })

  it('rejects an out-of-set maxContentRating', async () => {
    const r = await put(await adminCookie(), 'plex:2', {
      maxContentRating: 'X18',
      allowedSections: null,
      kid: false,
    })
    expect(r.status).toBe(400)
  })

  it('treats an absent maxContentRating as null and clears a prior cap', async () => {
    const cookie = await adminCookie()
    // Set a cap first.
    await put(cookie, 'plex:2', {
      maxContentRating: 'PG',
      allowedSections: null,
      kid: false,
    })
    expect((await getPolicy('plex:2')).maxContentRating).toBe('PG')

    // The Swift client omits the key entirely when unrestricted. A full
    // PUT without maxContentRating must clear the cap (absent == null).
    const r = await put(cookie, 'plex:2', { allowedSections: null, kid: false })
    expect(r.status).toBe(200)
    expect((await r.json()) as Policy).toMatchObject({ maxContentRating: null })
    expect((await getPolicy('plex:2')).maxContentRating).toBeNull()
  })

  it('accepts an empty body as a fully-open policy', async () => {
    const r = await put(await adminCookie(), 'plex:2', {})
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual(OPEN)
  })

  it('rejects a non-boolean kid and non-boolean section', async () => {
    expect(
      (
        await put(await adminCookie(), 'plex:2', {
          maxContentRating: null,
          allowedSections: null,
          kid: 'yes',
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await put(await adminCookie(), 'plex:2', {
          maxContentRating: null,
          allowedSections: { live: 'yes', downloads: true, arr: true },
          kid: false,
        })
      ).status,
    ).toBe(400)
  })
})

// Server-side enforcement — the part that makes the policy real. A blocked
// non-admin is stopped at the router before any upstream call.
describe('section enforcement on the *arr / sab routers', () => {
  async function blockPolicy(sub: string, sections: { live: boolean; downloads: boolean; arr: boolean }) {
    await setPolicy(sub, { maxContentRating: null, allowedSections: sections, kid: true })
  }

  it('sonarr add (POST) is 403 section_blocked when arr is denied', async () => {
    await blockPolicy('plex:2', { live: true, downloads: true, arr: false })
    const app = new Hono<Env>().route('/', sonarr)
    const r = await app.request('/api/v3/series', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tvdbId: 1, title: 'X' }),
    })
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ error: 'section_blocked' })
  })

  it('sonarr reads (GET) stay open even when arr is denied', async () => {
    await blockPolicy('plex:2', { live: true, downloads: true, arr: false })
    // Stub fetch so the forwarded read resolves without a real Sonarr.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
    )
    const app = new Hono<Env>().route('/', sonarr)
    const r = await app.request('/api/v3/series', { headers: { Cookie: await userCookie() } })
    // Not blocked by the section gate (would be 403). The read forwards.
    expect(r.status).not.toBe(403)
  })

  it('sab is 403 section_blocked (even on reads) when downloads is denied', async () => {
    await blockPolicy('plex:2', { live: true, downloads: false, arr: true })
    const app = new Hono<Env>().route('/', sab)
    const r = await app.request('/api?mode=queue', { headers: { Cookie: await userCookie() } })
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ error: 'section_blocked' })
  })

  it('admin is never section-blocked', async () => {
    await blockPolicy('plex:1', { live: false, downloads: false, arr: false })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ queue: { slots: [] } }), { status: 200 })),
    )
    const app = new Hono<Env>().route('/', sab)
    const r = await app.request('/api?mode=queue', { headers: { Cookie: await adminCookie() } })
    expect(r.status).not.toBe(403)
  })
})
