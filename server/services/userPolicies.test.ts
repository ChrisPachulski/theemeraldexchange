import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Hono, type MiddlewareHandler } from 'hono'
import {
  getPolicy,
  getAllPolicies,
  setPolicy,
  defaultPolicy,
  requireSection,
  _setUserPoliciesPathForTests,
  type Policy,
} from './userPolicies.js'
import type { Env } from '../middleware/auth.js'
import type { Session } from '../session.js'

let tmpRoot: string
let policyPath: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'policies-'))
  policyPath = join(tmpRoot, 'user-policies.json')
  _setUserPoliciesPathForTests(policyPath)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('userPolicies store', () => {
  it('getPolicy returns a default-open policy when unset', async () => {
    expect(await getPolicy('plex:1')).toEqual(defaultPolicy())
    expect(await getPolicy('plex:1')).toEqual({
      maxContentRating: null,
      allowedSections: null,
      kid: false,
    })
  })

  it('setPolicy round-trips through getPolicy', async () => {
    const p: Policy = {
      maxContentRating: 'PG-13',
      allowedSections: { live: false, downloads: true, arr: false },
      kid: true,
    }
    await setPolicy('plex:1', p)
    expect(await getPolicy('plex:1')).toEqual(p)
  })

  it('getAllPolicies returns every stored policy', async () => {
    await setPolicy('plex:1', { maxContentRating: 'G', allowedSections: null, kid: true })
    await setPolicy('plex:2', {
      maxContentRating: null,
      allowedSections: { live: true, downloads: false, arr: true },
      kid: false,
    })
    const all = await getAllPolicies()
    expect(Object.keys(all).sort()).toEqual(['plex:1', 'plex:2'])
    expect(all['plex:1'].maxContentRating).toBe('G')
    expect(all['plex:2'].allowedSections).toEqual({ live: true, downloads: false, arr: true })
  })

  it('normalizes malformed on-disk data on read (default-open coercion)', async () => {
    await fs.writeFile(
      policyPath,
      JSON.stringify({
        'plex:1': { maxContentRating: 'BOGUS', allowedSections: { live: false }, kid: 'yes' },
      }),
    )
    _setUserPoliciesPathForTests(policyPath)
    const p = await getPolicy('plex:1')
    // Bad rating → null; partial allowedSections fills missing as allowed;
    // non-boolean kid → false.
    expect(p.maxContentRating).toBeNull()
    expect(p.allowedSections).toEqual({ live: false, downloads: true, arr: true })
    expect(p.kid).toBe(false)
  })
})

// Minimal harness: a middleware that injects a session, then the gate.
function gatedApp(
  session: Pick<Session, 'sub' | 'role'>,
  gate: MiddlewareHandler<Env>,
) {
  const app = new Hono<Env>()
  const inject: MiddlewareHandler<Env> = async (c, next) => {
    c.set('session', session as Session)
    await next()
  }
  app.use('*', inject)
  app.use('*', gate)
  app.get('/x', (c) => c.json({ ok: true }))
  app.post('/x', (c) => c.json({ ok: true }))
  return app
}

describe('requireSection middleware', () => {
  it('blocks a non-admin whose policy denies the section (403 section_blocked)', async () => {
    await setPolicy('plex:1', {
      maxContentRating: null,
      allowedSections: { live: false, downloads: false, arr: false },
      kid: false,
    })
    const app = gatedApp({ sub: 'plex:1', role: 'user' }, requireSection('live'))
    const r = await app.request('/x', { method: 'POST' })
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ error: 'section_blocked' })
  })

  it('allows a non-admin whose policy permits the section', async () => {
    await setPolicy('plex:1', {
      maxContentRating: null,
      allowedSections: { live: true, downloads: false, arr: false },
      kid: false,
    })
    const app = gatedApp({ sub: 'plex:1', role: 'user' }, requireSection('live'))
    expect((await app.request('/x', { method: 'POST' })).status).toBe(200)
  })

  it('default-open (unset policy) passes', async () => {
    const app = gatedApp({ sub: 'plex:unset', role: 'user' }, requireSection('arr'))
    expect((await app.request('/x', { method: 'POST' })).status).toBe(200)
  })

  it('admins are never blocked', async () => {
    await setPolicy('plex:9', {
      maxContentRating: null,
      allowedSections: { live: false, downloads: false, arr: false },
      kid: false,
    })
    const app = gatedApp({ sub: 'plex:9', role: 'admin' }, requireSection('downloads'))
    expect((await app.request('/x', { method: 'POST' })).status).toBe(200)
  })

  it('mutationsOnly leaves reads open but gates writes', async () => {
    await setPolicy('plex:1', {
      maxContentRating: null,
      allowedSections: { live: true, downloads: true, arr: false },
      kid: false,
    })
    const app = gatedApp({ sub: 'plex:1', role: 'user' }, requireSection('arr', { mutationsOnly: true }))
    // GET read passes even though arr is denied.
    expect((await app.request('/x')).status).toBe(200)
    // POST mutation is blocked.
    expect((await app.request('/x', { method: 'POST' })).status).toBe(403)
  })
})
