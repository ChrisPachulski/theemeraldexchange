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

// env.tmdbApiKey is declared `as const` but `as const` is a TS-only
// constraint; the runtime object is plain and mutable. We save the
// original value so we don't leak state between tests.
const originalTmdbKey = env.tmdbApiKey

beforeEach(() => {
  responses.clear()
  ;(env as { tmdbApiKey: string | null }).tmdbApiKey = 'test-tmdb-key'
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
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
