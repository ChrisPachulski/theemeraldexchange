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
import type { Hono } from 'hono'
import type { Env } from '../middleware/auth.js'

let app: Hono<Env>
let createSessionFn: typeof import('../session.js').createSession

beforeAll(async () => {
  vi.resetModules()
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
