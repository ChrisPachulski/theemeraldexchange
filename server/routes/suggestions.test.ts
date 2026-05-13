import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Hono } from 'hono'
import { suggestions } from './suggestions.js'
import { createSession } from '../session.js'
import { _setRejectionsPathForTests } from '../services/rejections.js'
import type { Env } from '../middleware/auth.js'

// Gating-only tests. The route's interesting paths involve Sonarr +
// Radarr + Claude + TMDB upstreams that depend on env keys set at
// module-load time — those are exercised in the post-deploy NAS smoke
// test, not here. We keep the unit suite focused on what's worth
// catching cheaply: auth, type validation, and that the route is
// mounted at all.

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', suggestions)
  return app
}

async function userCookie() {
  const t = await createSession({ sub: '1', username: 'guest', role: 'user' })
  return `eex.session=${t}`
}

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'sugg-route-'))
  _setRejectionsPathForTests(join(tmpRoot, 'rejections.json'))
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe('suggestions route — gating', () => {
  it('rejects unauthenticated', async () => {
    const r = await appUnderTest().request('/movie')
    expect(r.status).toBe(401)
  })

  it('400 on invalid type', async () => {
    const r = await appUnderTest().request('/books', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(400)
  })

  it('200 on valid type (smoke — body shape verified e2e on NAS)', async () => {
    // Stub upstreams to empty so the route exits cleanly via the
    // cold-start branch without touching real APIs.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })),
    )
    const r = await appUnderTest().request('/tv', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { source: string; items: unknown[] }
    expect(typeof body.source).toBe('string')
    expect(Array.isArray(body.items)).toBe(true)
  })
})
