// /api/ratings — OMDb proxy with a server.db cache. Verifies the OMDb payload
// projection, the 503-when-unconfigured contract, id validation, and that a
// second request for the same id is served from title_ratings without a
// second upstream call.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { ratings, parseOmdb } from './ratings.js'
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
      const id = new URL(url).searchParams.get('i')
      const body =
        id === 'tt0903747'
          ? { Response: 'True', imdbRating: '9.5', Metascore: '87', Ratings: [{ Source: 'Rotten Tomatoes', Value: '96%' }] }
          : { Response: 'False', Error: 'Incorrect IMDb ID.' }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
})

afterEach(() => {
  ;(env as { omdbApiKey: string | null }).omdbApiKey = originalKey
  vi.unstubAllGlobals()
})

describe('parseOmdb', () => {
  it('projects imdb/rt/metacritic and maps N/A to null', () => {
    expect(parseOmdb({ imdbRating: '8.1', Metascore: 'N/A', Ratings: [] })).toEqual({ imdb: 8.1, rt: null, metacritic: null })
    expect(parseOmdb({ Response: 'False' })).toEqual({ imdb: null, rt: null, metacritic: null })
  })
})

describe('GET /api/ratings', () => {
  it('503 when OMDB_API_KEY is unset', async () => {
    ;(env as { omdbApiKey: string | null }).omdbApiKey = null
    const res = await appUnderTest().request('/?ids=tt0903747', { headers: { cookie: await cookie() } })
    expect(res.status).toBe(503)
  })

  it('400 on malformed ids', async () => {
    const res = await appUnderTest().request('/?ids=breaking-bad', { headers: { cookie: await cookie() } })
    expect(res.status).toBe(400)
  })

  it('returns scores, caches misses as nulls, and serves repeats from server.db', async () => {
    const app = appUnderTest()
    const headers = { cookie: await cookie() }
    const first = await app.request('/?ids=tt0903747,tt0000001', { headers })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({
      tt0903747: { imdb: 9.5, rt: 96, metacritic: 87 },
      tt0000001: { imdb: null, rt: null, metacritic: null },
    })
    expect(calls).toHaveLength(2)

    const second = await app.request('/?ids=tt0903747,tt0000001', { headers })
    expect(second.status).toBe(200)
    expect(calls).toHaveLength(2)
  })
})
