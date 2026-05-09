// The Radarr router mirrors Sonarr structurally. These tests aren't a
// duplicate of the Sonarr suite — they exist so a future "let's add a
// Radarr-specific feature" change can't silently break the role or
// disk-space gates while looking like it only touched movies.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { radarr } from './radarr.js'
import { createSession } from '../session.js'
import type { Env } from '../middleware/auth.js'

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', radarr)
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

type Resp = { status: number; body: unknown }
const responses = new Map<string, Resp>()

beforeEach(() => {
  responses.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
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
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

function stub(suffix: string, body: unknown, status = 200) {
  responses.set(suffix, { status, body })
}

describe('radarr — allow-list and gates', () => {
  it('rejects unauthenticated', async () => {
    const r = await appUnderTest().request('/api/v3/movie')
    expect(r.status).toBe(401)
  })

  it('user can list movies', async () => {
    stub('/api/v3/movie', [{ id: 1, title: 'Test Movie' }])
    const r = await appUnderTest().request('/api/v3/movie', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
  })

  it('returns 404 for an undeclared path', async () => {
    const r = await appUnderTest().request('/api/v3/some-undeclared-path', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(404)
  })

  it('DELETE is admin-only', async () => {
    const r = await appUnderTest().request('/api/v3/movie/42', {
      method: 'DELETE',
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(403)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('admin DELETE is forwarded', async () => {
    stub('/api/v3/movie/42', null, 200)
    const r = await appUnderTest().request('/api/v3/movie/42', {
      method: 'DELETE',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
  })

  it('blocks add with 507 when freeSpace below threshold', async () => {
    stub('/api/v3/rootfolder', [
      { id: 1, path: '/data/movies', freeSpace: 25 * 1024 ** 3 },
    ])
    const r = await appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: {
        Cookie: await adminCookie(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ rootFolderPath: '/data/movies', title: 'Foo' }),
    })
    expect(r.status).toBe(507)
    const body = (await r.json()) as { error?: string }
    expect(body.error).toBe('insufficient_disk_space')
  })

  it('forwards the add when freeSpace ≥ threshold', async () => {
    stub('/api/v3/rootfolder', [
      { id: 1, path: '/data/movies', freeSpace: 500 * 1024 ** 3 },
    ])
    stub('/api/v3/movie', { id: 99 }, 201)
    const r = await appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: {
        Cookie: await adminCookie(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ rootFolderPath: '/data/movies', title: 'Foo' }),
    })
    expect(r.status).toBe(201)
  })
})
