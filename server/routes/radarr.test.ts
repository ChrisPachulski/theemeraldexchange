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
  // Non-admin add requests cannot dictate qualityProfileId,
  // rootFolderPath, monitored, tags, addOptions, etc. The server
  // materializes those from upstream defaults — a direct-POST can't
  // bypass the admin's curated profile or pin a different folder.
  it('replaces a malicious rootFolderPath / qualityProfileId with server defaults', async () => {
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
        // Caller-supplied admin-policy fields — must all be ignored.
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
    expect(fwd.rootFolderPath).toBe('/data/movies')
    expect(fwd.qualityProfileId).toBe(7)
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
          return new Response(JSON.stringify({ id: 999 }), { status: 201 })
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
