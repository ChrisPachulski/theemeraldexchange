// The Radarr router mirrors Sonarr structurally. These tests aren't a
// duplicate of the Sonarr suite — they exist so a future "let's add a
// Radarr-specific feature" change can't silently break the role or
// disk-space gates while looking like it only touched movies.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { radarr } from './radarr.js'
import { createSession } from '../session.js'
import { __resetRateLimitsForTests } from '../middleware/rateLimit.js'
import type { Env } from '../middleware/auth.js'
import { env } from '../env.js'
import * as grabLog from '../services/grabLog.js'

// Spy on the recommender 'added' conversion mirror so we can assert WHEN it
// fires relative to the cap-aware grab (it must never fire on a rollback).
vi.mock('../services/recommender.js', async (orig) => ({
  ...(await orig<typeof import('../services/recommender.js')>()),
  postFeedback: vi.fn(() => Promise.resolve()),
}))
import { postFeedback } from '../services/recommender.js'
const mockPostFeedback = vi.mocked(postFeedback)

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', radarr)
  return app
}

async function adminCookie() {
  const t = await createSession({ sub: 'plex:1', username: 'admin-user', role: 'admin' })
  return `eex.session=${t}`
}
async function userCookie() {
  const t = await createSession({ sub: 'plex:2', username: 'guest', role: 'user' })
  return `eex.session=${t}`
}

type Resp = { status: number; body: unknown }
const responses = new Map<string, Resp>()

beforeEach(() => {
  responses.clear()
  // Finding 4-0: the rate-limit buckets are module-global; reset between tests
  // so a prior test's requests don't pre-drain another test's budget.
  __resetRateLimitsForTests()
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

function stubUpgradeSpaceOk(path = '/data/movies') {
  stub('/api/v3/movie/42', { id: 42, rootFolderPath: path })
  stub('/api/v3/rootfolder', [{ id: 1, path, freeSpace: 500 * 1024 ** 3 }])
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

  it('user can read the queue (DownloadsTab polls this for movie pending states)', async () => {
    // Without this in the allow-list, the SPA's radarr.queue() poll
    // 404s in prod and movie "indexer working" / pending states
    // disappear from the dashboard. Sonarr has the matching forwarder;
    // Radarr was missing it.
    stub('/api/v3/queue', { page: 1, pageSize: 200, totalRecords: 0, records: [] })
    const r = await appUnderTest().request('/api/v3/queue?pageSize=200', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { records: unknown[] }
    expect(body.records).toEqual([])
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

  it('admin DELETE with encoded-slash traversal returns 400, does not reach upstream', async () => {
    // Hono URL-decodes :id BEFORE we read it. Without validation, an
    // attacker who passes `..%2Frootfolder%2F1` (which Hono decodes
    // back to `../rootfolder/1`) flows through `new URL(base + path)`,
    // where the WHATWG URL parser normalizes the `..` segment, and the
    // DELETE silently retargets `/api/v3/rootfolder/1` upstream. The
    // route now requires a positive safe integer; the upstream stub
    // must NEVER be touched.
    const r = await appUnderTest().request(
      '/api/v3/movie/..%2Frootfolder%2F1',
      { method: 'DELETE', headers: { Cookie: await adminCookie() } },
    )
    expect(r.status).toBe(400)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('admin DELETE with a non-integer :id returns 400', async () => {
    const r = await appUnderTest().request('/api/v3/movie/abc', {
      method: 'DELETE',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(400)
    expect(globalThis.fetch).not.toHaveBeenCalled()
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
    stub('/api/v3/movie', { id: 99, title: 'Foo' }, 201)
    stub('/api/v3/release?movieId=99', [
      { guid: 'g-99', indexerId: 1, size: 2 * 1024 ** 3, qualityWeight: 100, title: 'Foo 1080p' },
    ])
    stub('/api/v3/release', { ok: true })
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

  it('admin omitting rootFolderPath routes through materialize (no silent forward, no 400)', async () => {
    // History: the route originally 400'd rootFolderPath_required on any
    // missing path "to fail closed." But AddMovieModal's viewAs-aware
    // isAdmin sends the slim user-shape body when an admin previews-as-
    // user; the session is still admin, so the request 400'd in 2 ms and
    // surfaced as the cryptic "Radarr /movie: 400" toast. The route now
    // routes admin-slim-body adds through the same materialize step the
    // non-admin branch uses — curated defaults are backfilled and the
    // disk-space gate is still enforced (just one step later). The
    // upstream-unreachable failure shape proves we did NOT silently
    // forward the add: we attempted to materialize, hit the unstubbed
    // qualityprofile lookup, and bailed with 503.
    const r = await appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: {
        Cookie: await adminCookie(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'No root folder' }),
    })
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'rootfolder_unreachable' })
  })

  it('400 unknown_root_folder when rootFolderPath does not match any Radarr folder', async () => {
    stub('/api/v3/rootfolder', [
      { id: 1, path: '/data/movies', freeSpace: 500 * 1024 ** 3 },
    ])
    const r = await appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: {
        Cookie: await adminCookie(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'X', rootFolderPath: '/data/different' }),
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'unknown_root_folder', path: '/data/different' })
  })

  it('507 free_space_unknown when the matched root folder omits freeSpace', async () => {
    // Radarr can omit freeSpace on transient issues. Old code treated
    // missing/non-finite freeSpace as "fine" — silently disabling the
    // gate. Fail closed.
    stub('/api/v3/rootfolder', [{ id: 1, path: '/data/movies' }])
    const r = await appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: {
        Cookie: await adminCookie(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'X', rootFolderPath: '/data/movies' }),
    })
    expect(r.status).toBe(507)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('free_space_unknown')
  })
})

describe('radarr POST /api/v3/movie — non-admin add policy', () => {
  // The Add dialog now shows every household member the quality/folder/search
  // controls, so a non-admin's choices ARE honored — but each is validated
  // against the live upstream lists first (an unknown folder/profile is
  // rejected, no path injection), tags stay admin-only, and the per-title size
  // caps still apply downstream.
  it('honors a non-admin\'s valid folder + quality choice (validated against live lists)', async () => {
    let capturedAddBody: Record<string, unknown> | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([
            { id: 1, path: '/data/movies', freeSpace: 500 * 1024 ** 3 },
            { id: 2, path: '/data/movies-mirror', freeSpace: 500 * 1024 ** 3 },
          ]), { status: 200 })
        }
        if (url.includes('/api/v3/qualityprofile')) {
          return new Response(JSON.stringify([{ id: 7, name: 'Choose Me' }, { id: 8, name: 'Any' }]), { status: 200 })
        }
        if (url.endsWith('/api/v3/movie') && init?.method === 'POST') {
          capturedAddBody = JSON.parse(init.body as string)
          return new Response(JSON.stringify({ id: 999, title: 'Hostile' }), { status: 201 })
        }
        if (url.includes('/api/v3/release?movieId=999')) {
          return new Response(JSON.stringify([
            {
              guid: 'release-999',
              indexerId: 1,
              size: 2 * 1024 ** 3,
              qualityWeight: 100,
              title: 'Hostile 1080p',
            },
          ]), { status: 200 })
        }
        if (url.endsWith('/api/v3/release') && init?.method === 'POST') {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Hostile',
        tmdbId: 42,
        // Valid folder + profile (both in the live lists) → honored. tags +
        // minimumAvailability are not exposed controls → dropped.
        rootFolderPath: '/data/movies-mirror',
        qualityProfileId: 8,
        monitored: false,
        tags: [99],
        minimumAvailability: 'tba',
        addOptions: { searchForMovie: true, monitor: 'movieOnly' },
      }),
    })
    expect(r.status).toBe(201)
    expect(capturedAddBody).not.toBeNull()
    const fwd = capturedAddBody as unknown as Record<string, unknown>
    expect(fwd.rootFolderPath).toBe('/data/movies-mirror')
    expect(fwd.qualityProfileId).toBe(8)
    expect(fwd.tags).toEqual([])
    // After the cap rewrite: monitored:false (searchForMovie:true was
    // server-supplied, so the existing cap path unmonitors and runs
    // the cap-aware grab as the only download trigger).
    expect(fwd.monitored).toBe(false)
    expect(fwd.minimumAvailability).toBeUndefined()
    // Identifying metadata preserved.
    expect(fwd.title).toBe('Hostile')
    expect(fwd.tmdbId).toBe(42)
  })

  it('rejects a non-admin rootFolderPath that is not a real upstream folder (400, no add)', async () => {
    let addPosted = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([
            { id: 1, path: '/data/movies', freeSpace: 500 * 1024 ** 3 },
          ]), { status: 200 })
        }
        if (url.includes('/api/v3/qualityprofile')) {
          return new Response(JSON.stringify([{ id: 7, name: 'Choose Me' }]), { status: 200 })
        }
        if (url.endsWith('/api/v3/movie') && init?.method === 'POST') {
          addPosted = true
          return new Response(JSON.stringify({ id: 1, title: 'X' }), { status: 201 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'X', tmdbId: 7, rootFolderPath: '/etc/passwd', qualityProfileId: 7 }),
    })
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('unknown_root_folder')
    expect(addPosted).toBe(false) // never forwarded to Radarr
  })

  it('prefers a "Choose Me" profile over profiles[0] for non-admin adds', async () => {
    // Regression: prior to this round the non-admin materialize picked
    // profiles[0], which on a fresh Radarr install is the permissive
    // Any profile. The frontend deliberately prefers the curated
    // "Choose Me" profile by name; the server now mirrors that so
    // direct-POSTs and modal-driven adds land on the same profile.
    let capturedAddBody: Record<string, unknown> | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([
            { id: 1, path: '/data/movies', freeSpace: 500 * 1024 ** 3 },
          ]), { status: 200 })
        }
        if (url.includes('/api/v3/qualityprofile')) {
          // "Any" is first (most permissive), "Choose Me" is second —
          // server must still pick the curated one by name.
          return new Response(JSON.stringify([
            { id: 1, name: 'Any' },
            { id: 7, name: 'Choose Me' },
            { id: 8, name: 'HD - 1080p' },
          ]), { status: 200 })
        }
        if (url.endsWith('/api/v3/movie') && init?.method === 'POST') {
          capturedAddBody = JSON.parse(init.body as string)
          return new Response(JSON.stringify({ id: 999, title: 'X' }), { status: 201 })
        }
        if (url.includes('/api/v3/release?movieId=999')) {
          return new Response(
            JSON.stringify([
              { guid: 'g-999', indexerId: 1, size: 2 * 1024 ** 3, qualityWeight: 100, title: 'X 1080p' },
            ]),
            { status: 200 },
          )
        }
        if (url.endsWith('/api/v3/release') && init?.method === 'POST') {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'X', tmdbId: 1 }),
    })
    expect(r.status).toBe(201)
    expect(capturedAddBody).not.toBeNull()
    const fwd = capturedAddBody as unknown as Record<string, unknown>
    expect(fwd.qualityProfileId).toBe(7) // Choose Me — not Any (id 1)
  })

  it('503 when upstream qualityprofile / rootfolder are not configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/api/v3/rootfolder')) {
          return new Response('[]', { status: 200 })
        }
        if (url.includes('/api/v3/qualityprofile')) {
          return new Response('[]', { status: 200 })
        }
        return new Response('not stubbed', { status: 599 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'X', tmdbId: 1 }),
    })
    expect(r.status).toBe(503)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('admin_must_configure_upstream')
  })

  it('admin sending a slim body (no rootFolderPath) materializes defaults instead of 400ing', async () => {
    // Regression: AddMovieModal uses auth.tsx's viewAs-aware isAdmin to
    // pick body shape. When an admin previews-as-user, the modal sends
    // the slim user-shape body { tmdbId, title, year }. The server's
    // session.role stays 'admin' (cookie, not viewAs), so the admin
    // passthrough branch fired and validateRadarrRootFolderSpace
    // tripped rootFolderPath_required in 2 ms — surfacing as the
    // cryptic "Radarr /movie: 400" toast for every admin-in-preview add.
    let capturedAddBody: Record<string, unknown> | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([
            { id: 1, path: '/data/movies', freeSpace: 500 * 1024 ** 3 },
          ]), { status: 200 })
        }
        if (url.includes('/api/v3/qualityprofile')) {
          return new Response(JSON.stringify([{ id: 7, name: 'Choose Me' }]), { status: 200 })
        }
        if (url.endsWith('/api/v3/movie') && init?.method === 'POST') {
          capturedAddBody = JSON.parse(init.body as string)
          return new Response(JSON.stringify({ id: 1234, title: 'Jurassic World' }), { status: 201 })
        }
        if (url.includes('/api/v3/release?movieId=1234')) {
          return new Response(JSON.stringify([
            { guid: 'rel-1234', indexerId: 1, size: 2 * 1024 ** 3, qualityWeight: 100, title: 'Jurassic World 1080p' },
          ]), { status: 200 })
        }
        if (url.endsWith('/api/v3/release') && init?.method === 'POST') {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tmdbId: 135397, title: 'Jurassic World', year: 2015 }),
    })
    expect(r.status).toBe(201)
    const fwd = capturedAddBody as unknown as Record<string, unknown>
    expect(fwd.rootFolderPath).toBe('/data/movies')
    expect(fwd.qualityProfileId).toBe(7)
    expect(fwd.tmdbId).toBe(135397)
    expect(fwd.title).toBe('Jurassic World')
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
        // id:0 in the upstream response → the created movie is unusable and
        // the request body carries no tmdbId to recover by, so the route
        // takes the add_unverified path after forwarding. The forwarded body
        // (this helper's only output) is captured before that.
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

