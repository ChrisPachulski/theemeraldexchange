// /api/ratings — OMDb + Wikidata + Rotten Tomatoes, cached in server.db.
// Verifies the pure parsers, id validation, the merged response shape, and
// that a repeat request is served from title_ratings without upstream calls.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { ratings, parseOmdb, parseRtPage } from './ratings.js'
import { createMemberSession } from '../test/authFixture.js'
import { env } from '../env.js'
import { serverDb } from '../services/serverDb.js'
import type { Env } from '../middleware/auth.js'

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', ratings)
  return app
}

async function cookie() {
  const t = await createMemberSession({ sub: 'plex:2', username: 'guest', role: 'user' })
  return `eex.session=${t}`
}

const RT_HTML = `<script>{"audienceScore":{"bandedRatingCount":"25,000+ Ratings","score":"97","title":"Avg. Popcornmeter"},"criticsScore":{"averageRating":"9.20","score":"96","title":"Avg. Tomatometer"}}</script>`

const originalKey = env.omdbApiKey
let calls: string[] = []

beforeEach(() => {
  calls = []
  ;(env as { omdbApiKey: string | null }).omdbApiKey = 'k'
  serverDb().raw.prepare('DELETE FROM title_ratings').run()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input)
      calls.push(url)
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.startsWith('https://query.wikidata.org/')) {
        return json({ results: { bindings: [{ imdb: { value: 'tt0903747' }, rt: { value: 'tv/breaking_bad' } }] } })
      }
      if (url.startsWith('https://www.rottentomatoes.com/tv/breaking_bad')) {
        return new Response(RT_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } })
      }
      const id = new URL(url).searchParams.get('i')
      return json(
        id === 'tt0903747'
          ? { Response: 'True', imdbRating: '9.5', Metascore: '87', Ratings: [{ Source: 'Rotten Tomatoes', Value: '90%' }] }
          : { Response: 'False', Error: 'Incorrect IMDb ID.' },
      )
    }),
  )
})

afterEach(() => {
  ;(env as { omdbApiKey: string | null }).omdbApiKey = originalKey
  vi.unstubAllGlobals()
})

describe('parsers', () => {
  it('parseOmdb maps N/A to null and reads the RT critic score', () => {
    expect(parseOmdb({ imdbRating: '8.1', Metascore: 'N/A', Ratings: [{ Source: 'Rotten Tomatoes', Value: '77%' }] })).toEqual({ imdb: 8.1, rt: 77, rtAudience: null, metacritic: null })
    expect(parseOmdb({ Response: 'False' })).toEqual({ imdb: null, rt: null, rtAudience: null, metacritic: null })
  })
  it('parseRtPage reads Tomatometer and Popcornmeter from the embedded JSON', () => {
    expect(parseRtPage(RT_HTML)).toEqual({ rt: 96, rtAudience: 97 })
    expect(parseRtPage('<html>no scores</html>')).toEqual({ rt: null, rtAudience: null })
  })
})

describe('GET /api/ratings', () => {
  it('400 on malformed ids', async () => {
    const res = await appUnderTest().request('/?ids=breaking-bad', { headers: { cookie: await cookie() } })
    expect(res.status).toBe(400)
  })

  it('merges OMDb + RT (page wins over OMDb critic score), caches misses, serves repeats from server.db', async () => {
    const app = appUnderTest()
    const headers = { cookie: await cookie() }
    const first = await app.request('/?ids=tt0903747,tt0000001', { headers })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({
      ratings: {
        tt0903747: { imdb: 9.5, rt: 96, rtAudience: 97, metacritic: 87 },
        tt0000001: { imdb: null, rt: null, rtAudience: null, metacritic: null },
      },
      pending: [],
    })
    const upstream = calls.length
    expect(calls.filter((u) => u.startsWith('https://query.wikidata.org/'))).toHaveLength(1)
    expect(calls.filter((u) => u.startsWith('https://www.rottentomatoes.com/'))).toHaveLength(1)

    const second = await app.request('/?ids=tt0903747,tt0000001', { headers })
    expect(second.status).toBe(200)
    expect(calls).toHaveLength(upstream)
  })
})
