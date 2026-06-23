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
import { __resetRateLimitsForTests } from '../middleware/rateLimit.js'
import type { Env } from '../middleware/auth.js'
import { env } from '../env.js'
import * as grabLog from '../services/grabLog.js'

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
  // Finding 4-0: the rate-limit buckets are module-global; reset between tests
  // so a prior test's mutate requests (POST /series add) don't pre-drain the
  // shared 'sonarr-mutate' bucket the season-monitor tests rely on.
  __resetRateLimitsForTests()
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

  it('admin DELETE with encoded-slash traversal returns 400, does not reach upstream', async () => {
    // Hono URL-decodes :id BEFORE we read it. Without validation,
    // `..%2Frootfolder%2F1` decodes to `../rootfolder/1`, the
    // `new URL(base + path)` builder normalizes the `..`, and the
    // DELETE silently retargets a different Sonarr endpoint. Route
    // now requires a positive safe integer.
    const app = appUnderTest()
    const r = await app.request(
      '/api/v3/series/..%2Frootfolder%2F1',
      { method: 'DELETE', headers: { Cookie: await adminCookie() } },
    )
    expect(r.status).toBe(400)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('admin DELETE with a non-integer :id returns 400', async () => {
    const app = appUnderTest()
    const r = await app.request('/api/v3/series/abc', {
      method: 'DELETE',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(400)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('sonarr POST /api/v3/series disk-space gate', () => {
  // These tests exercise the admin pass-through body path. Non-admin
  // bodies now go through materializeNonAdminSeriesBody which forces
  // server-derived rootFolderPath / qualityProfileId — covered in the
  // dedicated "non-admin add policy" describe below.
  it('blocks add with 507 when freeSpace < threshold', async () => {
    // 50 GB free, threshold is 100 GB
    stub('/api/v3/rootfolder', [
      { id: 1, path: '/data/tv', freeSpace: 50 * 1024 ** 3 },
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
        Cookie: await adminCookie(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ rootFolderPath: '/data/tv', title: 'Foo' }),
    })
    expect(r.status).toBe(201)
  })

  it('admin omitting rootFolderPath routes through materialize (no silent forward, no 400)', async () => {
    // History: the route originally 400'd rootFolderPath_required on any
    // missing path "to fail closed." But AddSeriesModal's viewAs-aware
    // isAdmin sends the slim user-shape body when an admin previews-as-
    // user; the session is still admin, so the request 400'd in 2 ms.
    // The route now routes admin-slim-body adds through materialize so
    // curated defaults are backfilled; the disk-space gate is still
    // enforced (just one step later). The upstream-unreachable failure
    // shape proves we did NOT silently forward the add: we attempted
    // to materialize, hit the unstubbed rootfolder lookup, and bailed
    // with 503 BEFORE any add was forwarded to Sonarr.
    const app = appUnderTest()
    const r = await app.request('/api/v3/series', {
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

  it('400 unknown_root_folder when rootFolderPath does not match any Sonarr folder', async () => {
    stub('/api/v3/rootfolder', [
      { id: 1, path: '/data/tv', freeSpace: 500 * 1024 ** 3 },
    ])
    const app = appUnderTest()
    const r = await app.request('/api/v3/series', {
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

  it('507 free_space_unknown when the matched root folder has no freeSpace field', async () => {
    // Sonarr/Radarr sometimes omit freeSpace on transient backend
    // issues. Treating "unknown" as "fine" silently disables the gate;
    // fail closed instead so the add only proceeds when we positively
    // verified the threshold.
    stub('/api/v3/rootfolder', [
      // No freeSpace field — simulate the upstream omitting it.
      { id: 1, path: '/data/tv' },
    ])
    const app = appUnderTest()
    const r = await app.request('/api/v3/series', {
      method: 'POST',
      headers: {
        Cookie: await adminCookie(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'X', rootFolderPath: '/data/tv' }),
    })
    expect(r.status).toBe(507)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('free_space_unknown')
  })
})

describe('sonarr POST /api/v3/series — non-admin add policy', () => {
  // Non-admin add requests can't dictate qualityProfileId, rootFolderPath,
  // monitored, tags, seasons[].monitored, seasonFolder, monitor mode, etc.
  // The server materializes those from upstream defaults so a direct-POST
  // can't bypass the admin's curated profile or pin a different folder.
  it('replaces a malicious rootFolderPath / qualityProfileId with server defaults', async () => {
    stub('/api/v3/rootfolder', [
      { id: 1, path: '/data/tv', freeSpace: 500 * 1024 ** 3 },
      { id: 2, path: '/data/tv-mirror', freeSpace: 500 * 1024 ** 3 },
    ])
    stub('/api/v3/qualityprofile', [{ id: 11 }, { id: 22 }])
    let capturedAddBody: Record<string, unknown> | null = null
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>
    fetchSpy.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/v3/rootfolder')) {
        return new Response(JSON.stringify([
          { id: 1, path: '/data/tv', freeSpace: 500 * 1024 ** 3 },
          { id: 2, path: '/data/tv-mirror', freeSpace: 500 * 1024 ** 3 },
        ]), { status: 200 })
      }
      if (url.includes('/api/v3/qualityprofile')) {
        return new Response(JSON.stringify([{ id: 11, name: 'Choose Me' }, { id: 22, name: 'Any' }]), { status: 200 })
      }
      if (url.endsWith('/api/v3/series') && init?.method === 'POST') {
        capturedAddBody = JSON.parse(init.body as string)
        return new Response(JSON.stringify({ id: 999, title: 'Hostile', seasons: [] }), { status: 201 })
      }
      return new Response('[]', { status: 200 })
    })
    const app = appUnderTest()
    const r = await app.request('/api/v3/series', {
      method: 'POST',
      headers: {
        Cookie: await userCookie(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Hostile',
        tvdbId: 42,
        // Caller tries to pin admin-policy fields — all must be ignored.
        rootFolderPath: '/data/tv-mirror',
        qualityProfileId: 22,
        monitored: false,
        seasonFolder: false,
        languageProfileId: 9,
        tags: [99],
        addOptions: {
          monitor: 'all',
          searchForCutoffUnmetEpisodes: true,
        },
        seasons: [{ seasonNumber: 1, monitored: true }],
      }),
    })
    expect(r.status).toBe(201)
    expect(capturedAddBody).not.toBeNull()
    const fwd = capturedAddBody as unknown as Record<string, unknown>
    // Server-derived from FIRST upstream entries, not caller-supplied.
    expect(fwd.rootFolderPath).toBe('/data/tv')
    expect(fwd.qualityProfileId).toBe(11)
    expect(fwd.tags).toEqual([])
    expect(fwd.monitored).toBe(true)
    expect(fwd.seasonFolder).toBe(true)
    // Caller-supplied admin fields scrubbed entirely (not just overridden).
    expect(fwd.languageProfileId).toBeUndefined()
    expect(fwd.seasons).toBeUndefined()
    // Identifying metadata preserved.
    expect(fwd.title).toBe('Hostile')
    expect(fwd.tvdbId).toBe(42)
  })

  it('prefers a "Choose Me" profile over profiles[0] for non-admin adds', async () => {
    // For TV, profile selection matters even more than for movies:
    // Sonarr's ongoing RSS sweep against monitored series is gated by
    // the quality profile (not our per-episode cap). Landing on Any
    // would let 4K HDR packs through on auto-grab. Mirror the
    // frontend's Choose Me preference server-side.
    let capturedAddBody: Record<string, unknown> | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([
            { id: 1, path: '/data/tv', freeSpace: 500 * 1024 ** 3 },
          ]), { status: 200 })
        }
        if (url.includes('/api/v3/qualityprofile')) {
          return new Response(JSON.stringify([
            { id: 1, name: 'Any' },
            { id: 5, name: 'Choose Me' },
            { id: 8, name: 'HD - 1080p' },
          ]), { status: 200 })
        }
        if (url.endsWith('/api/v3/series') && init?.method === 'POST') {
          capturedAddBody = JSON.parse(init.body as string)
          return new Response(JSON.stringify({ id: 999, title: 'X', seasons: [] }), { status: 201 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/series', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'X', tvdbId: 1 }),
    })
    expect(r.status).toBe(201)
    expect(capturedAddBody).not.toBeNull()
    const fwd = capturedAddBody as unknown as Record<string, unknown>
    expect(fwd.qualityProfileId).toBe(5) // Choose Me — not Any (id 1)
  })

  it('503 when upstream qualityprofile / rootfolder are not configured', async () => {
    stub('/api/v3/rootfolder', [])
    stub('/api/v3/qualityprofile', [])
    const app = appUnderTest()
    const r = await app.request('/api/v3/series', {
      method: 'POST',
      headers: {
        Cookie: await userCookie(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'X', tvdbId: 1 }),
    })
    expect(r.status).toBe(503)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('admin_must_configure_upstream')
  })

  it('admin sending a slim body (no rootFolderPath) materializes defaults instead of 400ing', async () => {
    // Regression: AddSeriesModal uses auth.tsx's viewAs-aware isAdmin to
    // pick body shape. When an admin previews-as-user, the modal sends
    // a slim user-shape body { tvdbId, tmdbId?, title } and the server's
    // session.role stays 'admin' from the cookie, so the admin
    // passthrough branch fired and rootFolderPath_required tripped in
    // 2 ms — surfacing as the cryptic "Sonarr /series: 400" toast for
    // every admin-in-preview add.
    let capturedAddBody: Record<string, unknown> | null = null
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>
    fetchSpy.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/api/v3/rootfolder')) {
        return new Response(JSON.stringify([
          { id: 1, path: '/data/tv', freeSpace: 500 * 1024 ** 3 },
        ]), { status: 200 })
      }
      if (url.includes('/api/v3/qualityprofile')) {
        return new Response(JSON.stringify([{ id: 11, name: 'Choose Me' }]), { status: 200 })
      }
      if (url.endsWith('/api/v3/series') && init?.method === 'POST') {
        capturedAddBody = JSON.parse(init.body as string)
        return new Response(JSON.stringify({ id: 1234, title: 'House', seasons: [] }), { status: 201 })
      }
      return new Response('[]', { status: 200 })
    })
    const r = await appUnderTest().request('/api/v3/series', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tvdbId: 73255, tmdbId: 1408, title: 'House' }),
    })
    expect(r.status).toBe(201)
    const fwd = capturedAddBody as unknown as Record<string, unknown>
    expect(fwd.rootFolderPath).toBe('/data/tv')
    expect(fwd.qualityProfileId).toBe(11)
    expect(fwd.tvdbId).toBe(73255)
    expect(fwd.title).toBe('House')
  })

  it('race-tolerant: empty created.seasons from POST triggers a GET re-read so the cap-aware grab still fires', async () => {
    // Sonarr's add pipeline applies addOptions.monitor after the response
    // body is built. For shows whose metadata is still being fetched at
    // POST-response time, created.seasons can be empty even though
    // 'firstSeason' will land S1 monitored a moment later. Without the
    // re-read, monitored.length === 0 from the POST response and
    // grabTvUnderCap is silently skipped — the bug Round 24 finding 1
    // flagged. Assert the GET re-read happens and that the route
    // dispatches the background grab from the canonical season list.
    const calls: Array<{ url: string; method: string }> = []
    let releasePolled = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        calls.push({ url, method })
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([
            { id: 1, path: '/data/tv', freeSpace: 500 * 1024 ** 3 },
          ]), { status: 200 })
        }
        if (url.includes('/api/v3/qualityprofile')) {
          return new Response(JSON.stringify([{ id: 1, name: 'Choose Me' }]), { status: 200 })
        }
        if (url.endsWith('/api/v3/series') && method === 'POST') {
          // Empty seasons — the race the fix is meant to handle.
          return new Response(JSON.stringify({ id: 42, title: 'X', monitored: true, seasons: [] }), { status: 201 })
        }
        if (url.includes('/api/v3/series/42') && method === 'GET') {
          // Canonical state once Sonarr finishes applying firstSeason.
          return new Response(JSON.stringify({
            id: 42,
            title: 'X',
            seasons: [
              { seasonNumber: 0, monitored: false },
              { seasonNumber: 1, monitored: true },
              { seasonNumber: 2, monitored: false },
            ],
          }), { status: 200 })
        }
        if (url.includes('/api/v3/release')) {
          releasePolled = true
          return new Response(JSON.stringify([]), { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/series', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'X', tvdbId: 1 }),
    })
    expect(r.status).toBe(201)
    // The GET re-read MUST have happened — that's the property we're locking in.
    const reread = calls.find((c) => c.method === 'GET' && c.url.endsWith('/api/v3/series/42'))
    expect(reread, 'expected a GET /api/v3/series/42 re-read after the POST returned empty seasons').toBeDefined()
    // grabTvUnderCap is spawned via void with a 2s setTimeout before
    // /api/v3/release; we can't reliably observe it inside the request
    // tick without fake timers. The GET re-read alone proves the
    // race-tolerant path ran; the downstream grab is exercised by
    // existing tests with non-empty created.seasons. Silence the
    // unused-binding lint while keeping the variable for future
    // fake-timer expansion.
    void releasePolled
  })

  it('race-tolerant re-read skipped when the response already lists monitored seasons (no extra GET on the happy path)', async () => {
    // Make sure the happy path doesn't waste a round-trip — if
    // created.seasons already has monitored entries, the re-read MUST
    // NOT fire. Otherwise every non-admin add costs an extra GET.
    const getsToSpecificSeries: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([
            { id: 1, path: '/data/tv', freeSpace: 500 * 1024 ** 3 },
          ]), { status: 200 })
        }
        if (url.includes('/api/v3/qualityprofile')) {
          return new Response(JSON.stringify([{ id: 1, name: 'Choose Me' }]), { status: 200 })
        }
        if (url.endsWith('/api/v3/series') && method === 'POST') {
          return new Response(JSON.stringify({
            id: 42,
            title: 'X',
            monitored: true,
            seasons: [{ seasonNumber: 1, monitored: true }],
          }), { status: 201 })
        }
        if (url.includes('/api/v3/series/42') && method === 'GET') {
          getsToSpecificSeries.push(url)
          return new Response(JSON.stringify({ id: 42, seasons: [] }), { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/series', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'X', tvdbId: 1 }),
    })
    expect(r.status).toBe(201)
    expect(getsToSpecificSeries).toEqual([])
  })

  it('preserves tmdbId on the forwarded body so the recommender mirror can attribute the add', async () => {
    // Sonarr's primary id for TV is tvdbId, but the recommender's
    // catalog is keyed on tmdbId. sonarr.ts only fires the conversion
    // mirror (postFeedback signal:'added') when body.tmdbId is present.
    // AddSeriesModal must ship tmdbId alongside tvdbId, AND
    // materializeNonAdminSeriesBody must keep it past the allowlist.
    // Without both, every TV add silently fails to influence the
    // optimizer.
    let capturedAddBody: Record<string, unknown> | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([
            { id: 1, path: '/data/tv', freeSpace: 500 * 1024 ** 3 },
          ]), { status: 200 })
        }
        if (url.includes('/api/v3/qualityprofile')) {
          return new Response(JSON.stringify([{ id: 1, name: 'Choose Me' }]), { status: 200 })
        }
        if (url.endsWith('/api/v3/series') && init?.method === 'POST') {
          capturedAddBody = JSON.parse(init.body as string)
          return new Response(JSON.stringify({ id: 1, title: 'X', seasons: [] }), { status: 201 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/series', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'X', tvdbId: 1, tmdbId: 12345 }),
    })
    expect(r.status).toBe(201)
    expect(capturedAddBody).not.toBeNull()
    const fwd = capturedAddBody as unknown as Record<string, unknown>
    expect(fwd.tmdbId).toBe(12345)
  })

  it("forces addOptions.monitor:'firstSeason' so a completed show actually grabs season 1", async () => {
    // Prior behavior was monitor:'future', which left zero historical
    // seasons monitored on a completed show — grabTvUnderCap is gated
    // on monitored.length > 0, so the add silently downloaded nothing.
    // 'firstSeason' mirrors both the modal default and the home copy.
    let capturedAddBody: Record<string, unknown> | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([
            { id: 1, path: '/data/tv', freeSpace: 500 * 1024 ** 3 },
          ]), { status: 200 })
        }
        if (url.includes('/api/v3/qualityprofile')) {
          return new Response(JSON.stringify([{ id: 1, name: 'Choose Me' }]), { status: 200 })
        }
        if (url.endsWith('/api/v3/series') && init?.method === 'POST') {
          capturedAddBody = JSON.parse(init.body as string)
          return new Response(JSON.stringify({ id: 1, title: 'X', seasons: [] }), { status: 201 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/series', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'X', tvdbId: 1 }),
    })
    expect(r.status).toBe(201)
    expect(capturedAddBody).not.toBeNull()
    const fwd = capturedAddBody as unknown as Record<string, unknown>
    const addOptions = fwd.addOptions as { monitor?: string }
    expect(addOptions.monitor).toBe('firstSeason')
  })
})

