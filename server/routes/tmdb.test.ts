// /api/tmdb — server-side proxy to TMDB. Keeps the API key off the
// client. Two routes:
//   GET /credits?type=tv&tvdbId=… | type=movie&tmdbId=…
//   GET /trending/:type   (type ∈ 'movie' | 'tv')
//
// Both require an authed session (any role). Both return 503 when the
// TMDB_API_KEY is unset — that's the default in the test env, so we
// flip `env.tmdbApiKey` per-test to exercise the configured path.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { tmdb } from './tmdb.js'
import { createSession } from '../session.js'
import { env } from '../env.js'
import type { Env } from '../middleware/auth.js'

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', tmdb)
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
const requests: Array<{ url: string; headers: Headers }> = []

// env.tmdbApiKey is declared `as const` but `as const` is a TS-only
// constraint; the runtime object is plain and mutable. We save the
// original value so we don't leak state between tests.
const originalTmdbKey = env.tmdbApiKey
const originalTmdbReadAccessToken = env.tmdbReadAccessToken

beforeEach(() => {
  responses.clear()
  requests.length = 0
  ;(env as { tmdbReadAccessToken: string | null }).tmdbReadAccessToken = null
  ;(env as { tmdbApiKey: string | null }).tmdbApiKey = 'test-tmdb-key'
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      requests.push({ url, headers: new Headers(init?.headers) })
      for (const [needle, response] of responses) {
        if (url.includes(needle)) {
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

afterEach(() => {
  vi.unstubAllGlobals()
  ;(env as { tmdbApiKey: string | null }).tmdbApiKey = originalTmdbKey
  ;(env as { tmdbReadAccessToken: string | null }).tmdbReadAccessToken = originalTmdbReadAccessToken
})

function stub(needle: string, body: unknown, status = 200) {
  responses.set(needle, { status, body })
}

describe('tmdb — auth gate', () => {
  it('rejects unauthenticated /credits with 401', async () => {
    const r = await appUnderTest().request('/credits?type=movie&tmdbId=550')
    expect(r.status).toBe(401)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated /trending with 401', async () => {
    const r = await appUnderTest().request('/trending/movie')
    expect(r.status).toBe(401)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('tmdb — not_configured', () => {
  it('returns 503 tmdb_not_configured on /credits when api key is null', async () => {
    ;(env as { tmdbApiKey: string | null }).tmdbApiKey = null
    const r = await appUnderTest().request('/credits?type=movie&tmdbId=550', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'tmdb_not_configured' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('returns 503 tmdb_not_configured on /trending when api key is null', async () => {
    ;(env as { tmdbApiKey: string | null }).tmdbApiKey = null
    const r = await appUnderTest().request('/trending/movie', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'tmdb_not_configured' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('tmdb — /credits movie', () => {
  it('uses TMDB_API_KEY as an api_key query parameter', async () => {
    stub('/movie/550/credits', { cast: [], crew: [] })
    const r = await appUnderTest().request('/credits?type=movie&tmdbId=550', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
    expect(requests[0].url).toContain('api_key=test-tmdb-key')
    expect(requests[0].headers.get('authorization')).toBeNull()
  })

  it('uses TMDB_READ_ACCESS_TOKEN as a bearer token', async () => {
    ;(env as { tmdbReadAccessToken: string | null }).tmdbReadAccessToken = 'read-token'
    ;(env as { tmdbApiKey: string | null }).tmdbApiKey = 'fallback-key'
    stub('/movie/550/credits', { cast: [], crew: [] })
    const r = await appUnderTest().request('/credits?type=movie&tmdbId=550', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
    expect(requests[0].url).not.toContain('api_key=')
    expect(requests[0].headers.get('authorization')).toBe('Bearer read-token')
  })

  it('happy path: user gets cast/crew forwarded from TMDB', async () => {
    stub('/movie/550/credits', { cast: [{ name: 'Edward Norton' }], crew: [] })
    const r = await appUnderTest().request('/credits?type=movie&tmdbId=550', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ cast: [{ name: 'Edward Norton' }], crew: [] })
  })

  it('bad upstream → 502 tmdb_credits_failed when credits returns 500', async () => {
    stub('/movie/550/credits', { status_message: 'boom' }, 500)
    const r = await appUnderTest().request('/credits?type=movie&tmdbId=550', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(502)
    const body = (await r.json()) as { error?: string; status?: number }
    expect(body.error).toBe('tmdb_credits_failed')
    expect(body.status).toBe(500)
  })
})

describe('tmdb — /credits tv (TVDB → TMDB find)', () => {
  it('happy path: TVDB resolves to TMDB id, then aggregate_credits is forwarded', async () => {
    stub('/find/8511', { tv_results: [{ id: 12345 }] })
    stub('/tv/12345/aggregate_credits', { cast: [{ name: 'Anna Sawai' }], crew: [] })
    const r = await appUnderTest().request('/credits?type=tv&tvdbId=8511', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ cast: [{ name: 'Anna Sawai' }], crew: [] })
  })

  it('TVDB lookup returns no match → 200 with empty cast/crew', async () => {
    // The route documents this branch: when /find returns no tv_results
    // we resolve to { cast: [], crew: [] } rather than erroring.
    stub('/find/99999', { tv_results: [] })
    const r = await appUnderTest().request('/credits?type=tv&tvdbId=99999', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ cast: [], crew: [] })
  })

  it('TVDB /find returns 502 → tmdb_find_failed', async () => {
    stub('/find/8511', { status_message: 'gone' }, 502)
    const r = await appUnderTest().request('/credits?type=tv&tvdbId=8511', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(502)
    const body = (await r.json()) as { error?: string; status?: number }
    expect(body.error).toBe('tmdb_find_failed')
    expect(body.status).toBe(502)
  })

  it('TV aggregate_credits 500 → tmdb_credits_failed', async () => {
    stub('/find/8511', { tv_results: [{ id: 12345 }] })
    stub('/tv/12345/aggregate_credits', { status_message: 'nope' }, 500)
    const r = await appUnderTest().request('/credits?type=tv&tvdbId=8511', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(502)
    expect(((await r.json()) as { error: string }).error).toBe('tmdb_credits_failed')
  })
})

describe('tmdb — /credits malformed query', () => {
  it('missing type & ids → 400 invalid_query', async () => {
    const r = await appUnderTest().request('/credits', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'invalid_query' })
  })

  it('type=tv with no tvdbId → 400 invalid_query', async () => {
    const r = await appUnderTest().request('/credits?type=tv', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(400)
  })

  it('type=movie with no tmdbId → 400 invalid_query', async () => {
    const r = await appUnderTest().request('/credits?type=movie', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(400)
  })
})

describe('tmdb — /trending/:type', () => {
  it('happy path movie: forwards TMDB results', async () => {
    stub('/trending/movie/week', { results: [{ id: 1, title: 'Foo' }] })
    const r = await appUnderTest().request('/trending/movie', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ results: [{ id: 1, title: 'Foo' }] })
  })

  it('happy path tv: also works for admin role', async () => {
    stub('/trending/tv/week', { results: [{ id: 7, name: 'Bar' }] })
    const r = await appUnderTest().request('/trending/tv', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
  })

  it('invalid type → 400 invalid_type', async () => {
    const r = await appUnderTest().request('/trending/anime', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'invalid_type' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('upstream 500 → 502 tmdb_trending_failed', async () => {
    stub('/trending/movie/week', { status_message: 'boom' }, 500)
    const r = await appUnderTest().request('/trending/movie', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(502)
    const body = (await r.json()) as { error?: string; status?: number }
    expect(body.error).toBe('tmdb_trending_failed')
    expect(body.status).toBe(500)
  })
})

describe('tmdb — /videos', () => {
  it('401 unauthenticated; 503 when not configured', async () => {
    const r1 = await appUnderTest().request('/videos?type=movie&tmdbId=550')
    expect(r1.status).toBe(401)
    ;(env as { tmdbApiKey: string | null }).tmdbApiKey = null
    const r2 = await appUnderTest().request('/videos?type=movie&tmdbId=550', {
      headers: { Cookie: await userCookie() },
    })
    expect(r2.status).toBe(503)
    expect(await r2.json()).toEqual({ error: 'tmdb_not_configured' })
  })

  it('movie: returns only valid YouTube videos, official trailer first', async () => {
    stub('/movie/550/videos', {
      results: [
        { key: '9bZkp7q19f0', name: 'Featurette', site: 'YouTube', type: 'Featurette' },
        { key: 'kJQP7kiw5Fk', name: 'Teaser', site: 'YouTube', type: 'Teaser' },
        { key: 'abc123ABC_-', name: 'Fan Trailer', site: 'YouTube', type: 'Trailer', official: false },
        { key: 'dQw4w9WgXcQ', name: 'Official Trailer', site: 'YouTube', type: 'Trailer', official: true },
        { key: '12345678901', name: 'Vimeo clip', site: 'Vimeo', type: 'Trailer' },
        { key: 'short', name: 'Bad id', site: 'YouTube', type: 'Trailer' },
      ],
    })
    const r = await appUnderTest().request('/videos?type=movie&tmdbId=550', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
    const { videos } = (await r.json()) as { videos: Array<{ key: string; official: boolean }> }
    expect(videos.map((v) => v.key)).toEqual(['dQw4w9WgXcQ', 'abc123ABC_-', 'kJQP7kiw5Fk', '9bZkp7q19f0'])
    expect(videos[0].official).toBe(true)
  })

  it('tv: resolves tvdbId via /find then fetches /tv/<id>/videos', async () => {
    stub('/find/77777', { tv_results: [{ id: 1396 }] })
    stub('/tv/1396/videos', { results: [{ key: 'dQw4w9WgXcQ', name: 'T', site: 'YouTube', type: 'Trailer', official: true }] })
    const r = await appUnderTest().request('/videos?type=tv&tvdbId=77777', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
    const { videos } = (await r.json()) as { videos: unknown[] }
    expect(videos).toHaveLength(1)
  })

  it('rejects bad queries: invalid_query / invalid_tmdbId / invalid_tvdbId', async () => {
    const cookie = await userCookie()
    const noType = await appUnderTest().request('/videos?tmdbId=550', { headers: { Cookie: cookie } })
    expect(noType.status).toBe(400)
    expect((await noType.json() as { error: string }).error).toBe('invalid_query')
    const noMovie = await appUnderTest().request('/videos?type=movie', { headers: { Cookie: cookie } })
    expect((await noMovie.json() as { error: string }).error).toBe('invalid_tmdbId')
    const noTv = await appUnderTest().request('/videos?type=tv', { headers: { Cookie: cookie } })
    expect((await noTv.json() as { error: string }).error).toBe('invalid_tvdbId')
  })

  it('502 tmdb_find_failed when the tv lookup has no results; 502 tmdb_videos_failed on upstream error', async () => {
    stub('/find/77777', { tv_results: [] })
    const findFail = await appUnderTest().request('/videos?type=tv&tvdbId=77777', {
      headers: { Cookie: await userCookie() },
    })
    expect(findFail.status).toBe(502)
    expect((await findFail.json() as { error: string }).error).toBe('tmdb_find_failed')

    stub('/movie/550/videos', { error: 'boom' }, 500)
    const vidFail = await appUnderTest().request('/videos?type=movie&tmdbId=550', {
      headers: { Cookie: await userCookie() },
    })
    expect(vidFail.status).toBe(502)
    expect((await vidFail.json() as { error: string }).error).toBe('tmdb_videos_failed')
  })
})

describe('tmdb — /related', () => {
  it('maps recommendations (poster-filtered, year-parsed, capped at 20)', async () => {
    const rows: Array<Record<string, unknown>> = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      title: `Movie ${i + 1}`,
      poster_path: `/p${i + 1}.jpg`,
      release_date: '2021-05-04',
    }))
    rows.push({ id: 999, title: 'No poster', poster_path: null, release_date: '2020-01-01' })
    stub('/movie/550/recommendations', { results: rows })
    const r = await appUnderTest().request('/related?type=movie&tmdbId=550', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
    const { items } = (await r.json()) as { items: Array<{ tmdbId: number; year: number | null }> }
    expect(items).toHaveLength(20)
    expect(items.every((i) => i.tmdbId !== 999)).toBe(true)
    expect(items[0].year).toBe(2021)
  })

  it('falls back to /similar when recommendations are empty', async () => {
    stub('/movie/550/recommendations', { results: [] })
    stub('/movie/550/similar', { results: [{ id: 12, title: 'Similar', poster_path: '/s.jpg', release_date: '2019-01-01' }] })
    const r = await appUnderTest().request('/related?type=movie&tmdbId=550', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
    const { items } = (await r.json()) as { items: unknown[] }
    expect(items).toEqual([{ tmdbId: 12, title: 'Similar', year: 2019, posterPath: '/s.jpg' }])
  })

  it('401 unauthenticated; 400 invalid_query', async () => {
    expect((await appUnderTest().request('/related?type=movie&tmdbId=550')).status).toBe(401)
    const badQuery = await appUnderTest().request('/related?tmdbId=550', { headers: { Cookie: await userCookie() } })
    expect(badQuery.status).toBe(400)
    expect((await badQuery.json() as { error: string }).error).toBe('invalid_query')
  })
})