// Add + "search now" but the title has NO releases yet (unreleased/future
// film). The movie must be KEPT and flipped to monitored so Radarr's RSS
// sync grabs it when a release appears — NOT rolled back with a 424.
describe('radarr POST /movie — no releases yet → monitor for future', () => {
  it('keeps the movie and sets monitored (200 monitoring), does NOT roll back', async () => {
    let putMonitored: Record<string, unknown> | null = null
    let deleteCalled = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([{ id: 1, path: '/data/movies', freeSpace: 500 * 1024 ** 3 }]), { status: 200 })
        }
        if (url.endsWith('/api/v3/movie') && init?.method === 'POST') {
          return new Response(JSON.stringify({ id: 803, title: 'Pressure', monitored: false }), { status: 201 })
        }
        if (url.includes('/api/v3/release?movieId=803')) {
          return new Response('[]', { status: 200 }) // no releases exist yet
        }
        if (url.endsWith('/api/v3/movie/803') && init?.method === 'PUT') {
          putMonitored = JSON.parse(init.body as string)
          return new Response(JSON.stringify({ id: 803, monitored: true }), { status: 200 })
        }
        if (url.endsWith('/api/v3/movie/803') && init?.method === 'DELETE') {
          deleteCalled = true
          return new Response('', { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Pressure',
        tmdbId: 803,
        rootFolderPath: '/data/movies',
        qualityProfileId: 7,
        monitored: true,
        addOptions: { searchForMovie: true },
      }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { status: string; monitored: boolean }
    expect(body.status).toBe('monitoring')
    expect(body.monitored).toBe(true)
    expect(putMonitored).not.toBeNull()
    expect((putMonitored as unknown as { monitored: boolean }).monitored).toBe(true)
    expect(deleteCalled).toBe(false) // the add is preserved, not rolled back
  })
})

// Add + "search now" but every release the indexers return is REJECTED by
// Radarr for reasons unrelated to our size cap (unparseable name, title
// mismatch). This is the "Far Far Away Idol" shape: 4 tiny (0.12 GB)
// releases, all rejected:true with "Unable to parse release". The cap never
// applied, so the movie must be KEPT + monitored (200), NOT rolled back with
// a misleading capped_grab_not_started 424.
describe('radarr POST /movie — releases exist but all Radarr-rejected → monitor', () => {
  it('keeps the movie + sets monitored (200 monitoring), does NOT roll back or 424', async () => {
    const tiny = Math.round(0.12 * 1024 ** 3) // 0.12 GB — nowhere near the cap
    let putMonitored: Record<string, unknown> | null = null
    let deleteCalled = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([{ id: 1, path: '/data/movies', freeSpace: 500 * 1024 ** 3 }]), { status: 200 })
        }
        if (url.endsWith('/api/v3/movie') && init?.method === 'POST') {
          return new Response(JSON.stringify({ id: 830, title: 'Far Far Away Idol', monitored: false }), { status: 201 })
        }
        if (url.includes('/api/v3/release?movieId=830')) {
          // All under the cap, but every one rejected by Radarr's parser.
          return new Response(
            JSON.stringify([
              { guid: 'g1', indexerId: 1, size: tiny, qualityWeight: 100, title: 'Far.Far.Away.Idol.NF.WEB-DL.1080p', rejected: true },
              { guid: 'g2', indexerId: 1, size: tiny, qualityWeight: 90, title: 'Far.Far.Away.Idol', rejected: true },
              { guid: 'g3', indexerId: 1, size: tiny, qualityWeight: 80, title: 'Far.Far.Away.Idol', temporarilyRejected: true },
            ]),
            { status: 200 },
          )
        }
        if (url.endsWith('/api/v3/movie/830') && init?.method === 'PUT') {
          putMonitored = JSON.parse(init.body as string)
          return new Response(JSON.stringify({ id: 830, monitored: true }), { status: 200 })
        }
        if (url.endsWith('/api/v3/movie/830') && init?.method === 'DELETE') {
          deleteCalled = true
          return new Response('', { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Far Far Away Idol',
        tmdbId: 58508,
        rootFolderPath: '/data/movies',
        qualityProfileId: 7,
        monitored: true,
        addOptions: { searchForMovie: true },
      }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { status: string; phase: string; monitored: boolean }
    expect(body.status).toBe('monitoring')
    expect(body.phase).toBe('no_matching_releases')
    expect(body.monitored).toBe(true)
    expect(putMonitored).not.toBeNull()
    expect(deleteCalled).toBe(false) // preserved, not rolled back
  })

  it('returns a typed error when the monitor-enable recovery PUT fails', async () => {
    const tiny = Math.round(0.12 * 1024 ** 3)
    let deleteCalled = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([{ id: 1, path: '/data/movies', freeSpace: 500 * 1024 ** 3 }]), { status: 200 })
        }
        if (url.endsWith('/api/v3/movie') && init?.method === 'POST') {
          return new Response(JSON.stringify({ id: 831, title: 'Needs Monitor', monitored: false }), { status: 201 })
        }
        if (url.includes('/api/v3/release?movieId=831')) {
          return new Response(
            JSON.stringify([
              { guid: 'g1', indexerId: 1, size: tiny, qualityWeight: 100, title: 'Needs.Monitor.1080p', rejected: true },
            ]),
            { status: 200 },
          )
        }
        if (url.endsWith('/api/v3/movie/831') && init?.method === 'PUT') {
          return new Response(JSON.stringify({ error: 'upstream failed' }), { status: 500 })
        }
        if (url.endsWith('/api/v3/movie/831') && init?.method === 'DELETE') {
          deleteCalled = true
          return new Response('', { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )

    const r = await appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Needs Monitor',
        tmdbId: 58509,
        rootFolderPath: '/data/movies',
        qualityProfileId: 7,
        monitored: true,
        addOptions: { searchForMovie: true },
      }),
    })

    expect(r.status).toBe(502)
    const body = (await r.json()) as { error?: string; status?: number; phase?: string }
    expect(body.error).toBe('monitor_enable_failed')
    expect(body.status).toBe(500)
    expect(body.phase).toBe('no_matching_releases')
    expect(deleteCalled).toBe(false)
  })
})