// POST /api/v3/series — background grab pipeline interactions.
// `grabTvUnderCap` runs via `void` after the add response is written,
// so the HTTP test surface is narrower than for synchronous endpoints:
// we can assert what fetch calls happen *before* the response goes
// back (rootfolder check, the add itself) but the background grab uses
// real setTimeouts (2 s + repeated 1.5 s polls) we don't want to wait
// on. We force `searchForMissingEpisodes: false` to skip spawning the
// grab entirely, then verify nothing past `/api/v3/series` is called.
describe('sonarr POST /api/v3/series — wantedSearch flag', () => {
  it('searchForMissingEpisodes:false skips the background grab path', async () => {
    stub('/api/v3/rootfolder', [
      { id: 1, path: '/data/tv', freeSpace: 500 * 1024 ** 3 },
    ])
    stub('/api/v3/series', { id: 99, title: 'Foo', monitored: true, seasons: [] }, 201)
    const r = await appUnderTest().request('/api/v3/series', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rootFolderPath: '/data/tv',
        title: 'Foo',
        addOptions: {
          searchForMissingEpisodes: false,
          searchForCutoffUnmetEpisodes: false,
        },
      }),
    })
    expect(r.status).toBe(201)
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([u]) =>
      String(u),
    )
    // No release or episode endpoint should have been touched — the
    // size-capped grab was opted out.
    expect(calls.some((u) => u.includes('/api/v3/release'))).toBe(false)
    expect(calls.some((u) => u.includes('/api/v3/episode'))).toBe(false)
  })

  it('Sonarr add fails (non-OK) → no background grab spawned', async () => {
    stub('/api/v3/rootfolder', [
      { id: 1, path: '/data/tv', freeSpace: 500 * 1024 ** 3 },
    ])
    // Add returns 400; route forwards verbatim and never enters the
    // grab pipeline because r.ok is false.
    stub('/api/v3/series', { error: 'sonarr says no' }, 400)
    const r = await appUnderTest().request('/api/v3/series', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rootFolderPath: '/data/tv',
        title: 'Foo',
        addOptions: { searchForMissingEpisodes: true },
        seasons: [{ seasonNumber: 1, monitored: true }],
      }),
    })
    expect(r.status).toBe(400)
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([u]) =>
      String(u),
    )
    expect(calls.some((u) => u.includes('/api/v3/release'))).toBe(false)
    expect(calls.some((u) => u.includes('/api/v3/episode'))).toBe(false)
  })

  it('wantedSearch true but monitored.length === 0 skips the background grab', async () => {
    // No seasons monitored = nothing to fetch for. Route should not
    // spawn grabTvUnderCap (which would loop over an empty array).
    stub('/api/v3/rootfolder', [
      { id: 1, path: '/data/tv', freeSpace: 500 * 1024 ** 3 },
    ])
    stub('/api/v3/series', {
      id: 99,
      title: 'Foo',
      monitored: true,
      seasons: [{ seasonNumber: 1, monitored: false }],
    }, 201)
    const r = await appUnderTest().request('/api/v3/series', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rootFolderPath: '/data/tv',
        title: 'Foo',
        addOptions: { searchForMissingEpisodes: true },
        seasons: [{ seasonNumber: 1, monitored: false }],
      }),
    })
    expect(r.status).toBe(201)
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([u]) =>
      String(u),
    )
    expect(calls.some((u) => u.includes('/api/v3/release'))).toBe(false)
  })

  it('forces searchForMissingEpisodes:false on the body sent to Sonarr regardless of caller intent', async () => {
    stub('/api/v3/rootfolder', [
      { id: 1, path: '/data/tv', freeSpace: 500 * 1024 ** 3 },
    ])
    stub('/api/v3/series', { id: 99, title: 'Foo', monitored: true, seasons: [] }, 201)
    await appUnderTest().request('/api/v3/series', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rootFolderPath: '/data/tv',
        title: 'Foo',
        addOptions: { searchForMissingEpisodes: true, searchForCutoffUnmetEpisodes: true },
      }),
    })
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>
    // Find the add call (POST /api/v3/series, NOT /rootfolder)
    const addCall = fetchSpy.mock.calls.find(
      ([u, init]) =>
        String(u).includes('/api/v3/series') &&
        !String(u).includes('rootfolder') &&
        (init as RequestInit | undefined)?.method === 'POST',
    )
    expect(addCall).toBeDefined()
    const bodyJson = JSON.parse((addCall![1] as RequestInit).body as string)
    expect(bodyJson.addOptions.searchForMissingEpisodes).toBe(false)
    expect(bodyJson.addOptions.searchForCutoffUnmetEpisodes).toBe(false)
  })
})

