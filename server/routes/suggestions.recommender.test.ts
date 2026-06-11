// Locks in the local-recommender fallback path that's hard to exercise
// from suggestions.test.ts (whose existing fixtures all assume the
// USE_LOCAL_RECOMMENDER=0 / Claude pathway). Two properties matter:
//
//  1. When scoreOnce throws (sidecar down), the route degrades to TMDB
//     trending without crashing.
//  2. In that throw case, the route MUST NOT also fire postShown back
//     at the sidecar — posting /events/shown to a sidecar that just
//     failed /score wastes a 3 s bounded timeout + log line per
//     refresh with zero benefit. The healthy-but-empty case still
//     does fire postShown, and that's covered by other tests; here
//     we pin the negative case.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Hono } from 'hono'
import type { Env } from '../middleware/auth.js'

let app: Hono<Env>
let createSessionFn: typeof import('../session.js').createSession

// Swappable media.db handle for the local-availability wiring test.
// null = "media.db missing" (graceful degrade) for every other test.
let mediaDbHandle: { raw: import('better-sqlite3').Database; close(): void } | null = null

beforeAll(async () => {
  vi.resetModules()
  vi.doMock('../services/mediaLibraryDbSingleton.js', () => ({
    mediaLibraryDb: () => mediaDbHandle,
  }))
  vi.doMock('../env.js', () => ({
    env: {
      plexClientId: 'test-client',
      sessionSecret:
        process.env.SESSION_SECRET ?? 'test-secret-test-secret-test-secret-test-secret',
      admins: [],
      adminSubs: [],
      appleClientId: null,
      plexServerId: null,
      SERVER_DB_PATH: process.env.SERVER_DB_PATH ?? './data/server.db',
      port: 3001,
      isProd: false,
      allowedOrigins: [],
      plexServerUrl: 'http://upstream-plex.test',
      sonarrUrl: 'http://upstream-sonarr.test',
      sonarrApiKey: 'k',
      radarrUrl: 'http://upstream-radarr.test',
      radarrApiKey: 'k',
      sabUrl: 'http://upstream-sab.test',
      sabApiKey: 'k',
      minFreeBytes: 100 * 1024 ** 3,
      maxMovieBytes: 10 * 1024 ** 3,
      maxMovieGb: 10,
      maxTvBytesPerEpisode: 5 * 1024 ** 3,
      maxTvGbPerEpisode: 5,
      defaultProfileName: 'choose me',
      rejectionsPath: './data/rejections.test-fallback.json',
      userFeedbackPath: './data/user-feedback.test-fallback.json',
      usageLogPath: './data/usage.test-fallback.jsonl',
      grabLogPath: './data/grabs.test-fallback.jsonl',
      // TMDB key must be present so tmdbTrending returns a non-empty
      // fallback list; otherwise the route gets [] and there's nothing
      // to postShown about either way.
      tmdbApiKey: 'fake-tmdb-key',
      useLocalRecommender: true,
      // Media-core ON so the recommender success path exercises the real
      // services/localAvailability tagger (gated on this flag). The
      // singleton above returns null unless a test installs a handle.
      useMediaCore: true,
      recommenderUrl: 'http://recommender.test',
      optimizerMaxTokens: 1024,
      optimizerMaxDriftPct: 0.2,
    },
  }))
  const { Hono } = await import('hono')
  const { suggestions } = await import('./suggestions.js')
  const session = await import('../session.js')
  createSessionFn = session.createSession
  const a = new Hono<Env>()
  a.route('/api/suggestions', suggestions)
  app = a
})

afterAll(() => {
  vi.doUnmock('../env.js')
  vi.doUnmock('../services/mediaLibraryDbSingleton.js')
  vi.resetModules()
})

async function userCookie() {
  const t = await createSessionFn({ sub: 'plex:1', username: 'guest', role: 'user' })
  return `eex.session=${t}`
}

type FetchSpy = ReturnType<typeof vi.fn>