// The recommender 'added' conversion signal must fire only when the movie is
// KEPT — never on a cap-grab rollback (which deletes the movie + 424s),
// otherwise the optimizer learns conversions for titles that no longer exist.
describe('radarr POST /movie — recommender "added" signal timing', () => {
  const realUseLocal = env.useLocalRecommender
  beforeEach(() => {
    mockPostFeedback.mockClear()
    ;(env as { useLocalRecommender: boolean }).useLocalRecommender = true
  })
  afterEach(() => {
    ;(env as { useLocalRecommender: boolean }).useLocalRecommender = realUseLocal
  })

  it('does NOT signal "added" when the cap-grab rolls the movie back (424)', async () => {
    const huge = 999 * 1024 ** 3 // over any cap → all_rejected_by_cap → rollback
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([{ id: 1, path: '/data/movies', freeSpace: 5000 * 1024 ** 3 }]), { status: 200 })
        }
        if (url.endsWith('/api/v3/movie') && init?.method === 'POST') {
          return new Response(JSON.stringify({ id: 901, title: 'Over Cap', monitored: false }), { status: 201 })
        }
        if (url.includes('/api/v3/release?movieId=901')) {
          // Radarr-ACCEPTED (not rejected) but huge → over the size cap.
          return new Response(JSON.stringify([{ guid: 'g', indexerId: 1, size: huge, qualityWeight: 100, title: '4K' }]), { status: 200 })
        }
        if (url.endsWith('/api/v3/movie/901') && init?.method === 'DELETE') {
          return new Response('', { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const res = await appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Over Cap', tmdbId: 901, rootFolderPath: '/data/movies', qualityProfileId: 7, monitored: true, addOptions: { searchForMovie: true } }),
    })
    expect(res.status).toBe(424)
    expect((await res.json() as { error: string }).error).toBe('capped_grab_not_started')
    expect(mockPostFeedback).not.toHaveBeenCalled()
  })

  it('signals "added" once when the movie is kept (monitoring path)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([{ id: 1, path: '/data/movies', freeSpace: 500 * 1024 ** 3 }]), { status: 200 })
        }
        if (url.endsWith('/api/v3/movie') && init?.method === 'POST') {
          return new Response(JSON.stringify({ id: 902, title: 'Future Film', monitored: false }), { status: 201 })
        }
        if (url.includes('/api/v3/release?movieId=902')) {
          return new Response('[]', { status: 200 }) // no releases → monitoring
        }
        if (url.endsWith('/api/v3/movie/902') && init?.method === 'PUT') {
          return new Response(JSON.stringify({ id: 902, monitored: true }), { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const res = await appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Future Film', tmdbId: 902, rootFolderPath: '/data/movies', qualityProfileId: 7, monitored: true, addOptions: { searchForMovie: true } }),
    })
    expect(res.status).toBe(200)
    expect(mockPostFeedback).toHaveBeenCalledTimes(1)
    expect(mockPostFeedback.mock.calls[0][0]).toMatchObject({ kind: 'movie', tmdb_id: 902, signal: 'added' })
  })
})

// Grab events written by the movie-add pipeline must carry the caller's sub.
// Without it, readEventsForItem's legacy allowance (undefined sub matches
// every caller) made every Radarr grab event visible to every member via
// /api/grabs/by-item — Sonarr already threaded sub; Radarr did not.
describe('radarr POST /movie — grab events attributed to the caller sub', () => {
  it('every event from the add pipeline carries the session sub', async () => {
    const appendSpy = vi.spyOn(grabLog, 'appendGrabEvent').mockResolvedValue(undefined)
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          if (url.includes('/api/v3/rootfolder')) {
            return new Response(JSON.stringify([{ id: 1, path: '/data/movies', freeSpace: 500 * 1024 ** 3 }]), { status: 200 })
          }
          if (url.includes('/api/v3/qualityprofile')) {
            return new Response(JSON.stringify([{ id: 7, name: 'Choose Me' }]), { status: 200 })
          }
          if (url.endsWith('/api/v3/movie') && init?.method === 'POST') {
            return new Response(JSON.stringify({ id: 555, title: 'Attributed' }), { status: 201 })
          }
          if (url.includes('/api/v3/release?movieId=555')) {
            return new Response(
              JSON.stringify([
                { guid: 'g-555', indexerId: 1, size: 2 * 1024 ** 3, qualityWeight: 100, title: 'Attributed 1080p' },
              ]),
              { status: 200 },
            )
          }
          if (url.endsWith('/api/v3/release') && init?.method === 'POST') {
            return new Response(JSON.stringify({ ok: true }), { status: 200 })
          }
          return new Response('[]', { status: 200 })
        }),
      )
      // userCookie() resolves to sub 'plex:2' — the non-admin add path.
      const r = await appUnderTest().request('/api/v3/movie', {
        method: 'POST',
        headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Attributed', tmdbId: 555 }),
      })
      expect(r.status).toBe(201)
      // grab_started + grab_succeeded at minimum — and EVERY one attributed.
      expect(appendSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
      for (const [event] of appendSpy.mock.calls) {
        expect(event).toMatchObject({ app: 'radarr', itemId: 555, sub: 'plex:2' })
      }
      const types = appendSpy.mock.calls.map(([e]) => (e as { type: string }).type)
      expect(types).toContain('grab_started')
      expect(types).toContain('grab_succeeded')
    } finally {
      appendSpy.mockRestore()
    }
  })
})