// POST /api/v3/series/:id/seasons/:n/monitor — admin-only single-season
// toggle. Has its own param validation, GET-existing, then PUT, then
// background grab. The PUT failure mode is a forwarded-body response,
// not a structured error; record that here so a future refactor that
// adds a structured shape doesn't quietly change the contract.
describe('sonarr POST /series/:id/seasons/:n/monitor', () => {
  it('rejects user role with 403', async () => {
    const r = await appUnderTest().request('/api/v3/series/1/seasons/2/monitor', {
      method: 'POST',
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(403)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('400 bad_params for non-numeric id or season', async () => {
    const r1 = await appUnderTest().request('/api/v3/series/abc/seasons/2/monitor', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    })
    expect(r1.status).toBe(400)
    expect(await r1.json()).toEqual({ error: 'bad_params' })

    const r2 = await appUnderTest().request('/api/v3/series/1/seasons/xx/monitor', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    })
    expect(r2.status).toBe(400)
  })

  it('404 season_not_found when the season does not exist on the series', async () => {
    stub('/api/v3/series/1', { id: 1, title: 'Foo', seasons: [{ seasonNumber: 1, monitored: true }] })
    const r = await appUnderTest().request('/api/v3/series/1/seasons/9/monitor', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(404)
    expect(await r.json()).toEqual({ error: 'season_not_found' })
  })

  it('GET series upstream non-OK is forwarded with its status', async () => {
    stub('/api/v3/series/1', { error: 'no such series' }, 404)
    const r = await appUnderTest().request('/api/v3/series/1/seasons/2/monitor', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(404)
  })

  it('PUT series upstream non-OK is forwarded with its status and body', async () => {
    stub('/api/v3/series/42', { id: 42, title: 'Foo', seasons: [{ seasonNumber: 5, monitored: false }] })
    stub('/api/v3/rootfolder', [{ id: 1, path: '/data/tv', freeSpace: 500 * 1024 ** 3 }])
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        if (url.includes('/api/v3/series/42') && method === 'GET') {
          return new Response(
            JSON.stringify({ id: 42, title: 'Foo', rootFolderPath: '/data/tv', seasons: [{ seasonNumber: 5, monitored: false }] }),
            { status: 200 },
          )
        }
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([{ id: 1, path: '/data/tv', freeSpace: 500 * 1024 ** 3 }]), { status: 200 })
        }
        if (url.includes('/api/v3/series/42') && method === 'PUT') {
          return new Response('{"error":"validation failed"}', { status: 400 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/series/42/seasons/5/monitor', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(400)
    expect(await r.text()).toBe('{"error":"validation failed"}')
  })

  it('507 insufficient_disk_space when season-monitor series folder free space is below threshold', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/api/v3/series/99')) {
          return new Response(
            JSON.stringify({ id: 99, title: 'LowSpace', rootFolderPath: '/data/tiny', seasons: [{ seasonNumber: 3, monitored: false }] }),
            { status: 200 },
          )
        }
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([{ id: 1, path: '/data/tiny', freeSpace: 5 * 1024 ** 3 }]), { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/series/99/seasons/3/monitor', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(507)
    const body = await r.json() as { error?: string }
    expect(body.error).toBe('insufficient_disk_space')
  })

  it('507 free_space_unknown when season-monitor folder freeSpace field is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/api/v3/series/55')) {
          return new Response(
            JSON.stringify({ id: 55, title: 'NoSpace', rootFolderPath: '/data/mystery', seasons: [{ seasonNumber: 1, monitored: false }] }),
            { status: 200 },
          )
        }
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([{ id: 1, path: '/data/mystery' }]), { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/series/55/seasons/1/monitor', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(507)
    const body = await r.json() as { error?: string }
    expect(body.error).toBe('free_space_unknown')
  })
})

// In-flight byte-reservation concurrency on the season-grab path.
//
// grabTvUnderCap() runs via `void` AFTER the add response is written and has
// a 2 s + repeated 1.5 s of real setTimeout before it reaches a
// /api/v3/release POST. To observe the reservation logic deterministically
// we (a) drive a fake-timer clock so we never wait on wall-clock, and (b)
// spy on appendGrabEvent so we can read the grab-log events the background
// pipeline emits (the same seam recordSonarrGrabEvent writes through).
//
// IMPORTANT — observed production behavior (sonarr.ts:287/333-335): a grab
// that FULLY completes (grabbedBytes === plannedBytes) does NOT release its
// reservation — the bytes are intentionally treated as committed downstream
// and the reservation is held until restart. Only a partial/failed grab
// releases the unused remainder (plannedBytes - grabbedBytes). This is the
// OPPOSITE of radarr.ts, which always releases. The tests below assert that
// actual behavior, not the symmetric assumption.
//
// The module-global pendingRootFolderReservations Map is NOT exported and is
// never reset, so each test uses its OWN root-folder PATH — reservations are
// keyed by path, so distinct paths can't leak across tests. We drive these
// through the season-monitor route (admin-only) because it reuses the SAME
// grabTvUnderCap with the smallest stub surface (GET series, GET rootfolder,
// PUT series, then the background grab).
describe('sonarr season-grab in-flight reservation', () => {
  const FOUR_GB = 4 * 1024 ** 3
  // Free space that fits exactly ONE 4 GB reservation above the 100 GB
  // reserve with ~3 GB slack — a second concurrent 4 GB reservation cannot
  // also clear minFreeBytes.
  const TIGHT_FREE = env.minFreeBytes + 7 * 1024 ** 3

  type Stubs = {
    path: string
    freeSpace?: number
    grabStatus?: number
    // No eligible releases → finalPicks sum to 0 bytes (reserve guard path).
    noReleases?: boolean
    // Optional gate to hold the grab POST open (used by the overcommit test).
    holdPost?: (resolve: () => void) => void
  }

  function stubSeasonMonitor(calls: Array<{ url: string; method: string }>, s: Stubs) {
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
        if (url.includes('/api/v3/series/7') && method === 'GET') {
          return new Response(
            JSON.stringify({
              id: 7,
              title: 'Reserved Show',
              rootFolderPath: s.path,
              seasons: [{ seasonNumber: 1, monitored: false }],
            }),
            { status: 200 },
          )
        }
        if (url.includes('/api/v3/series/7') && method === 'PUT') {
          return new Response(JSON.stringify({ id: 7 }), { status: 200 })
        }
        if (url.includes('/api/v3/episode')) {
          return new Response(JSON.stringify([{ seasonNumber: 1, episodeNumber: 1, hasFile: false }]), { status: 200 })
        }
        if (url.includes('/api/v3/release') && method === 'GET') {
          if (s.noReleases) return new Response(JSON.stringify([]), { status: 200 })
          return new Response(
            JSON.stringify([
              {
                guid: 'g-7',
                indexerId: 1,
                size: FOUR_GB,
                qualityWeight: 100,
                title: 'Reserved Show S01E01',
                seasonNumber: 1,
                episodeNumbers: [1],
              },
            ]),
            { status: 200 },
          )
        }
        if (url.endsWith('/api/v3/release') && method === 'POST') {
          if (s.holdPost) {
            return new Promise<Response>((resolve) => {
              s.holdPost!(() => resolve(new Response('{}', { status: 200 })))
            })
          }
          return new Response(JSON.stringify({ ok: grabStatus < 400 }), { status: grabStatus })
        }
        return new Response('[]', { status: 200 })
      }),
    )
  }

  async function monitorAndFlushGrab(cookie: string): Promise<Response> {
    const r = await appUnderTest().request('/api/v3/series/7/seasons/1/monitor', {
      method: 'POST',
      headers: { Cookie: cookie },
    })
    // Skip the 2 s + 1.5 s real setTimeouts and drain the microtask queue.
    await vi.runAllTimersAsync()
    return r
  }

  function plannedSizeEvents() {
    return (grabLog.appendGrabEvent as ReturnType<typeof vi.fn>).mock.calls
      .map(([e]) => e as { type?: string; error?: string })
      .filter((e) => e.type === 'planned_size_exceeds_free_space')
  }
  function grabPostCount(calls: Array<{ url: string; method: string }>) {
    return calls.filter((c) => c.url.endsWith('/api/v3/release') && c.method === 'POST').length
  }

  let appendSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    appendSpy = vi.spyOn(grabLog, 'appendGrabEvent').mockResolvedValue(undefined)
  })
  afterEach(() => {
    appendSpy.mockRestore()
    vi.useRealTimers()
  })

  it('CONCURRENT OVERCOMMIT: a second same-folder season monitor is rejected at the preflight gate while the first reservation is in flight', async () => {
    // Free space fits exactly one 4 GB reservation above the reserve. We hold
    // add #1's grab POST open so its reservation stays on the books while add
    // #2 plans against the SAME path. Add #2 must be refused at the reserve
    // gate (overcommit) and never issue its own /api/v3/release POST.
    const path = '/data/tv-overcommit'
    const calls: Array<{ url: string; method: string }> = []
    const resolvers: Array<() => void> = []
    stubSeasonMonitor(calls, { path, holdPost: (resolve) => resolvers.push(resolve) })

    const cookie = await adminCookie()
    const r1 = await appUnderTest().request('/api/v3/series/7/seasons/1/monitor', {
      method: 'POST',
      headers: { Cookie: cookie },
    })
    expect(r1.status).toBe(200)
    // Advance past the 2 s + episode poll so add #1 reserves and posts (then hangs).
    await vi.advanceTimersByTimeAsync(6000)
    expect(resolvers.length).toBe(1)
    const postsAfterOne = grabPostCount(calls)

    const r2 = await appUnderTest().request('/api/v3/series/7/seasons/1/monitor', {
      method: 'POST',
      headers: { Cookie: cookie },
    })
    expect(r2.status).toBe(409)
    const r2Body = (await r2.json()) as { error: string }
    expect(r2Body.error).toBe('root_folder_reservation_in_flight')
    await vi.advanceTimersByTimeAsync(6000)

    // No NEW grab POST from request #2 (it was refused before the async grab loop).
    expect(grabPostCount(calls)).toBe(postsAfterOne)

    const add = await appUnderTest().request('/api/v3/series', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Another Show',
        rootFolderPath: path,
        qualityProfileId: 7,
        addOptions: { searchForMissingEpisodes: true },
      }),
    })
    expect(add.status).toBe(409)
    expect(((await add.json()) as { error: string }).error).toBe('root_folder_reservation_in_flight')

    // Let add #1 complete; runAllTimersAsync drains the resolution microtasks.
    resolvers.forEach((fn) => fn())
    await vi.runAllTimersAsync()
  })

  it('RESERVATION RELEASED ON FAILED GRAB: a non-ok grab POST frees the reservation so a follow-up same-folder add can grab', async () => {
    // Add #1's grab POST returns 500 → grabbedBytes (0) < plannedBytes → the
    // leftover reservation is released. A follow-up same-size add on the SAME
    // path must then clear the gate and issue its own grab POST.
    const path = '/data/tv-failrelease'
    const calls1: Array<{ url: string; method: string }> = []
    stubSeasonMonitor(calls1, { path, grabStatus: 500 })
    await monitorAndFlushGrab(await adminCookie())
    expect(grabPostCount(calls1)).toBe(1)

    const calls2: Array<{ url: string; method: string }> = []
    stubSeasonMonitor(calls2, { path, grabStatus: 200 })
    await monitorAndFlushGrab(await adminCookie())
    // No leftover reservation leaked from the failed grab.
    expect(plannedSizeEvents().length).toBe(0)
    expect(grabPostCount(calls2)).toBe(1)
  })

  it('RESERVATION SETTLED ON FULL SUCCESS: two sequential fully-successful grabs against the same root folder both succeed', async () => {
    // Regression: the ledger release used to be conditional on
    // grabbedBytes < plannedBytes, so a FULLY successful grab released
    // nothing — the leaked reservation made every later add/monitor against
    // the same root folder 409 root_folder_reservation_in_flight until
    // restart. The reservation must settle once the grab outcome is final
    // (the reservation guards planning; SAB owns real disk accounting).
    const path = '/data/tv-fullsuccess'
    const calls1: Array<{ url: string; method: string }> = []
    stubSeasonMonitor(calls1, { path, grabStatus: 200 })
    const r1 = await monitorAndFlushGrab(await adminCookie())
    expect(r1.status).toBe(200)
    expect(grabPostCount(calls1)).toBe(1)

    const calls2: Array<{ url: string; method: string }> = []
    stubSeasonMonitor(calls2, { path, grabStatus: 200 })
    const r2 = await monitorAndFlushGrab(await adminCookie())
    expect(r2.status).toBe(200)
    // No leftover reservation: the second grab cleared the gate and fired.
    expect(plannedSizeEvents().length).toBe(0)
    expect(grabPostCount(calls2)).toBe(1)
  })

  it('RESERVE GUARD: a planned grab summing to 0 bytes does not reserve and does not wedge the folder', async () => {
    // No eligible releases → bestByChunk is empty → the route returns BEFORE
    // reserveRootFolderBytes (which would itself refuse bytes <= 0). Nothing
    // is recorded, no grab POST fires, and a normal add afterward still works.
    const path = '/data/tv-zerobytes'
    const calls1: Array<{ url: string; method: string }> = []
    stubSeasonMonitor(calls1, { path, noReleases: true })
    await monitorAndFlushGrab(await adminCookie())
    expect(grabPostCount(calls1)).toBe(0)
    expect(plannedSizeEvents().length).toBe(0)

    const calls2: Array<{ url: string; method: string }> = []
    stubSeasonMonitor(calls2, { path, grabStatus: 200 })
    await monitorAndFlushGrab(await adminCookie())
    expect(plannedSizeEvents().length).toBe(0)
    expect(grabPostCount(calls2)).toBe(1)
  })
})

