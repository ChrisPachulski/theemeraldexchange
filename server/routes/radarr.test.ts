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

// Capture the body that the backend forwards to Radarr's POST
// /api/v3/movie so we can assert the cap+monitor rewrite is applied
// correctly per the user's "Search" choice.
async function captureForwardedAdd(
  reqBody: unknown,
): Promise<{ monitored?: boolean; addOptions?: { searchForMovie?: boolean } }> {
  let captured: {
    monitored?: boolean
    addOptions?: { searchForMovie?: boolean }
  } = {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/v3/rootfolder')) {
        return new Response(
          JSON.stringify([{ id: 1, path: '/data/movies', freeSpace: 500 * 1024 ** 3 }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.endsWith('/api/v3/movie') && init?.method === 'POST') {
        captured = JSON.parse(String(init.body))
        // id:0 + no addOptions in upstream response → we won't kick the
        // background grab path (id check guards it).
        return new Response(JSON.stringify({ id: 0, title: 'Foo' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not stubbed: ' + url, { status: 599 })
    }),
  )
  await appUnderTest().request('/api/v3/movie', {
    method: 'POST',
    headers: {
      Cookie: await adminCookie(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(reqBody),
  })
  return captured
}

describe('radarr — add body rewrite (cap + monitor policy)', () => {
  it('"Start search now" (searchForMovie:true) forwards monitored:false + searchForMovie:false', async () => {
    // Default search path: we capped-grab in the background, and the
    // movie is left unmonitored so Radarr's RSS sweep can't bypass
    // the size cap with an oversized release later.
    const forwarded = await captureForwardedAdd({
      rootFolderPath: '/data/movies',
      title: 'Foo',
      monitored: true,
      addOptions: { searchForMovie: true },
    })
    expect(forwarded.monitored).toBe(false)
    expect(forwarded.addOptions?.searchForMovie).toBe(false)
  })

  it('"Just monitor" (searchForMovie:false) keeps monitored:true', async () => {
    // The user explicitly chose RSS-driven monitoring without an
    // immediate grab. The cap-aware grab path is skipped; we respect
    // monitored:true so Radarr can sweep for releases later.
    const forwarded = await captureForwardedAdd({
      rootFolderPath: '/data/movies',
      title: 'Foo',
      monitored: true,
      addOptions: { searchForMovie: false },
    })
    expect(forwarded.monitored).toBe(true)
    expect(forwarded.addOptions?.searchForMovie).toBe(false)
  })

  it('add without addOptions defaults to search → monitored:false', async () => {
    // Defensive: a client that omits addOptions entirely should still
    // get the search-path semantics (searchForMovie defaults to true
    // in Radarr), so we apply the cap+unmonitor rewrite.
    const forwarded = await captureForwardedAdd({
      rootFolderPath: '/data/movies',
      title: 'Foo',
    })
    expect(forwarded.monitored).toBe(false)
    expect(forwarded.addOptions?.searchForMovie).toBe(false)
  })
})