// A 201 create whose body is unparseable/untitled used to silently skip the
// cap grab while still returning success — leaving a dead movie that the cap
// rewrite had forced to monitored:false (no RSS sweep would ever fetch it).
// The route now recovers the canonical record by tmdbId, and when that fails
// it rolls back + surfaces a distinct error instead of claiming success.
describe('radarr POST /movie — unparseable create body recovery', () => {
  it('recovers id+title via tmdbId re-fetch and runs the cap grab', async () => {
    let grabPosted = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([{ id: 1, path: '/data/movies', freeSpace: 500 * 1024 ** 3 }]), { status: 200 })
        }
        if (url.endsWith('/api/v3/movie') && init?.method === 'POST') {
          // Radarr 201s but the body is not JSON (proxy interjection).
          return new Response('<html>gateway said ok</html>', { status: 201 })
        }
        if (url.includes('/api/v3/movie?tmdbId=777')) {
          return new Response(JSON.stringify([{ id: 777, title: 'Recovered Movie', monitored: false }]), { status: 200 })
        }
        if (url.includes('/api/v3/release?movieId=777')) {
          return new Response(
            JSON.stringify([
              { guid: 'g-777', indexerId: 1, size: 2 * 1024 ** 3, qualityWeight: 100, title: 'Recovered 1080p' },
            ]),
            { status: 200 },
          )
        }
        if (url.endsWith('/api/v3/release') && init?.method === 'POST') {
          grabPosted = true
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Recovered Movie',
        tmdbId: 777,
        rootFolderPath: '/data/movies',
        qualityProfileId: 7,
        monitored: true,
        addOptions: { searchForMovie: true },
      }),
    })
    expect(r.status).toBe(201)
    expect(grabPosted).toBe(true)
    // The SPA gets the recovered movie record, not the raw upstream bytes.
    const body = (await r.json()) as { id: number; title: string }
    expect(body.id).toBe(777)
    expect(body.title).toBe('Recovered Movie')
  })

  it('502 add_unverified + grab-log event when recovery also fails (no success claim)', async () => {
    const appendSpy = vi.spyOn(grabLog, 'appendGrabEvent').mockResolvedValue(undefined)
    try {
      let grabPosted = false
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
          if (url.includes('/api/v3/rootfolder')) {
            return new Response(JSON.stringify([{ id: 1, path: '/data/movies', freeSpace: 500 * 1024 ** 3 }]), { status: 200 })
          }
          if (url.endsWith('/api/v3/movie') && init?.method === 'POST') {
            return new Response('not-json', { status: 201 })
          }
          if (url.includes('/api/v3/movie?tmdbId=778')) {
            return new Response('[]', { status: 200 }) // recovery finds nothing
          }
          if (url.endsWith('/api/v3/release') && init?.method === 'POST') {
            grabPosted = true
            return new Response(JSON.stringify({ ok: true }), { status: 200 })
          }
          return new Response('[]', { status: 200 })
        }),
      )
      const r = await appUnderTest().request('/api/v3/movie', {
        method: 'POST',
        headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Ghost Movie',
          tmdbId: 778,
          rootFolderPath: '/data/movies',
          qualityProfileId: 7,
          monitored: true,
          addOptions: { searchForMovie: true },
        }),
      })
      expect(r.status).toBe(502)
      const body = (await r.json()) as { error: string }
      expect(body.error).toBe('add_unverified')
      expect(grabPosted).toBe(false)
      // The why is preserved for the admin panel, attributed to the caller.
      expect(appendSpy).toHaveBeenCalledTimes(1)
      expect(appendSpy.mock.calls[0][0]).toMatchObject({
        app: 'radarr',
        type: 'grab_failed',
        title: 'Ghost Movie',
        sub: 'plex:1',
      })
      expect((appendSpy.mock.calls[0][0] as { error?: string }).error).toMatch(/could not be identified/)
    } finally {
      appendSpy.mockRestore()
    }
  })

  it('rolls back a created-but-untitled movie when recovery fails', async () => {
    // The create body parsed and carried an id, but no usable title — and the
    // tmdbId re-fetch errored. With an id in hand the route deletes the dead
    // unmonitored record rather than stranding it.
    let deleteCalled = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([{ id: 1, path: '/data/movies', freeSpace: 500 * 1024 ** 3 }]), { status: 200 })
        }
        if (url.endsWith('/api/v3/movie') && init?.method === 'POST') {
          return new Response(JSON.stringify({ id: 779 }), { status: 201 }) // no title
        }
        if (url.includes('/api/v3/movie?tmdbId=779')) {
          return new Response('{}', { status: 500 }) // recovery lookup fails
        }
        if (url.endsWith('/api/v3/movie/779') && init?.method === 'DELETE') {
          deleteCalled = true
          return new Response('', { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Untitled Echo',
        tmdbId: 779,
        rootFolderPath: '/data/movies',
        qualityProfileId: 7,
        monitored: true,
        addOptions: { searchForMovie: true },
      }),
    })
    expect(r.status).toBe(502)
    expect(((await r.json()) as { error: string }).error).toBe('add_unverified')
    expect(deleteCalled).toBe(true)
  })
})