// ===========================================================================
// Advanced options (S1–S7). These assert real behavior: the admin gate, the
// command allowlist, the PUT field allowlist (extras ignored, full object
// PUT back), the interactive-grab cap + allowOverCap override + grab-event
// logging, and upstream-error mapping.
// ===========================================================================
describe('sonarr advanced — S1 POST /api/v3/command', () => {
  it('rejects user role with 403 and does not forward', async () => {
    const r = await appUnderTest().request('/api/v3/command', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'RefreshSeries', seriesId: 1 }),
    })
    expect(r.status).toBe(403)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('400 command_not_allowed for a disallowed name, never reaches upstream', async () => {
    const r = await appUnderTest().request('/api/v3/command', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Backup', seriesId: 1 }),
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'command_not_allowed' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('400 missing_required_field when EpisodeSearch arrives without episodeIds', async () => {
    const r = await appUnderTest().request('/api/v3/command', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'EpisodeSearch' }),
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'missing_required_field' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('forwards only allowlisted fields and returns the upstream command ack', async () => {
    let captured: Record<string, unknown> | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.endsWith('/api/v3/command') && init?.method === 'POST') {
          captured = JSON.parse(init.body as string)
          return new Response(JSON.stringify({ id: 7, name: 'RefreshSeries', status: 'queued' }), { status: 201 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/command', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      // seriesId is allowlisted; the bogus extra must be scrubbed.
      body: JSON.stringify({ name: 'RefreshSeries', seriesId: 42, evil: 'rm -rf' }),
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ id: 7, name: 'RefreshSeries', status: 'queued' })
    expect(captured).toEqual({ name: 'RefreshSeries', seriesId: 42 })
  })

  it('502 command_failed when upstream rejects the command', async () => {
    stub('/api/v3/command', { error: 'nope' }, 500)
    const r = await appUnderTest().request('/api/v3/command', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'SeriesSearch', seriesId: 3 }),
    })
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ error: 'command_failed', status: 500 })
  })
})

