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

  it('400 rootFolderPath_required when the body omits rootFolderPath (fail closed)', async () => {
    // Without a root folder path we can't measure free space, and the
    // previous "forward and let Sonarr decide" path bypassed the disk
    // gate entirely. The gate now rejects at the route boundary BEFORE
    // any upstream call.
    const app = appUnderTest()
    const r = await app.request('/api/v3/series', {
      method: 'POST',
      headers: {
        Cookie: await adminCookie(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'No root folder' }),
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'rootFolderPath_required' })
    // CRITICAL: never forwarded to Sonarr.
    expect(globalThis.fetch).not.toHaveBeenCalled()
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
        return new Response(JSON.stringify([{ id: 11 }, { id: 22 }]), { status: 200 })
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
})