// POST /api/v3/movie/:id/upgrade — admin-only manual upgrade trigger.
// Reuses the same cap-filter chain as the add flow (so it can't
// download a 50 GB rip even though it's logically an upgrade request)
// and surfaces structured statuses instead of 200/error.
describe('radarr POST /movie/:id/upgrade — admin gate + bad id', () => {
  it('rejects user role with 403, does NOT touch Radarr', async () => {
    const r = await appUnderTest().request('/api/v3/movie/42/upgrade', {
      method: 'POST',
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(403)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated with 401', async () => {
    const r = await appUnderTest().request('/api/v3/movie/42/upgrade', {
      method: 'POST',
    })
    expect(r.status).toBe(401)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('400 bad_id for a non-numeric param', async () => {
    const r = await appUnderTest().request('/api/v3/movie/not-a-number/upgrade', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'bad_id' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('radarr POST /movie/:id/upgrade — release-search failure modes', () => {
  it('release search returns 502 → 502 release_search_failed with status', async () => {
    stubUpgradeSpaceOk()
    stub('/api/v3/release?movieId=42', { error: 'down' }, 502)
    const r = await appUnderTest().request('/api/v3/movie/42/upgrade', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(502)
    const body = (await r.json()) as { error: string; status: number }
    expect(body.error).toBe('release_search_failed')
    expect(body.status).toBe(502)
  })

  it('blocks upgrade with 507 when the movie root folder is below threshold', async () => {
    stub('/api/v3/movie/42', { id: 42, rootFolderPath: '/data/movies' })
    stub('/api/v3/rootfolder', [{ id: 1, path: '/data/movies', freeSpace: 25 * 1024 ** 3 }])
    const r = await appUnderTest().request('/api/v3/movie/42/upgrade', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(507)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('insufficient_disk_space')
  })

  it('release search returns empty array → 200 no_releases_found (no grab)', async () => {
    stubUpgradeSpaceOk()
    stub('/api/v3/release?movieId=42', [])
    const r = await appUnderTest().request('/api/v3/movie/42/upgrade', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ status: 'no_releases_found' })
  })

  it('all releases over cap → 200 no_upgrade_available with scanned count', async () => {
    // env.maxMovieBytes is 10 GB by default; a 50 GB 2160p rip is over.
    stubUpgradeSpaceOk()
    const over = 50 * 1024 ** 3
    stub('/api/v3/release?movieId=42', [
      { guid: 'g1', indexerId: 1, size: over, qualityWeight: 100, title: '4K HDR' },
      { guid: 'g2', indexerId: 1, size: over, qualityWeight: 90, title: '4K HDR alt' },
    ])
    const r = await appUnderTest().request('/api/v3/movie/42/upgrade', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { status: string; scanned: number; capGb: number }
    expect(body.status).toBe('no_upgrade_available')
    expect(body.scanned).toBe(2)
    expect(typeof body.capGb).toBe('number')
  })

  it('rejected:true releases are excluded from eligibility', async () => {
    // Two releases under the cap, but both are rejected by Radarr's
    // profile/quality scorer — the route should treat the eligible set
    // as empty and return no_upgrade_available rather than grabbing.
    stubUpgradeSpaceOk()
    const under = 2 * 1024 ** 3
    stub('/api/v3/release?movieId=42', [
      { guid: 'g1', indexerId: 1, size: under, qualityWeight: 100, title: '1080p', rejected: true },
      { guid: 'g2', indexerId: 1, size: under, qualityWeight: 90, title: '720p', rejected: true },
    ])
    const r = await appUnderTest().request('/api/v3/movie/42/upgrade', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { status: string }
    expect(body.status).toBe('no_upgrade_available')
  })
})

describe('radarr POST /movie/:id/upgrade — grab path', () => {
  it('Radarr returns 502 on the grab POST → 502 grab_failed', async () => {
    stubUpgradeSpaceOk()
    const under = 2 * 1024 ** 3
    stub('/api/v3/release?movieId=42', [
      { guid: 'g1', indexerId: 1, size: under, qualityWeight: 100, title: '1080p good' },
    ])
    // POST /api/v3/release fails. The endsWith/includes matcher in the
    // stub helper picks the more-specific GET suffix first; the bare
    // path matches the POST.
    stub('/api/v3/release', { error: 'indexer 502' }, 502)
    const r = await appUnderTest().request('/api/v3/movie/42/upgrade', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(502)
    const body = (await r.json()) as { error: string; status: number }
    expect(body.error).toBe('grab_failed')
    expect(body.status).toBe(502)
  })

  it('happy path: best release is grabbed and "grabbing" status returned', async () => {
    stubUpgradeSpaceOk()
    const sizeBytes = 3 * 1024 ** 3 // 3 GB
    stub('/api/v3/release?movieId=42', [
      { guid: 'a', indexerId: 1, size: sizeBytes, qualityWeight: 80, title: '1080p okay' },
      { guid: 'b', indexerId: 1, size: sizeBytes, qualityWeight: 120, title: '1080p best' },
    ])
    stub('/api/v3/release', { id: 1 }, 201)
    const r = await appUnderTest().request('/api/v3/movie/42/upgrade', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      status: string
      title: string
      sizeGb: number
      qualityWeight: number
    }
    expect(body.status).toBe('grabbing')
    expect(body.title).toBe('1080p best') // highest qualityWeight wins
    expect(body.qualityWeight).toBe(120)
    expect(body.sizeGb).toBeCloseTo(3, 1)
  })
})

// Burn-it-all audit fixes — confirm each silent-failure fix actually fires.
//
// These tests use env.defaultRadarrRootFolderPath = '/data/media/movies'
// (set in vitest setup or default). The mocks below return paths that
// differ ONLY in slash / case to verify the new normalizePath() match.
describe('radarr non-admin add — path matching tolerance (burn-it-all fixes)', () => {
  it('matches root folder ignoring trailing slash on the upstream side', async () => {
    let captured: Record<string, unknown> | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/api/v3/rootfolder')) {
          // Upstream returns a trailing slash; env default has none.
          return new Response(
            JSON.stringify([{ id: 1, path: '/data/media/movies/', freeSpace: 500 * 1024 ** 3 }]),
            { status: 200 },
          )
        }
        if (url.includes('/api/v3/qualityprofile')) {
          return new Response(JSON.stringify([{ id: 7, name: 'Choose Me' }]), { status: 200 })
        }
        if (url.endsWith('/api/v3/movie') && init?.method === 'POST') {
          captured = JSON.parse(init.body as string)
          return new Response(JSON.stringify({ id: 999, title: 'X' }), { status: 201 })
        }
        if (url.includes('/api/v3/release?movieId=999')) {
          return new Response(
            JSON.stringify([
              { guid: 'g-999', indexerId: 1, size: 2 * 1024 ** 3, qualityWeight: 100, title: 'X 1080p' },
            ]),
            { status: 200 },
          )
        }
        if (url.endsWith('/api/v3/release') && init?.method === 'POST') {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'X', tmdbId: 1 }),
    })
    expect(r.status).toBe(201)
    expect(captured).not.toBeNull()
    // The upstream's trailing-slash path is forwarded verbatim — no
    // normalization on write, only on comparison.
    expect((captured as unknown as Record<string, unknown>).rootFolderPath).toBe('/data/media/movies/')
  })

  it('matches root folder ignoring case differences', async () => {
    let captured: Record<string, unknown> | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/api/v3/rootfolder')) {
          // Upstream returns mixed case; env default is lowercase.
          return new Response(
            JSON.stringify([{ id: 1, path: '/Data/Media/Movies', freeSpace: 500 * 1024 ** 3 }]),
            { status: 200 },
          )
        }
        if (url.includes('/api/v3/qualityprofile')) {
          return new Response(JSON.stringify([{ id: 7, name: 'Choose Me' }]), { status: 200 })
        }
        if (url.endsWith('/api/v3/movie') && init?.method === 'POST') {
          captured = JSON.parse(init.body as string)
          return new Response(JSON.stringify({ id: 999, title: 'X' }), { status: 201 })
        }
        if (url.includes('/api/v3/release?movieId=999')) {
          return new Response(
            JSON.stringify([
              { guid: 'g-999', indexerId: 1, size: 2 * 1024 ** 3, qualityWeight: 100, title: 'X 1080p' },
            ]),
            { status: 200 },
          )
        }
        if (url.endsWith('/api/v3/release') && init?.method === 'POST') {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'X', tmdbId: 1 }),
    })
    expect(r.status).toBe(201)
    expect(captured).not.toBeNull()
  })

  it('matches quality profile name even with trailing whitespace', async () => {
    let captured: Record<string, unknown> | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(
            JSON.stringify([{ id: 1, path: '/data/media/movies', freeSpace: 500 * 1024 ** 3 }]),
            { status: 200 },
          )
        }
        if (url.includes('/api/v3/qualityprofile')) {
          // Sneaky trailing space in the profile name. Pre-fix this would 503.
          return new Response(JSON.stringify([{ id: 7, name: 'Choose Me ' }]), { status: 200 })
        }
        if (url.endsWith('/api/v3/movie') && init?.method === 'POST') {
          captured = JSON.parse(init.body as string)
          return new Response(JSON.stringify({ id: 999, title: 'X' }), { status: 201 })
        }
        if (url.includes('/api/v3/release?movieId=999')) {
          return new Response(
            JSON.stringify([
              { guid: 'g-999', indexerId: 1, size: 2 * 1024 ** 3, qualityWeight: 100, title: 'X 1080p' },
            ]),
            { status: 200 },
          )
        }
        if (url.endsWith('/api/v3/release') && init?.method === 'POST') {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'X', tmdbId: 1 }),
    })
    expect(r.status).toBe(201)
    expect(captured).not.toBeNull()
    expect((captured as unknown as Record<string, unknown>).qualityProfileId).toBe(7)
  })

  // Test for `default_root_folder_missing` payload (expected_path + available_paths)
  // omitted here: it would require stubbing DEFAULT_RADARR_ROOT_FOLDER_PATH at
  // module-import time, and the existing test scaffolding loads env once at
  // process start. The 503 path itself is exercised in production by anyone
  // whose configured default path doesn't match any upstream folder after the
  // case/slash normalization above; the case/slash tolerance tests above
  // already confirm the comparator is the only thing that changed.
})

describe('per-session rate limit middleware (finding 4-0)', () => {
  // Exercise the token-bucket directly on a tiny app so the assertion is about
  // the limiter mechanism, not the auth/upstream stack the *arr routes layer on
  // top — and so this test uses its OWN bucket names and cannot drain the
  // shared 'radarr-mutate' bucket the route tests rely on. A request whose
  // session.sub is set is keyed by sub; the first `capacity` requests pass
  // through, then the bucket empties and the next is refused with 429 before
  // the handler runs. This is the exact middleware mounted on the *arr/SAB
  // mutate routes.
  it('admits `capacity` requests then 429s the next, keyed per session', async () => {
    const { rateLimit, __resetRateLimitsForTests } = await import('../middleware/rateLimit.js')
    __resetRateLimitsForTests()

    let handlerHits = 0
    const limiter = rateLimit({ name: 'rl-unit-1', capacity: 3, refill: 3, intervalMs: 60_000 })
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      c.set('session', { sub: 'plex:rl', username: 'rl', role: 'user' } as never)
      await next()
    })
    app.post('/x', limiter, (c) => {
      handlerHits++
      return c.json({ ok: true })
    })

    const statuses: number[] = []
    for (let i = 0; i < 4; i++) {
      const r = await app.request('/x', { method: 'POST' })
      statuses.push(r.status)
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200])
    expect(statuses[3]).toBe(429)
    expect(handlerHits).toBe(3)
  })

  it('429 body carries the rate_limited error code', async () => {
    const { rateLimit, __resetRateLimitsForTests } = await import('../middleware/rateLimit.js')
    __resetRateLimitsForTests()
    const limiter = rateLimit({ name: 'rl-unit-2', capacity: 1, refill: 1, intervalMs: 60_000 })
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      c.set('session', { sub: 'plex:rl2', username: 'rl2', role: 'user' } as never)
      await next()
    })
    app.post('/x', limiter, (c) => c.json({ ok: true }))
    await app.request('/x', { method: 'POST' })
    const r = await app.request('/x', { method: 'POST' })
    expect(r.status).toBe(429)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('rate_limited')
  })

  it('separate sessions get independent budgets', async () => {
    const { rateLimit, __resetRateLimitsForTests } = await import('../middleware/rateLimit.js')
    __resetRateLimitsForTests()
    const limiter = rateLimit({ name: 'rl-unit-3', capacity: 1, refill: 1, intervalMs: 60_000 })
    const make = (sub: string) => {
      const app = new Hono<Env>()
      app.use('*', async (c, next) => {
        c.set('session', { sub, username: sub, role: 'user' } as never)
        await next()
      })
      app.post('/x', limiter, (c) => c.json({ ok: true }))
      return app
    }
    const a = make('plex:a')
    const b = make('plex:b')
    expect((await a.request('/x', { method: 'POST' })).status).toBe(200)
    expect((await a.request('/x', { method: 'POST' })).status).toBe(429)
    expect((await b.request('/x', { method: 'POST' })).status).toBe(200)
  })
})