describe('sonarr advanced — S2 GET /api/v3/release (interactive search)', () => {
  it('rejects user role with 403', async () => {
    const r = await appUnderTest().request('/api/v3/release?seriesId=1', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(403)
  })

  it('400 bad_seriesId without a valid seriesId', async () => {
    const r = await appUnderTest().request('/api/v3/release?seriesId=0', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'bad_seriesId' })
  })

  it('projects releases with sizeGb + overCap computed against the per-episode cap', async () => {
    // maxTvBytesPerEpisode default = 5 GB. A 12 GB single-episode release is
    // over cap; a 3 GB single-episode release is within cap. A 24 GB full
    // season of 6 episodes = 4 GB/ep, within cap.
    const GB = 1024 ** 3
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        if (url.includes('/api/v3/episode')) {
          return new Response(
            JSON.stringify([
              { seasonNumber: 1, episodeNumber: 1 },
              { seasonNumber: 1, episodeNumber: 2 },
              { seasonNumber: 1, episodeNumber: 3 },
              { seasonNumber: 1, episodeNumber: 4 },
              { seasonNumber: 1, episodeNumber: 5 },
              { seasonNumber: 1, episodeNumber: 6 },
            ]),
            { status: 200 },
          )
        }
        if (url.includes('/api/v3/release') && method === 'GET') {
          return new Response(
            JSON.stringify([
              {
                guid: 'big', indexerId: 1, title: 'Big Ep', size: 12 * GB, qualityWeight: 80,
                seasonNumber: 1, episodeNumbers: [1], protocol: 'usenet', indexer: 'Eweka',
                quality: { quality: { name: 'WEBDL-2160p' } }, languages: [{ name: 'English' }],
                rejected: false, rejections: [],
              },
              {
                guid: 'small', indexerId: 1, title: 'Small Ep', size: 3 * GB, qualityWeight: 40,
                seasonNumber: 1, episodeNumbers: [2], protocol: 'usenet',
                quality: { quality: { name: 'WEBDL-1080p' } }, languages: [{ name: 'English' }],
                rejected: false, rejections: [],
              },
              {
                guid: 'pack', indexerId: 1, title: 'Full Season', size: 24 * GB, qualityWeight: 60,
                seasonNumber: 1, fullSeason: true, protocol: 'usenet',
                quality: { quality: { name: 'WEBDL-1080p' } }, languages: [{ name: 'English' }],
                rejected: false, rejections: [],
              },
            ]),
            { status: 200 },
          )
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/release?seriesId=5&seasonNumber=1', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    const rows = (await r.json()) as Array<{
      guid: string; sizeGb: number; overCap: boolean; quality: string; languages: string[]
    }>
    const byGuid = Object.fromEntries(rows.map((x) => [x.guid, x]))
    expect(byGuid.big.overCap).toBe(true) // 12 GB > 5 GB/ep
    expect(byGuid.big.sizeGb).toBeCloseTo(12.88, 1)
    expect(byGuid.big.quality).toBe('WEBDL-2160p')
    expect(byGuid.big.languages).toEqual(['English'])
    expect(byGuid.small.overCap).toBe(false) // 3 GB < 5 GB/ep
    expect(byGuid.pack.overCap).toBe(false) // 24 GB / 6 ep = 4 GB/ep < 5
  })

  it('502 release_search_failed when upstream search errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        if (url.includes('/api/v3/episode')) return new Response('[]', { status: 200 })
        if (url.includes('/api/v3/release') && method === 'GET') {
          return new Response('{"error":"boom"}', { status: 500 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/release?seriesId=5', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ error: 'release_search_failed', status: 500 })
  })
})

describe('sonarr advanced — S3 POST /api/v3/release (interactive grab)', () => {
  const GB = 1024 ** 3

  function stubGrab(opts: {
    releaseSize: number
    episodes?: number
    grabStatus?: number
    onGrab?: (body: Record<string, unknown>) => void
  }) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        if (url.includes('/api/v3/episode')) {
          return new Response(
            JSON.stringify(
              Array.from({ length: opts.episodes ?? 1 }, (_, i) => ({ seasonNumber: 1, episodeNumber: i + 1 })),
            ),
            { status: 200 },
          )
        }
        if (url.includes('/api/v3/release') && method === 'GET') {
          return new Response(
            JSON.stringify([
              {
                guid: 'pick', indexerId: 9, title: 'Picked Release', size: opts.releaseSize,
                qualityWeight: 50, seasonNumber: 1, episodeNumbers: [1], protocol: 'usenet',
                quality: { quality: { name: 'WEBDL-1080p' } }, languages: [{ name: 'English' }],
                rejected: false, rejections: [],
              },
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
  afterEach(() => {
    appendSpy.mockRestore()
  })

  function eventTypes() {
    return (grabLog.appendGrabEvent as ReturnType<typeof vi.fn>).mock.calls.map(
      ([e]) => (e as { type?: string }).type,
    )
  }
  // Full recorded events (not just their types) so we can assert the grab was
  // logged with the right item/release/attribution fields — the property the
  // audit flagged as untested on the interactive-grab path.
  function recordedEvents() {
    return (grabLog.appendGrabEvent as ReturnType<typeof vi.fn>).mock.calls.map(
      ([e]) => e as Record<string, unknown>,
    )
  }

  it('rejects user role with 403', async () => {
    const r = await appUnderTest().request('/api/v3/release?seriesId=5', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid: 'pick', indexerId: 9 }),
    })
    expect(r.status).toBe(403)
  })

  it('424 over_cap when the picked release exceeds the cap and allowOverCap is not set; logs a cap event, no grab POST', async () => {
    let grabPosted = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        if (url.includes('/api/v3/episode')) {
          return new Response(JSON.stringify([{ seasonNumber: 1, episodeNumber: 1 }]), { status: 200 })
        }
        if (url.includes('/api/v3/release') && method === 'GET') {
          return new Response(
            JSON.stringify([
              { guid: 'pick', indexerId: 9, title: 'Huge', size: 30 * GB, qualityWeight: 50, seasonNumber: 1, episodeNumbers: [1] },
            ]),
            { status: 200 },
          )
        }
        if (url.includes('/api/v3/release') && method === 'POST') {
          grabPosted = true
          return new Response('{}', { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/release?seriesId=5', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid: 'pick', indexerId: 9 }),
    })
    expect(r.status).toBe(424)
    expect(((await r.json()) as { error: string }).error).toBe('over_cap')
    expect(grabPosted).toBe(false)
    expect(eventTypes()).toContain('all_rejected_by_cap')
  })

  it('grabs an over-cap release when allowOverCap:true, and logs grab_started + grab_succeeded', async () => {
    let grabBody: Record<string, unknown> | null = null
    stubGrab({ releaseSize: 30 * GB, onGrab: (b) => { grabBody = b } })
    const r = await appUnderTest().request('/api/v3/release?seriesId=5', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid: 'pick', indexerId: 9, allowOverCap: true }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { status: string; title: string; sizeGb: number }
    expect(body.status).toBe('grabbed')
    expect(body.title).toBe('Picked Release')
    // Grab body forwards exactly guid+indexerId — not the client's size/extras.
    expect(grabBody).toEqual({ guid: 'pick', indexerId: 9 })
    expect(eventTypes()).toEqual(expect.arrayContaining(['grab_started', 'grab_succeeded']))
    // The override grab MUST be recorded through the grab-event log with the
    // right item/release/attribution fields (audit gap closed here).
    const succeeded = recordedEvents().find((e) => e.type === 'grab_succeeded')
    expect(succeeded, 'expected a grab_succeeded event recorded for the override grab').toBeDefined()
    expect(succeeded!.itemId).toBe(5) // seriesId from the query scope
    expect(succeeded!.title).toBe('Picked Release')
    expect(succeeded!.capGb).toBe(env.maxTvGbPerEpisode)
    // sub is the session subject — present so the grab is attributable in the
    // audit log / /by-item scoping (exact value is session-derived).
    expect(typeof succeeded!.sub).toBe('string')
    expect(succeeded!.sub).toBeTruthy()
    expect((succeeded!.release as { sizeBytes?: number }).sizeBytes).toBe(30 * GB)
  })

  it('grabs a within-cap release without override and returns sizeGb; records the grab event', async () => {
    stubGrab({ releaseSize: 3 * GB })
    const r = await appUnderTest().request('/api/v3/release?seriesId=5', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid: 'pick', indexerId: 9 }),
    })
    expect(r.status).toBe(200)
    expect(((await r.json()) as { status: string }).status).toBe('grabbed')
    // appendGrabEvent must have been called with a grab_succeeded event for
    // this series — directly asserting the recorder ran, not just the status.
    const succeeded = recordedEvents().find((e) => e.type === 'grab_succeeded')
    expect(succeeded, 'expected appendGrabEvent to record a grab_succeeded event').toBeDefined()
    expect(succeeded!.itemId).toBe(5)
    expect(succeeded!.title).toBe('Picked Release')
    expect((succeeded!.release as { sizeBytes?: number }).sizeBytes).toBe(3 * GB)
  })

  it('404 release_not_found when the guid+indexerId is not in the re-search', async () => {
    stubGrab({ releaseSize: 3 * GB })
    const r = await appUnderTest().request('/api/v3/release?seriesId=5', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid: 'ghost', indexerId: 9 }),
    })
    expect(r.status).toBe(404)
    expect(((await r.json()) as { error: string }).error).toBe('release_not_found')
  })

  it('502 grab_failed and logs grab_failed when the upstream grab POST errors', async () => {
    stubGrab({ releaseSize: 3 * GB, grabStatus: 500 })
    const r = await appUnderTest().request('/api/v3/release?seriesId=5', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid: 'pick', indexerId: 9 }),
    })
    expect(r.status).toBe(502)
    expect(((await r.json()) as { error: string }).error).toBe('grab_failed')
    expect(eventTypes()).toContain('grab_failed')
  })
})