beforeEach(() => {
  // Default-stub everything so the test doesn't accidentally call real
  // upstream services. Per-test overrides come below.
  const spy: FetchSpy = vi.fn(async (input: string | URL | Request) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    // Radarr/Sonarr library — empty so library prologue resolves clean
    if (url.includes('/api/v3/movie') || url.includes('/api/v3/series')) {
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    // Recommender /score — fail to exercise the catch branch
    if (url.includes('recommender.test/score')) {
      return new Response('boom', { status: 500 })
    }
    // TMDB trending fallback — return a small pool
    if (url.includes('themoviedb.org/3/trending')) {
      return new Response(
        JSON.stringify({
          results: [
            { id: 1001, title: 'Movie A', poster_path: '/a.jpg', overview: 'oA', release_date: '2024-01-01' },
            { id: 1002, title: 'Movie B', poster_path: '/b.jpg', overview: 'oB', release_date: '2024-01-02' },
            { id: 1003, title: 'Movie C', poster_path: '/c.jpg', overview: 'oC', release_date: '2024-01-03' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response('[]', { status: 200 })
  })
  vi.stubGlobal('fetch', spy)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GET /api/suggestions/:type — ?force=trending in local-recommender mode', () => {
  it('serves trending and does NOT call the recommender when force=trending', async () => {
    // The SPA's Recommended ⇄ Trending toggle sends ?force=trending when
    // the user picks Trending. Even with USE_LOCAL_RECOMMENDER=1 (this
    // suite's env), the route must honor it — serve TMDB trending and skip
    // /score entirely. Regression guard for the toggle's backend half:
    // before this, the recommender block returned first and force=trending
    // was dead, so there was no way to view trending.
    const fetchSpy = globalThis.fetch as FetchSpy
    const r = await app.request('/api/suggestions/movie?force=trending', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { source: string; items: Array<{ id: number }> }
    expect(body.source).toBe('trending')
    expect(body.items.length).toBeGreaterThan(0)

    // The recommender was never consulted — force=trending short-circuits
    // above the useLocalRecommender block.
    const scoreCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes('recommender.test/score'),
    )
    expect(scoreCalls).toEqual([])
  })
})

describe('GET /api/suggestions/:type — recommender fallback', () => {
  it('returns trending and SKIPS postShown when /score throws', async () => {
    const fetchSpy = globalThis.fetch as FetchSpy
    const r = await app.request('/api/suggestions/movie', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      source: string
      items: Array<{ id: number }>
      _diag?: { path?: string }
    }
    // Route returned trending (the fallback)
    expect(body.source).toBe('trending')
    expect(body.items.length).toBeGreaterThan(0)
    expect(body._diag?.path).toBe('recommender_fallback_trending')

    // The postShown microtask had a chance to run.
    await new Promise((res) => setImmediate(res))

    // The critical assertion: NO /events/shown call. Posting to the
    // sidecar that just failed /score wastes a bounded timeout per
    // refresh during an outage.
    const shownCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes('/events/shown'),
    )
    expect(shownCalls).toEqual([])

    // Sanity: /score WAS attempted. Without this we'd be testing
    // nothing — a route bypass that skipped the sidecar entirely
    // would also satisfy the no-/events/shown assertion.
    const scoreCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes('recommender.test/score'),
    )
    expect(scoreCalls.length).toBeGreaterThanOrEqual(1)
  })
})

describe('GET /api/suggestions/:type — recommender franchise-collision filter', () => {
  it('keeps distinct franchise entries; drops only id + exact-title dupes', async () => {
    // Regression: the recommender already excludes the household library /
    // rejections / dislikes by id, so the backend re-filter must NOT use
    // base-form ("Franchise: Subtitle" → "franchise") title matching, which
    // let one owned Batman/Terminator/Transformers title nuke every other
    // distinct film in the franchise and collapsed the movie strip to ~7.
    const mod = await import('./suggestions.js')
    mod._resetLibraryCacheForTests()
    mod._resetLibraryStaleFallbackForTests()

    const OWNED_BATMAN = 9001 // owned "Batman: The Killing Joke"
    const DISTINCT_BATMAN = 9002 // unrelated "Batman: Bad Blood" — must SURVIVE
    const EXACT_DUP_OF_OWNED = 9003 // different id, exact title of an owned film
    const FRESH = 9005

    const spy: FetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (url.includes('/api/v3/movie')) {
        return new Response(
          JSON.stringify([
            { tmdbId: OWNED_BATMAN, title: 'Batman: The Killing Joke', year: 2016 },
            { tmdbId: 9100, title: 'Inception', year: 2010 },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/api/v3/series')) {
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('recommender.test/score')) {
        return new Response(
          JSON.stringify({
            items: [
              { tmdb_id: DISTINCT_BATMAN, title: 'Batman: Bad Blood', year: 2016, provenance: 'personalized', score: 0.71 },
              { tmdb_id: EXACT_DUP_OF_OWNED, title: 'Inception', year: 2010, provenance: 'personalized', score: 0.7 },
              { tmdb_id: OWNED_BATMAN, title: 'Batman: The Killing Joke', year: 2016, provenance: 'personalized', score: 0.69 },
              { tmdb_id: FRESH, title: 'A Completely Fresh Film', year: 2024, provenance: 'personalized', score: 0.68 },
            ],
            model_version: 'test-mv',
            recipe: 'fused',
            diag: {},
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      // impressions / shown / anything else
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', spy)

    const r = await app.request('/api/suggestions/movie', { headers: { Cookie: await userCookie() } })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { source: string; items: Array<{ id: number }> }
    expect(body.source).toBe('recommender')
    const ids = body.items.map((i) => i.id)

    // THE FIX: a distinct film sharing a franchise root with an owned title
    // survives instead of being blanket-banned by the base-form match.
    expect(ids).toContain(DISTINCT_BATMAN)
    expect(ids).toContain(FRESH)
    // Still household-safe: an owned id and an exact-title duplicate of an
    // owned film are dropped (permanent veto honored even across dup ids).
    expect(ids).not.toContain(OWNED_BATMAN)
    expect(ids).not.toContain(EXACT_DUP_OF_OWNED)
  })
})

describe('GET /api/suggestions/:type — local availability tagging (recommender path)', () => {
  it('stamps available_on:["local"] through services/localAvailability', async () => {
    // Regression for the dead-service finding: the route used to run an
    // inline byte-for-byte clone of services/localAvailability while the
    // unit-tested service was dead code, so the unit tests verified a copy
    // of prod instead of prod. This pins the WIRING end-to-end — the
    // recommender success path must tag through the real service (gated on
    // env.useMediaCore + the mediaLibraryDb singleton), so a future inline
    // re-duplication or a dropped call site fails here, not in review.
    const mod = await import('./suggestions.js')
    mod._resetLibraryCacheForTests()
    mod._resetLibraryStaleFallbackForTests()

    const ON_DISK = 7001
    const NOT_ON_DISK = 7002
    const raw = new Database(':memory:')
    raw.exec(`
      CREATE TABLE movies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tmdb_id INTEGER UNIQUE,
        title TEXT NOT NULL,
        year INTEGER
      );
    `)
    raw.prepare('INSERT INTO movies (tmdb_id, title, year) VALUES (?, ?, ?)').run(
      ON_DISK,
      'Owned On Disk',
      2020,
    )
    mediaDbHandle = { raw, close: () => raw.close() }

    try {
      const spy: FetchSpy = vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        if (url.includes('/api/v3/movie') || url.includes('/api/v3/series')) {
          return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (url.includes('recommender.test/score')) {
          return new Response(
            JSON.stringify({
              items: [
                { tmdb_id: ON_DISK, title: 'Owned On Disk', year: 2020, provenance: 'personalized', score: 0.9 },
                { tmdb_id: NOT_ON_DISK, title: 'Streaming Only', year: 2023, provenance: 'personalized', score: 0.8 },
              ],
              model_version: 'test-mv',
              recipe: 'fused',
              diag: {},
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      })
      vi.stubGlobal('fetch', spy)

      const r = await app.request('/api/suggestions/movie', { headers: { Cookie: await userCookie() } })
      expect(r.status).toBe(200)
      const body = (await r.json()) as {
        source: string
        items: Array<{ id: number; available_on?: string[] }>
      }
      expect(body.source).toBe('recommender')
      const onDisk = body.items.find((i) => i.id === ON_DISK)
      const notOnDisk = body.items.find((i) => i.id === NOT_ON_DISK)
      expect(onDisk?.available_on).toContain('local')
      expect(notOnDisk?.available_on ?? []).not.toContain('local')
    } finally {
      mediaDbHandle = null
      raw.close()
    }
  })
})