// In-flight byte-reservation concurrency on the movie-add grab path.
//
// Unlike sonarr, the radarr POST /api/v3/movie handler AWAITS
// grabBestUnderCap, which has a 1.5 s real setTimeout before the release
// search. We drive a fake-timer clock and use vi.runAllTimersAsync() (or
// fire two adds via Promise.all and advance once) so nothing waits on
// wall-clock.
//
// Observed production behavior (radarr.ts):
//   - grabBestUnderCap filters eligible releases by
//     `availableBytes - r.size >= env.minFreeBytes` (line ~200), where
//     availableBytes already subtracts in-flight reservations. So while one
//     add holds a reservation, a concurrent add against the SAME path sees
//     reduced availability and can find NO eligible release → it records an
//     'all_rejected_by_cap' grab event and the route returns 424
//     'capped_grab_not_started'.
//   - radarr ALWAYS releases the reservation right after the grab POST
//     (line ~251), on success AND failure — the opposite of sonarr's
//     retain-on-success. So a sequential follow-up add reliably reclaims the
//     space.
//
// The module-global pendingRadarrReservations Map is not exported / not
// reset, so each test uses its OWN root-folder path (reservations are keyed
// by path) to avoid cross-test leakage.
describe('radarr movie-add in-flight reservation', () => {
  const FOUR_GB = 4 * 1024 ** 3 // under the 10 GB movie cap
  // Fits exactly one 4 GB reservation above the 100 GB reserve with ~3 GB
  // slack — a second concurrent 4 GB reservation cannot also clear the gate.
  const TIGHT_FREE = env.minFreeBytes + 7 * 1024 ** 3

  type AddStubs = {
    path: string
    movieId: number
    freeSpace?: number
    grabStatus?: number
    holdPost?: (resolve: () => void) => void
  }

  // Stub the admin add path (rootFolderPath supplied → admin passthrough):
  // GET rootfolder, POST movie, GET release?movieId, POST release grab.
  function stubMovieAdd(calls: Array<{ url: string; method: string }>, s: AddStubs) {
    const freeSpace = s.freeSpace ?? TIGHT_FREE
    const grabStatus = s.grabStatus ?? 200
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        calls.push({ url, method })
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([{ id: 1, path: s.path, freeSpace }]), { status: 200 })
        }
        if (url.endsWith('/api/v3/movie') && method === 'POST') {
          return new Response(JSON.stringify({ id: s.movieId, title: 'Reserved Movie' }), { status: 201 })
        }
        if (url.includes(`/api/v3/release?movieId=${s.movieId}`)) {
          return new Response(
            JSON.stringify([
              { guid: `g-${s.movieId}`, indexerId: 1, size: FOUR_GB, qualityWeight: 100, title: 'Reserved Movie 1080p' },
            ]),
            { status: 200 },
          )
        }
        if (url.endsWith('/api/v3/release') && method === 'POST') {
          if (s.holdPost) {
            return new Promise<Response>((resolve) => {
              s.holdPost!(() => resolve(new Response('{}', { status: grabStatus })))
            })
          }
          return new Response(JSON.stringify({ ok: grabStatus < 400 }), { status: grabStatus })
        }
        // DELETE rollback on the failure path returns OK.
        if (url.includes(`/api/v3/movie/${s.movieId}`) && method === 'DELETE') {
          return new Response('', { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
  }

  function addMovie(cookie: string, path: string): Promise<Response> {
    return Promise.resolve(appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rootFolderPath: path,
        title: 'Reserved Movie',
        qualityProfileId: 7,
        monitored: true,
        addOptions: { searchForMovie: true },
      }),
    }))
  }

  function grabPostCount(calls: Array<{ url: string; method: string }>) {
    return calls.filter((c) => c.url.endsWith('/api/v3/release') && c.method === 'POST').length
  }

  // Drive the awaited grab pipeline forward under fake timers. The handler's
  // first awaits (body parse, auth, the grab POST) have NO timer; only later
  // does grabBestUnderCap schedule its single real 1.5 s release setTimeout.
  //
  // The old helper advanced a FIXED number of rounds, then the test did
  // `await p`. Under the parallel-suite CI load the chain progressed slower, so
  // that timer was sometimes scheduled AFTER the fixed rounds ended — and with
  // the clock frozen it never fired, hanging `await p` to the test timeout (a
  // pass-here/hang-there flake). Looping on a PREDICATE instead of a fixed
  // count fires the timer no matter how late it appears.

  // Advance fake time (interleaved with microtask drains) until `done()` holds.
  async function advanceUntil(done: () => boolean, maxFakeMs = 60_000): Promise<void> {
    for (let elapsed = 0; elapsed < maxFakeMs && !done(); elapsed += 250) {
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(250)
    }
  }

  // Advance fake time until the request promise settles, then return it. This
  // is race-free: it keeps firing timers until THIS request is done, so a
  // late-scheduled release timer can never strand the awaited response.
  async function settle<T>(p: T | PromiseLike<T>): Promise<T> {
    let settled = false
    const tracked = Promise.resolve(p).then(
      (v) => ((settled = true), v),
      (e) => ((settled = true), Promise.reject(e)),
    )
    await advanceUntil(() => settled)
    return tracked
  }

  let appendSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.useFakeTimers()
    // Keep the grab log off disk so the awaited grab pipeline never blocks on
    // real fs I/O (which fake timers don't drain) — mirrors the sonarr suite.
    appendSpy = vi.spyOn(grabLog, 'appendGrabEvent').mockResolvedValue(undefined)
  })
  afterEach(() => {
    appendSpy.mockRestore()
    vi.useRealTimers()
  })

  it('CONCURRENT OVERCOMMIT: while one add holds its reservation, a second same-folder add finds no eligible release and is refused (424 capped_grab_not_started, no second grab POST)', async () => {
    // Hold add #1's grab POST open so its 4 GB reservation stays on the books.
    // Add #2 plans against the SAME path: availableBytes is now reduced, so
    // its only release (4 GB) fails the `available - size >= minFree` filter,
    // leaving the eligible set empty → 424 capped_grab_not_started with NO
    // grab POST of its own.
    const path = '/data/movies-overcommit'
    const calls: Array<{ url: string; method: string }> = []
    const resolvers: Array<() => void> = []
    // movieId differs per add so the release-search stub matches each; both
    // share the same root-folder path / reservation bucket.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        calls.push({ url, method })
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([{ id: 1, path, freeSpace: TIGHT_FREE }]), { status: 200 })
        }
        if (url.endsWith('/api/v3/movie') && method === 'POST') {
          const movieId = JSON.parse(String(init?.body)).title === 'Add One' ? 101 : 102
          return new Response(JSON.stringify({ id: movieId, title: 'Reserved Movie' }), { status: 201 })
        }
        if (url.includes('/api/v3/release?movieId=')) {
          const movieId = url.includes('movieId=101') ? 101 : 102
          return new Response(
            JSON.stringify([
              { guid: `g-${movieId}`, indexerId: 1, size: FOUR_GB, qualityWeight: 100, title: 'Reserved Movie 1080p' },
            ]),
            { status: 200 },
          )
        }
        if (url.endsWith('/api/v3/release') && method === 'POST') {
          // Hold the FIRST grab POST open; subsequent ones (none expected) resolve.
          return new Promise<Response>((resolve) => {
            resolvers.push(() => resolve(new Response('{}', { status: 200 })))
          })
        }
        if (url.includes('/api/v3/movie/10') && method === 'DELETE') {
          return new Response('', { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const cookie = await adminCookie()
    const add1 = appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rootFolderPath: path, title: 'Add One', qualityProfileId: 7, monitored: true, addOptions: { searchForMovie: true } }),
    })
    // Advance past add #1's 1.5 s delay so it reserves + posts (then hangs).
    await advanceUntil(() => resolvers.length === 1)
    expect(resolvers.length).toBe(1)
    const postsAfterOne = grabPostCount(calls)

    // Add #2 against the same path while #1's reservation is held.
    const add2Promise = appUnderTest().request('/api/v3/movie', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rootFolderPath: path, title: 'Add Two', qualityProfileId: 7, monitored: true, addOptions: { searchForMovie: true } }),
    })
    const r2 = await settle(add2Promise)
    expect(r2.status).toBe(424)
    const body2 = (await r2.json()) as { error?: string; phase?: string }
    expect(body2.error).toBe('capped_grab_not_started')
    expect(body2.phase).toBe('all_rejected_by_cap')
    // Add #2 issued NO grab POST (it was refused at the eligibility filter).
    expect(grabPostCount(calls)).toBe(postsAfterOne)

    // Release add #1 so its awaited handler can settle.
    resolvers.forEach((fn) => fn())
    await settle(add1)
  })

  it('RESERVATION RELEASED ON COMPLETION: radarr releases after every grab, so a sequential same-folder add succeeds and issues its own grab POST', async () => {
    // Add #1 grabs successfully (201). radarr releases the reservation right
    // after the grab POST (always), so add #2 on the SAME path reclaims the
    // space, grabs, and returns ordinary success (201 from the upstream add).
    const path = '/data/movies-release'
    const calls1: Array<{ url: string; method: string }> = []
    stubMovieAdd(calls1, { path, movieId: 201, grabStatus: 201 })
    const r1 = await settle(addMovie(await adminCookie(), path))
    expect(r1.status).toBe(201)
    expect(grabPostCount(calls1)).toBe(1)

    const calls2: Array<{ url: string; method: string }> = []
    stubMovieAdd(calls2, { path, movieId: 202, grabStatus: 201 })
    const r2 = await settle(addMovie(await adminCookie(), path))
    expect(r2.status).toBe(201)
    expect(grabPostCount(calls2)).toBe(1)
  })

  it('RESERVATION RELEASED ON FAILED GRAB: a non-ok grab POST still releases the reservation so a follow-up add can grab', async () => {
    // Add #1's grab POST returns 500 → 424 capped_grab_failed + rollback. The
    // reservation is released anyway, so a follow-up same-folder add grabs.
    const path = '/data/movies-failrelease'
    const calls1: Array<{ url: string; method: string }> = []
    stubMovieAdd(calls1, { path, movieId: 301, grabStatus: 500 })
    const r1 = await settle(addMovie(await adminCookie(), path))
    expect(r1.status).toBe(424)
    const body1 = (await r1.json()) as { error?: string }
    expect(body1.error).toBe('capped_grab_failed')
    expect(grabPostCount(calls1)).toBe(1)

    const calls2: Array<{ url: string; method: string }> = []
    stubMovieAdd(calls2, { path, movieId: 302, grabStatus: 201 })
    const r2 = await settle(addMovie(await adminCookie(), path))
    expect(r2.status).toBe(201)
    expect(grabPostCount(calls2)).toBe(1)
  })
})