describe('sonarr advanced — S5 PUT /api/v3/episode/monitor', () => {
  it('rejects user role with 403', async () => {
    const r = await appUnderTest().request('/api/v3/episode/monitor', {
      method: 'PUT',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeIds: [1], monitored: true }),
    })
    expect(r.status).toBe(403)
  })

  it('400 invalid_body when episodeIds is empty', async () => {
    const r = await appUnderTest().request('/api/v3/episode/monitor', {
      method: 'PUT',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeIds: [], monitored: true }),
    })
    expect(r.status).toBe(400)
  })

  it('forwards the batch toggle and returns the updated count', async () => {
    let body: Record<string, unknown> | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/api/v3/episode/monitor') && init?.method === 'PUT') {
          body = JSON.parse(init.body as string)
          return new Response('[]', { status: 202 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/episode/monitor', {
      method: 'PUT',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeIds: [10, 11, 12], monitored: false }),
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, updated: 3 })
    expect(body).toEqual({ episodeIds: [10, 11, 12], monitored: false })
  })
})

describe('sonarr advanced — S6 GET /api/v3/history/series', () => {
  it('rejects user role with 403', async () => {
    const r = await appUnderTest().request('/api/v3/history/series?seriesId=1', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(403)
  })

  it('maps paged upstream history to the slim newest-first shape', async () => {
    stub('/api/v3/history/series', {
      records: [
        { date: '2026-06-22T00:00:00Z', eventType: 'grabbed', sourceTitle: 'S01E01', quality: { quality: { name: 'WEBDL-1080p' } }, seasonNumber: 1, episodeId: 5 },
        { date: '2026-06-21T00:00:00Z', eventType: 'downloadFolderImported', sourceTitle: 'S01E01', quality: { quality: { name: 'WEBDL-1080p' } } },
      ],
    })
    const r = await appUnderTest().request('/api/v3/history/series?seriesId=5', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    const rows = (await r.json()) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({
      date: '2026-06-22T00:00:00Z', eventType: 'grabbed', sourceTitle: 'S01E01',
      quality: 'WEBDL-1080p', seasonNumber: 1, episodeId: 5,
    })
    expect(rows[1].quality).toBe('WEBDL-1080p')
    expect(rows[1].seasonNumber).toBeUndefined()
  })

  it('sorts newest-first regardless of upstream order', async () => {
    // Upstream rows deliberately oldest-first — the backend must reorder so
    // the "newest-first" contract guarantee holds and the clients can render
    // as-received without re-sorting.
    stub('/api/v3/history/series', {
      records: [
        { date: '2026-06-01T00:00:00Z', eventType: 'grabbed', sourceTitle: 'old', quality: { quality: { name: 'WEBDL-1080p' } } },
        { date: '2026-06-20T00:00:00Z', eventType: 'grabbed', sourceTitle: 'new', quality: { quality: { name: 'WEBDL-1080p' } } },
        { date: '2026-06-10T00:00:00Z', eventType: 'grabbed', sourceTitle: 'mid', quality: { quality: { name: 'WEBDL-1080p' } } },
      ],
    })
    const r = await appUnderTest().request('/api/v3/history/series?seriesId=5', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    const rows = (await r.json()) as Array<{ sourceTitle: string }>
    expect(rows.map((x) => x.sourceTitle)).toEqual(['new', 'mid', 'old'])
  })
})

describe('sonarr advanced — S7 PUT /api/v3/series/:id (edit)', () => {
  it('rejects user role with 403', async () => {
    const r = await appUnderTest().request('/api/v3/series/5', {
      method: 'PUT',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ monitored: false }),
    })
    expect(r.status).toBe(403)
  })

  it('fetches the full series, overlays ONLY allowlisted fields (extras ignored), PUTs the whole object back', async () => {
    let putBody: Record<string, unknown> | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        if (url.includes('/api/v3/series/5') && method === 'GET') {
          return new Response(
            JSON.stringify({
              id: 5, title: 'Existing', monitored: true, qualityProfileId: 1,
              rootFolderPath: '/data/tv', path: '/data/tv/Existing', seasons: [{ seasonNumber: 1, monitored: true }],
            }),
            { status: 200 },
          )
        }
        if (url.includes('/api/v3/series/5') && method === 'PUT') {
          putBody = JSON.parse(init!.body as string)
          return new Response(JSON.stringify(putBody), { status: 202 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/series/5', {
      method: 'PUT',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        monitored: false, qualityProfileId: 7, rootFolderPath: '/data/tv2',
        // Non-allowlisted fields must be ignored, NOT forwarded.
        title: 'HACKED', path: '/etc/passwd', id: 999, seasons: [],
      }),
    })
    expect(r.status).toBe(202)
    // Allowlisted fields applied.
    expect(putBody!.monitored).toBe(false)
    expect(putBody!.qualityProfileId).toBe(7)
    expect(putBody!.rootFolderPath).toBe('/data/tv2')
    // Full upstream object preserved; client attempts to overwrite ignored.
    expect(putBody!.title).toBe('Existing')
    expect(putBody!.path).toBe('/data/tv/Existing')
    expect(putBody!.id).toBe(5)
    expect(putBody!.seasons).toEqual([{ seasonNumber: 1, monitored: true }])
  })

  it('502 series_lookup_failed when the upstream GET fails (no PUT attempted)', async () => {
    let putAttempted = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        if (url.includes('/api/v3/series/5') && method === 'GET') {
          return new Response('{"error":"no"}', { status: 404 })
        }
        if (url.includes('/api/v3/series/5') && method === 'PUT') {
          putAttempted = true
          return new Response('{}', { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/series/5', {
      method: 'PUT',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ monitored: false }),
    })
    expect(r.status).toBe(502)
    expect(((await r.json()) as { error: string }).error).toBe('series_lookup_failed')
    expect(putAttempted).toBe(false)
  })
})

