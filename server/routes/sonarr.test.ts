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

  // sonarr.ts:788-793 — the fetched series carries no rootFolderPath, so the
  // route 400s with rootFolderPath_required BEFORE any rootfolder lookup or
  // PUT. We assert no PUT was issued so a refactor that reorders the guard
  // (e.g. PUTs first, validates after) is caught.
  it('400 rootFolderPath_required when the series has no rootFolderPath', async () => {
    const calls: Array<{ url: string; method: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        calls.push({ url, method })
        if (url.includes('/api/v3/series/10') && method === 'GET') {
          return new Response(
            JSON.stringify({ id: 10, title: 'NoRoot', seasons: [{ seasonNumber: 1, monitored: false }] }),
            { status: 200 },
          )
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/series/10/seasons/1/monitor', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'rootFolderPath_required' })
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  // sonarr.ts:797-803 — series.rootFolderPath points at a path the rootfolder
  // list does not contain, so the route 400s unknown_root_folder (echoing the
  // offending path) without writing the monitor PUT.
  it('400 unknown_root_folder when rootFolderPath matches no rootfolder entry', async () => {
    const calls: Array<{ url: string; method: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        calls.push({ url, method })
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([{ id: 1, path: '/data/tv', freeSpace: 500 * 1024 ** 3 }]), {
            status: 200,
          })
        }
        if (url.includes('/api/v3/series/11') && method === 'GET') {
          return new Response(
            JSON.stringify({
              id: 11,
              title: 'Orphan',
              rootFolderPath: '/data/gone',
              seasons: [{ seasonNumber: 2, monitored: false }],
            }),
            { status: 200 },
          )
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/series/11/seasons/2/monitor', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'unknown_root_folder', path: '/data/gone' })
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  // sonarr.ts:794-795 — loadSonarrRootFolders() failure is a forwarded
  // Response. A thrown rootfolder fetch is caught by fetchWithTimeout and
  // synthesized into a 504 (upstream.ts:44-59); sonarrRootFolders then throws
  // "sonarr rootfolder 504", whose 504 substring drives loadSonarrRootFolders
  // (sonarr.ts:69) to map to status 503. So the observed status is 503, not
  // 502 — verified by running the suite. No PUT happens.
  it('forwards rootfolder_unreachable when the rootfolder lookup fails', async () => {
    const calls: Array<{ url: string; method: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        calls.push({ url, method })
        if (url.includes('/api/v3/rootfolder')) {
          throw new Error('connect ECONNREFUSED')
        }
        if (url.includes('/api/v3/series/12') && method === 'GET') {
          return new Response(
            JSON.stringify({
              id: 12,
              title: 'Unreachable',
              rootFolderPath: '/data/tv',
              seasons: [{ seasonNumber: 1, monitored: false }],
            }),
            { status: 200 },
          )
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/series/12/seasons/1/monitor', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'rootfolder_unreachable' })
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  // sonarr.ts:849 — happy path. After a successful PUT the route returns the
  // structured success body BEFORE the background grab fires (the grab's first
  // release call sits behind a 2 s real setTimeout, and this block uses real
  // timers, so the request returns first — no timers to drive, no await on the
  // fire-and-forget grab). The existing reservation tests only assert status
  // 200; this pins the exact JSON contract.
  it('200 with { ok, seriesId, seasonNumber } on a successful season monitor', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        if (url.includes('/api/v3/rootfolder')) {
          return new Response(JSON.stringify([{ id: 1, path: '/data/tv', freeSpace: 500 * 1024 ** 3 }]), {
            status: 200,
          })
        }
        if (url.includes('/api/v3/series/13') && method === 'GET') {
          return new Response(
            JSON.stringify({
              id: 13,
              title: 'Happy',
              rootFolderPath: '/data/tv',
              seasons: [{ seasonNumber: 4, monitored: false }],
            }),
            { status: 200 },
          )
        }
        if (url.includes('/api/v3/series/13') && method === 'PUT') {
          return new Response(JSON.stringify({ id: 13 }), { status: 200 })
        }
        // Background grab seams — return early so a stray late call never errors.
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/api/v3/series/13/seasons/4/monitor', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, seriesId: 13, seasonNumber: 4 })
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

  it('CONCURRENT OVERCOMMIT: a second same-folder add cannot also reserve while the first is in flight — it emits planned_size_exceeds_free_space and issues no grab POST', async () => {
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
    expect(r2.status).toBe(200)
    await vi.advanceTimersByTimeAsync(6000)

    const events = plannedSizeEvents()
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events.some((e) => /overcommit|reservation/i.test(e.error ?? ''))).toBe(true)
    // No NEW grab POST from add #2 (it was refused before the grab loop).
    expect(grabPostCount(calls)).toBe(postsAfterOne)

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