// ===========================================================================
// Advanced options (R1–R6). Mirror the Sonarr S1–S7 assertions: admin gate,
// command allowlist, PUT field allowlist, interactive-grab cap + allowOverCap
// override + grab-event logging, upstream-error mapping.
// ===========================================================================
describe('radarr advanced — R1 POST /api/v3/command', () => {
  it('rejects user role with 403 and does not forward', async () => {
    const r = await appUnderTest().request('/api/v3/command', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'RefreshMovie', movieIds: [1] }),
    })
    expect(r.status).toBe(403)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('400 command_not_allowed for a disallowed name', async () => {
    const r = await appUnderTest().request('/api/v3/command', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Backup' }),
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'command_not_allowed' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('400 missing_required_field when RefreshMovie has no movieIds', async () => {
    const r = await appUnderTest().request('/api/v3/command', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'RefreshMovie' }),
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'missing_required_field' })
  })

  it('forwards only allowlisted fields and returns the upstream ack', async () => {
    let captured: Record<string, unknown> | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.endsWith('/api/v3/command') && init?.method === 'POST') {
          captured = JSON.parse(init.body as string)
          return new Response(JSON.stringify({ id: 3, name: 'MoviesSearch', status: 'started' }), { status: 201 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/command', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'MoviesSearch', movieIds: [42], evil: 'x' }),
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ id: 3, name: 'MoviesSearch', status: 'started' })
    expect(captured).toEqual({ name: 'MoviesSearch', movieIds: [42] })
  })

  it('502 command_failed when upstream rejects', async () => {
    stub('/api/v3/command', { error: 'nope' }, 500)
    const r = await appUnderTest().request('/api/v3/command', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'RefreshMovie', movieIds: [1] }),
    })
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ error: 'command_failed', status: 500 })
  })
})

describe('radarr advanced — R2 GET /api/v3/release', () => {
  it('rejects user role with 403', async () => {
    const r = await appUnderTest().request('/api/v3/release?movieId=1', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(403)
  })

  it('400 bad_movieId without a valid movieId', async () => {
    const r = await appUnderTest().request('/api/v3/release?movieId=0', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'bad_movieId' })
  })

  it('projects releases with sizeGb + overCap against the flat movie cap (10 GB default)', async () => {
    const GB = 1024 ** 3
    stub('/api/v3/release', [
      {
        guid: 'big', indexerId: 1, title: 'Big', size: 30 * GB, qualityWeight: 80, protocol: 'torrent',
        seeders: 50, indexer: 'IPT', quality: { quality: { name: 'Bluray-2160p' } },
        languages: [{ name: 'English' }], rejected: false, rejections: [],
      },
      {
        guid: 'small', indexerId: 1, title: 'Small', size: 4 * GB, qualityWeight: 40, protocol: 'usenet',
        quality: { quality: { name: 'WEBDL-1080p' } }, languages: [{ name: 'English' }],
        rejected: true, rejections: ['Not an upgrade'],
      },
    ])
    const r = await appUnderTest().request('/api/v3/release?movieId=5', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    const rows = (await r.json()) as Array<Record<string, unknown>>
    const byGuid = Object.fromEntries(rows.map((x) => [x.guid as string, x]))
    expect(byGuid.big.overCap).toBe(true) // 30 GB > 10 GB cap
    expect(byGuid.big.seeders).toBe(50)
    expect(byGuid.big.protocol).toBe('torrent')
    expect(byGuid.small.overCap).toBe(false) // 4 GB < 10 GB
    expect(byGuid.small.rejected).toBe(true)
    expect(byGuid.small.rejections).toEqual(['Not an upgrade'])
  })

  it('502 release_search_failed when upstream errors', async () => {
    stub('/api/v3/release', { error: 'boom' }, 500)
    const r = await appUnderTest().request('/api/v3/release?movieId=5', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ error: 'release_search_failed', status: 500 })
  })
})

describe('radarr advanced — R3 POST /api/v3/release (interactive grab)', () => {
  const GB = 1024 ** 3

  function stubGrab(opts: { size: number; grabStatus?: number; onGrab?: (b: Record<string, unknown>) => void }) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        if (url.includes('/api/v3/release') && method === 'GET') {
          return new Response(
            JSON.stringify([
              { guid: 'pick', indexerId: 9, title: 'Picked Movie', size: opts.size, qualityWeight: 50, protocol: 'usenet' },
            ]),
            { status: 200 },
          )
        }
        if (url.includes('/api/v3/release') && method === 'POST') {
          if (opts.onGrab) opts.onGrab(JSON.parse(init!.body as string))
          return new Response(JSON.stringify({ ok: true }), { status: opts.grabStatus ?? 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
  }

  let appendSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    appendSpy = vi.spyOn(grabLog, 'appendGrabEvent').mockResolvedValue(undefined)
  })
  afterEach(() => appendSpy.mockRestore())
  function eventTypes() {
    return (grabLog.appendGrabEvent as ReturnType<typeof vi.fn>).mock.calls.map(
      ([e]) => (e as { type?: string }).type,
    )
  }
  // Full recorded events so we can assert the grab was logged with the right
  // item/release/attribution fields (the audit-flagged gap on this path).
  function recordedEvents() {
    return (grabLog.appendGrabEvent as ReturnType<typeof vi.fn>).mock.calls.map(
      ([e]) => e as Record<string, unknown>,
    )
  }

  it('rejects user role with 403', async () => {
    const r = await appUnderTest().request('/api/v3/release?movieId=5', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid: 'pick', indexerId: 9 }),
    })
    expect(r.status).toBe(403)
  })

  it('424 over_cap without override; no grab POST, logs a cap event', async () => {
    let grabbed = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        if (url.includes('/api/v3/release') && method === 'GET') {
          return new Response(
            JSON.stringify([{ guid: 'pick', indexerId: 9, title: 'Huge', size: 30 * GB, qualityWeight: 50 }]),
            { status: 200 },
          )
        }
        if (url.includes('/api/v3/release') && method === 'POST') {
          grabbed = true
          return new Response('{}', { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/release?movieId=5', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid: 'pick', indexerId: 9 }),
    })
    expect(r.status).toBe(424)
    expect(((await r.json()) as { error: string }).error).toBe('over_cap')
    expect(grabbed).toBe(false)
    expect(eventTypes()).toContain('all_rejected_by_cap')
  })

  it('grabs an over-cap release with allowOverCap:true and forwards only guid+indexerId', async () => {
    let grabBody: Record<string, unknown> | null = null
    stubGrab({ size: 30 * GB, onGrab: (b) => { grabBody = b } })
    const r = await appUnderTest().request('/api/v3/release?movieId=5', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid: 'pick', indexerId: 9, allowOverCap: true }),
    })
    expect(r.status).toBe(200)
    expect(((await r.json()) as { status: string }).status).toBe('grabbed')
    expect(grabBody).toEqual({ guid: 'pick', indexerId: 9 })
    expect(eventTypes()).toEqual(expect.arrayContaining(['grab_started', 'grab_succeeded']))
    // The override grab MUST be recorded through the grab-event log with the
    // right item/release/attribution fields (audit gap closed here).
    const succeeded = recordedEvents().find((e) => e.type === 'grab_succeeded')
    expect(succeeded, 'expected a grab_succeeded event recorded for the override grab').toBeDefined()
    expect(succeeded!.itemId).toBe(5) // movieId from the query scope
    expect(succeeded!.title).toBe('Picked Movie')
    expect(succeeded!.capGb).toBe(env.maxMovieGb)
    // sub is the session subject — present so the grab is attributable in the
    // audit log / /by-item scoping (exact value is session-derived).
    expect(typeof succeeded!.sub).toBe('string')
    expect(succeeded!.sub).toBeTruthy()
    expect((succeeded!.release as { sizeBytes?: number }).sizeBytes).toBe(30 * GB)
  })

  it('grabs a within-cap release without override and records the grab event', async () => {
    stubGrab({ size: 4 * GB })
    const r = await appUnderTest().request('/api/v3/release?movieId=5', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid: 'pick', indexerId: 9 }),
    })
    expect(r.status).toBe(200)
    expect(((await r.json()) as { status: string }).status).toBe('grabbed')
    const succeeded = recordedEvents().find((e) => e.type === 'grab_succeeded')
    expect(succeeded, 'expected appendGrabEvent to record a grab_succeeded event').toBeDefined()
    expect(succeeded!.itemId).toBe(5)
    expect(succeeded!.title).toBe('Picked Movie')
    expect((succeeded!.release as { sizeBytes?: number }).sizeBytes).toBe(4 * GB)
  })

  it('404 release_not_found when guid+indexerId is not in the re-search', async () => {
    stubGrab({ size: 4 * GB })
    const r = await appUnderTest().request('/api/v3/release?movieId=5', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid: 'ghost', indexerId: 9 }),
    })
    expect(r.status).toBe(404)
  })

  it('502 grab_failed and logs grab_failed on upstream grab error', async () => {
    stubGrab({ size: 4 * GB, grabStatus: 500 })
    const r = await appUnderTest().request('/api/v3/release?movieId=5', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid: 'pick', indexerId: 9 }),
    })
    expect(r.status).toBe(502)
    expect(((await r.json()) as { error: string }).error).toBe('grab_failed')
    expect(eventTypes()).toContain('grab_failed')
  })
})