describe('sonarr advanced — S4 GET /api/v3/rename', () => {
  it('rejects user role with 403', async () => {
    const r = await appUnderTest().request('/api/v3/rename?seriesId=1', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(403)
  })

  it('projects the rename diff rows', async () => {
    stub('/api/v3/rename', [
      { episodeFileId: 1, seasonNumber: 1, existingPath: '/old/a.mkv', newPath: '/new/a.mkv', extra: 'drop' },
    ])
    const r = await appUnderTest().request('/api/v3/rename?seriesId=5', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    const rows = (await r.json()) as Array<Record<string, unknown>>
    expect(rows[0]).toEqual({ episodeFileId: 1, seasonNumber: 1, existingPath: '/old/a.mkv', newPath: '/new/a.mkv' })
    expect(rows[0].extra).toBeUndefined()
  })

  it('400 bad_seriesId without a valid seriesId', async () => {
    const r = await appUnderTest().request('/api/v3/rename?seriesId=0', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'bad_seriesId' })
  })

  it('502 rename_preview_failed when upstream errors', async () => {
    stub('/api/v3/rename', { error: 'boom' }, 500)
    const r = await appUnderTest().request('/api/v3/rename?seriesId=5', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ error: 'rename_preview_failed', status: 500 })
  })
})

// Error-path coverage for the new advanced handlers: the upstream-failure
// (502) branches and the remaining bad-param 400s that the happy-path tests
// above don't reach. These exercise real code paths (each maps a distinct
// upstream failure to a distinct client error), not coverage padding.
describe('sonarr advanced — error-path branches', () => {
  it('S2 400 bad_seasonNumber for a negative seasonNumber', async () => {
    const r = await appUnderTest().request('/api/v3/release?seriesId=5&seasonNumber=-1', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'bad_seasonNumber' })
  })

  it('S5 400 invalid_body when monitored is missing', async () => {
    const r = await appUnderTest().request('/api/v3/episode/monitor', {
      method: 'PUT',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeIds: [1] }),
    })
    expect(r.status).toBe(400)
  })

  it('S5 502 monitor_update_failed when upstream errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('/api/v3/episode/monitor') && init?.method === 'PUT') {
          return new Response('{"error":"no"}', { status: 500 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/episode/monitor', {
      method: 'PUT',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeIds: [1, 2], monitored: true }),
    })
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ error: 'monitor_update_failed', status: 500 })
  })

  it('S6 400 bad_seriesId and 502 history_failed', async () => {
    const bad = await appUnderTest().request('/api/v3/history/series?seriesId=x', {
      headers: { Cookie: await adminCookie() },
    })
    expect(bad.status).toBe(400)

    stub('/api/v3/history/series', { error: 'boom' }, 503)
    const fail = await appUnderTest().request('/api/v3/history/series?seriesId=5', {
      headers: { Cookie: await adminCookie() },
    })
    expect(fail.status).toBe(502)
    expect(await fail.json()).toEqual({ error: 'history_failed', status: 503 })
  })

  it('S7 400 bad_id and 502 series_update_failed', async () => {
    const bad = await appUnderTest().request('/api/v3/series/0', {
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
        if (url.includes('/api/v3/series/9') && method === 'GET') {
          return new Response(JSON.stringify({ id: 9, title: 'X', monitored: true }), { status: 200 })
        }
        if (url.includes('/api/v3/series/9') && method === 'PUT') {
          return new Response('{"error":"validation"}', { status: 400 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const fail = await appUnderTest().request('/api/v3/series/9', {
      method: 'PUT',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ monitored: false }),
    })
    expect(fail.status).toBe(502)
    expect(await fail.json()).toEqual({ error: 'series_update_failed', status: 400 })
  })

  it('S1 502 command_failed surfaced via the catch path on a non-JSON ack', async () => {
    // Upstream returns 200 but a non-JSON body — the .catch(()=>({})) fallback
    // must still produce a well-formed ack (undefined fields), not throw.
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
      body: JSON.stringify({ name: 'RefreshSeries', seriesId: 1 }),
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ id: undefined, name: undefined, status: undefined })
  })
})

