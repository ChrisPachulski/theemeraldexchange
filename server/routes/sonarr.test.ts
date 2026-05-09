// Highest-stakes tests. The Sonarr router is what mediates between the
// SPA and the Sonarr instance, and three properties have to hold:
//
//  1. ALLOW-LIST: anything not declared returns 404, even for admins.
//     A regression here means undeclared destructive endpoints could
//     be reached with admin intent.
//  2. ROLE GATES: DELETE /api/v3/series/:id is admin-only.
//  3. DISK GATE: POST /api/v3/series checks the rootfolder freeSpace
//     against MIN_FREE_GB and returns 507 below threshold.
//
// fetch is stubbed; no real Sonarr or plex.tv calls happen.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { sonarr } from './sonarr.js'
import { createSession } from '../session.js'
import type { Env } from '../middleware/auth.js'
import { env } from '../env.js'

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', sonarr)
  return app
}

async function adminCookie() {
  const t = await createSession({ sub: '1', username: 'admin-user', role: 'admin' })
  return `eex.session=${t}`
}
async function userCookie() {
  const t = await createSession({ sub: '2', username: 'guest', role: 'user' })
  return `eex.session=${t}`
}

// Stub a fetch that returns a predetermined response for a given URL
// suffix, plus calls a recorder so we can assert on what the route
// actually forwarded.
type FetchSpy = ReturnType<typeof vi.fn> & {
  responses?: Map<string, { status: number; body: unknown }>
}

beforeEach(() => {
  const responses = new Map<string, { status: number; body: unknown }>()
  const spy: FetchSpy = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    for (const [suffix, response] of responses) {
      if (url.endsWith(suffix) || url.includes(suffix)) {
        return new Response(JSON.stringify(response.body), {
          status: response.status,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }
    return new Response('not stubbed: ' + url, { status: 599 })
  })
  spy.responses = responses
  vi.stubGlobal('fetch', spy)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function stub(suffix: string, body: unknown, status = 200) {
  const fetchSpy = (globalThis.fetch as FetchSpy)
  fetchSpy.responses!.set(suffix, { status, body })
}

describe('sonarr route allow-list', () => {
  it('returns 404 for an undeclared GET path (even as admin)', async () => {
    const app = appUnderTest()
    const r = await app.request('/api/v3/some-undeclared-path', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(404)
  })

  it('returns 404 for an undeclared DELETE path (even as admin)', async () => {
    const app = appUnderTest()
    const r = await app.request('/api/v3/series-but-different-suffix', {
      method: 'DELETE',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(404)
  })

  it('rejects unauthenticated requests with 401', async () => {
    const app = appUnderTest()
    const r = await app.request('/api/v3/series')
    expect(r.status).toBe(401)
  })
})

describe('sonarr GET passthrough', () => {
  it('forwards /api/v3/series to Sonarr with the API key', async () => {
    stub('/api/v3/series', [{ id: 1, title: 'Test Show' }])
    const app = appUnderTest()
    const r = await app.request('/api/v3/series', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([{ id: 1, title: 'Test Show' }])

    // assert the upstream was called with our API key
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>
    const [, init] = fetchSpy.mock.calls[0]
    expect(init.headers['X-Api-Key']).toBe(env.sonarrApiKey)
  })

  it('forwards lookup with the term query param preserved', async () => {
    stub('/api/v3/series/lookup', [])
    const app = appUnderTest()
    const r = await app.request('/api/v3/series/lookup?term=severance', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)

    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>
    const [calledUrl] = fetchSpy.mock.calls[0]
    expect(String(calledUrl)).toContain('term=severance')
  })
})

describe('sonarr DELETE /api/v3/series/:id (admin only)', () => {
  it('rejects user role with 403 admin_only and does NOT forward', async () => {
    const app = appUnderTest()
    const r = await app.request('/api/v3/series/42', {
      method: 'DELETE',
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({
      error: 'forbidden',
      reason: 'admin_only',
    })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('forwards for admin role', async () => {
    stub('/api/v3/series/42', null, 200)
    const app = appUnderTest()
    const r = await app.request('/api/v3/series/42', {
      method: 'DELETE',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    expect(globalThis.fetch).toHaveBeenCalledOnce()
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(init.method).toBe('DELETE')
  })
})

describe('sonarr POST /api/v3/series disk-space gate', () => {
  it('blocks add with 507 when freeSpace < threshold', async () => {
    // 50 GB free, threshold is 100 GB
    stub('/api/v3/rootfolder', [
      { id: 1, path: '/data/tv', freeSpace: 50 * 1024 ** 3 },
    ])
    const app = appUnderTest()
    const r = await app.request('/api/v3/series', {
      method: 'POST',
      headers: {
        Cookie: await userCookie(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ rootFolderPath: '/data/tv', title: 'Foo' }),
    })
    expect(r.status).toBe(507)
    const body = (await r.json()) as { error?: string; free_bytes?: number; path?: string }
    expect(body.error).toBe('insufficient_disk_space')
    expect(body.free_bytes).toBe(50 * 1024 ** 3)
    expect(body.path).toBe('/data/tv')

    // Critically: the actual /api/v3/series POST never happened
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>
    const calls = fetchSpy.mock.calls.map(([u]) => String(u))
    expect(calls.some((u) => u.endsWith('/api/v3/rootfolder'))).toBe(true)
    expect(calls.some((u) => u.endsWith('/api/v3/series') && !u.endsWith('rootfolder'))).toBe(false)
  })

  it('blocks ADMINS too (not just users)', async () => {
    stub('/api/v3/rootfolder', [
      { id: 1, path: '/data/tv', freeSpace: 1 * 1024 ** 3 },
    ])
    const app = appUnderTest()
    const r = await app.request('/api/v3/series', {
      method: 'POST',
      headers: {
        Cookie: await adminCookie(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ rootFolderPath: '/data/tv', title: 'Foo' }),
    })
    expect(r.status).toBe(507)
  })

  it('forwards the add when freeSpace >= threshold', async () => {
    stub('/api/v3/rootfolder', [
      { id: 1, path: '/data/tv', freeSpace: 500 * 1024 ** 3 },
    ])
    stub('/api/v3/series', { id: 99, title: 'Foo' }, 201)
    const app = appUnderTest()
    const r = await app.request('/api/v3/series', {
      method: 'POST',
      headers: {
        Cookie: await userCookie(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ rootFolderPath: '/data/tv', title: 'Foo' }),
    })
    expect(r.status).toBe(201)
  })

  it('skips the disk check when no rootFolderPath is in the body', async () => {
    // Edge case: malformed add request without rootFolderPath. We
    // forward to Sonarr and let it return 400 — we don't synthesize a
    // disk error from missing data.
    stub('/api/v3/series', { error: 'bad request' }, 400)
    const app = appUnderTest()
    const r = await app.request('/api/v3/series', {
      method: 'POST',
      headers: {
        Cookie: await userCookie(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'No root folder' }),
    })
    expect(r.status).toBe(400)
  })
})