describe('radarr advanced — R5 GET /api/v3/history/movie', () => {
  it('rejects user role with 403', async () => {
    const r = await appUnderTest().request('/api/v3/history/movie?movieId=1', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(403)
  })

  it('maps a bare-array upstream history to the slim shape', async () => {
    stub('/api/v3/history/movie', [
      { date: '2026-06-22T00:00:00Z', eventType: 'grabbed', sourceTitle: 'Movie 2026', quality: { quality: { name: 'WEBDL-1080p' } } },
    ])
    const r = await appUnderTest().request('/api/v3/history/movie?movieId=5', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    const rows = (await r.json()) as Array<Record<string, unknown>>
    expect(rows[0]).toEqual({
      date: '2026-06-22T00:00:00Z', eventType: 'grabbed', sourceTitle: 'Movie 2026', quality: 'WEBDL-1080p',
    })
  })
})

describe('radarr advanced — R6 PUT /api/v3/movie/:id (edit)', () => {
  it('rejects user role with 403', async () => {
    const r = await appUnderTest().request('/api/v3/movie/5', {
      method: 'PUT',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ monitored: false }),
    })
    expect(r.status).toBe(403)
  })

  it('overlays ONLY allowlisted fields onto the full movie, ignoring extras', async () => {
    let putBody: Record<string, unknown> | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        if (url.includes('/api/v3/movie/5') && method === 'GET') {
          return new Response(
            JSON.stringify({
              id: 5, title: 'Existing Movie', monitored: true, qualityProfileId: 1,
              rootFolderPath: '/data/movies', path: '/data/movies/Existing', tmdbId: 999,
            }),
            { status: 200 },
          )
        }
        if (url.includes('/api/v3/movie/5') && method === 'PUT') {
          putBody = JSON.parse(init!.body as string)
          return new Response(JSON.stringify(putBody), { status: 202 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/movie/5', {
      method: 'PUT',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        monitored: false, qualityProfileId: 7, rootFolderPath: '/data/movies2',
        title: 'HACKED', tmdbId: 1, path: '/etc/passwd',
      }),
    })
    expect(r.status).toBe(202)
    expect(putBody!.monitored).toBe(false)
    expect(putBody!.qualityProfileId).toBe(7)
    expect(putBody!.rootFolderPath).toBe('/data/movies2')
    // Full object preserved; client overwrite attempts ignored.
    expect(putBody!.title).toBe('Existing Movie')
    expect(putBody!.tmdbId).toBe(999)
    expect(putBody!.path).toBe('/data/movies/Existing')
    expect(putBody!.id).toBe(5)
  })

  it('502 movie_lookup_failed when the upstream GET fails (no PUT attempted)', async () => {
    let putAttempted = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        if (url.includes('/api/v3/movie/5') && method === 'GET') {
          return new Response('{"error":"no"}', { status: 404 })
        }
        if (url.includes('/api/v3/movie/5') && method === 'PUT') {
          putAttempted = true
          return new Response('{}', { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/movie/5', {
      method: 'PUT',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ monitored: false }),
    })
    expect(r.status).toBe(502)
    expect(((await r.json()) as { error: string }).error).toBe('movie_lookup_failed')
    expect(putAttempted).toBe(false)
  })
})

describe('radarr advanced — R4 GET /api/v3/rename', () => {
  it('rejects user role with 403', async () => {
    const r = await appUnderTest().request('/api/v3/rename?movieId=1', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(403)
  })

  it('projects the rename diff rows', async () => {
    stub('/api/v3/rename', [
      { movieFileId: 1, existingPath: '/old/m.mkv', newPath: '/new/m.mkv', extra: 'drop' },
    ])
    const r = await appUnderTest().request('/api/v3/rename?movieId=5', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    const rows = (await r.json()) as Array<Record<string, unknown>>
    expect(rows[0]).toEqual({ movieFileId: 1, existingPath: '/old/m.mkv', newPath: '/new/m.mkv' })
  })

  it('400 bad_movieId without a valid movieId', async () => {
    const r = await appUnderTest().request('/api/v3/rename?movieId=0', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'bad_movieId' })
  })

  it('502 rename_preview_failed when upstream errors', async () => {
    stub('/api/v3/rename', { error: 'boom' }, 500)
    const r = await appUnderTest().request('/api/v3/rename?movieId=5', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ error: 'rename_preview_failed', status: 500 })
  })
})

// Error-path coverage for the new advanced handlers (upstream-failure 502
// branches + remaining bad-param 400s the happy-path tests don't reach).
describe('radarr advanced — error-path branches', () => {
  it('R5 400 bad_movieId and 502 history_failed', async () => {
    const bad = await appUnderTest().request('/api/v3/history/movie?movieId=x', {
      headers: { Cookie: await adminCookie() },
    })
    expect(bad.status).toBe(400)

    stub('/api/v3/history/movie', { error: 'boom' }, 503)
    const fail = await appUnderTest().request('/api/v3/history/movie?movieId=5', {
      headers: { Cookie: await adminCookie() },
    })
    expect(fail.status).toBe(502)
    expect(await fail.json()).toEqual({ error: 'history_failed', status: 503 })
  })

  it('R6 400 bad_id and 502 movie_update_failed', async () => {
    const bad = await appUnderTest().request('/api/v3/movie/0', {
      method: 'PUT',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ monitored: false }),
    })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'bad_id' })

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        if (url.includes('/api/v3/movie/9') && method === 'GET') {
          return new Response(JSON.stringify({ id: 9, title: 'X', monitored: true }), { status: 200 })
        }
        if (url.includes('/api/v3/movie/9') && method === 'PUT') {
          return new Response('{"error":"validation"}', { status: 400 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const fail = await appUnderTest().request('/api/v3/movie/9', {
      method: 'PUT',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ monitored: false }),
    })
    expect(fail.status).toBe(502)
    expect(await fail.json()).toEqual({ error: 'movie_update_failed', status: 400 })
  })

  it('R6 502 movie_lookup_failed when the upstream GET fails', async () => {
    stub('/api/v3/movie/9', { error: 'no' }, 404)
    const r = await appUnderTest().request('/api/v3/movie/9', {
      method: 'PUT',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ monitored: false }),
    })
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ error: 'movie_lookup_failed', status: 404 })
  })

  it('R1 ack tolerates a non-JSON upstream body via the catch path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.endsWith('/api/v3/command') && init?.method === 'POST') {
          return new Response('not json', { status: 200, headers: { 'Content-Type': 'text/plain' } })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/command', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'RefreshMovie', movieIds: [1] }),
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ id: undefined, name: undefined, status: undefined })
  })
})

describe('radarr advanced — malformed body & non-JSON upstream branches', () => {
  // A 200 from Radarr whose body is not JSON: the handler must fall back
  // (empty projection / empty history), never throw.
  function stubNonJson(suffix: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes(suffix)) {
          return new Response('<<garbage not json>>', { status: 200, headers: { 'Content-Type': 'text/plain' } })
        }
        return new Response('[]', { status: 200 })
      }),
    )
  }

  it('R1 400 invalid_command when the request body is not JSON', async () => {
    const r = await appUnderTest().request('/api/v3/command', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: '{not valid json',
    })
    expect(r.status).toBe(400)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('R2 returns [] when the upstream release body is not JSON (200)', async () => {
    stubNonJson('/api/v3/release')
    const r = await appUnderTest().request('/api/v3/release?movieId=7', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([])
  })

  it('R3 400 invalid_body when the grab request body is not JSON', async () => {
    const r = await appUnderTest().request('/api/v3/release?movieId=7', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: 'definitely-not-json',
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'invalid_body' })
  })

  it('R3 404 release_not_found when the upstream release list is not JSON', async () => {
    stubNonJson('/api/v3/release')
    const r = await appUnderTest().request('/api/v3/release?movieId=7', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid: 'g', indexerId: 1 }),
    })
    expect(r.status).toBe(404)
    expect(await r.json()).toEqual({ error: 'release_not_found' })
  })

  it('R4 returns [] when the upstream rename body is not JSON (200)', async () => {
    stubNonJson('/api/v3/rename')
    const r = await appUnderTest().request('/api/v3/rename?movieId=7', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([])
  })

  it('R5 returns [] when the upstream history body is not JSON (200)', async () => {
    stubNonJson('/api/v3/history/movie')
    const r = await appUnderTest().request('/api/v3/history/movie?movieId=7', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([])
  })

  it('R6 treats a non-JSON edit body as an empty patch (full object preserved)', async () => {
    let putBody: Record<string, unknown> | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        if (url.includes('/api/v3/movie/9') && method === 'GET') {
          return new Response(JSON.stringify({ id: 9, title: 'X', monitored: true, qualityProfileId: 4 }), { status: 200 })
        }
        if (url.includes('/api/v3/movie/9') && method === 'PUT') {
          putBody = JSON.parse(init?.body as string)
          return new Response(JSON.stringify(putBody), { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/movie/9', {
      method: 'PUT',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: 'not-json-at-all',
    })
    expect(r.status).toBe(200)
    // Empty patch → upstream object round-trips unchanged.
    expect(putBody).toEqual({ id: 9, title: 'X', monitored: true, qualityProfileId: 4 })
  })
})