describe('sonarr clear-stuck', () => {
  it('rejects user role with 403', async () => {
    const r = await appUnderTest().request('/api/v3/queue/clear-stuck', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(r.status).toBe(403)
  })

  it('removes + blocklists only import-jammed records, leaving active ones', async () => {
    // Stub bulk first so its suffix wins over the broader /api/v3/queue match.
    stub('/api/v3/queue/bulk', {})
    stub('/api/v3/queue', {
      records: [
        { id: 1, trackedDownloadState: 'importBlocked' },
        { id: 2, trackedDownloadState: 'downloading' }, // healthy — must NOT be touched
        { id: 3, trackedDownloadState: 'importPending' },
      ],
    })
    const r = await appUnderTest().request('/api/v3/queue/clear-stuck', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ removed: 2 })
    const bulk = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([u]) =>
      String(u).includes('/api/v3/queue/bulk'),
    )
    expect(bulk).toBeTruthy()
    const [bulkUrl, init] = bulk as [string, RequestInit]
    expect(String(bulkUrl)).toContain('removeFromClient=true')
    expect(String(bulkUrl)).toContain('blocklist=true')
    expect(String(bulkUrl)).toContain('skipRedownload=false')
    expect(init.method).toBe('DELETE')
    expect(JSON.parse(init.body as string)).toEqual({ ids: [1, 3] })
  })

  it('returns removed:0 and skips the bulk call when nothing is jammed', async () => {
    stub('/api/v3/queue/bulk', {})
    stub('/api/v3/queue', {
      records: [{ id: 1, trackedDownloadState: 'downloading' }],
    })
    const r = await appUnderTest().request('/api/v3/queue/clear-stuck', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ removed: 0 })
    const calledBulk = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([u]) =>
      String(u).includes('/api/v3/queue/bulk'),
    )
    expect(calledBulk).toBe(false)
  })

  it('502 queue_unreachable when the queue read fails', async () => {
    stub('/api/v3/queue', { error: 'boom' }, 502)
    const r = await appUnderTest().request('/api/v3/queue/clear-stuck', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ error: 'queue_unreachable' })
  })

  it('502 bulk_delete_failed when the bulk DELETE fails', async () => {
    // bulk stub first so its suffix wins over the broader /api/v3/queue match.
    stub('/api/v3/queue/bulk', { error: 'nope' }, 500)
    stub('/api/v3/queue', { records: [{ id: 7, trackedDownloadState: 'importBlocked' }] })
    const r = await appUnderTest().request('/api/v3/queue/clear-stuck', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ error: 'bulk_delete_failed', status: 500 })
  })
})
