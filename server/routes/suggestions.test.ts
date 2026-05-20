import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Hono } from 'hono'
import {
  suggestions,
  _setTmdbApiKeyForTests,
  _resetRecentlyShownForTests,
  _resetLibraryCacheForTests,
  _resetTmdbInFlightForTests,
  _resetLibraryBlockCacheForTests,
} from './suggestions.js'
import { createSession } from '../session.js'
import { _setRejectionsPathForTests, addRejection } from '../services/rejections.js'
import { _setUserFeedbackPathForTests, setLike } from '../services/userFeedback.js'
import { _setUsageLogPathForTests } from '../services/usageLog.js'
import type { Env } from '../middleware/auth.js'

// Capture the most recent Anthropic messages.create() args from the
// suggestions route so we can assert on the prompt shape. The mock is
// hoisted before any imports of @anthropic-ai/sdk thanks to vi.mock.
// Per-test response override via fakeResponse — defaults to empty picks.
const lastCreateArgs: { value: unknown } = { value: null }
const fakeResponse: { value: unknown } = { value: null }

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = {
      create: async (args: unknown) => {
        lastCreateArgs.value = args
        if (fakeResponse.value) return fakeResponse.value
        return {
          content: [
            { type: 'tool_use', id: 'tu_default', name: 'submit_recommendations', input: { picks: [] } },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      },
    }
    constructor(_opts: unknown) {}
  }
  return { default: FakeAnthropic }
})

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', suggestions)
  return app
}

async function userCookie() {
  const t = await createSession({ sub: '1', username: 'guest', role: 'user' })
  return `eex.session=${t}`
}

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'sugg-route-'))
  _setRejectionsPathForTests(join(tmpRoot, 'rejections.json'))
  _setUserFeedbackPathForTests(join(tmpRoot, 'feedback.json'))
  _setUsageLogPathForTests(join(tmpRoot, 'usage.jsonl'))
  lastCreateArgs.value = null
  fakeResponse.value = null
  _setTmdbApiKeyForTests(null)
  _resetRecentlyShownForTests()
  _resetLibraryCacheForTests()
  _resetTmdbInFlightForTests()
  _resetLibraryBlockCacheForTests()
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
  vi.unstubAllGlobals()
  _setTmdbApiKeyForTests(null)
})

describe('suggestions route — gating', () => {
  it('rejects unauthenticated', async () => {
    const r = await appUnderTest().request('/movie')
    expect(r.status).toBe(401)
  })

  it('400 on invalid type', async () => {
    const r = await appUnderTest().request('/books', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(400)
  })

  it('200 on valid type with cold-start library (no Claude call)', async () => {
    // Stub upstreams to empty so the route exits cleanly via the
    // cold-start branch without touching real APIs.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })),
    )
    const r = await appUnderTest().request('/tv', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { source: string; items: unknown[] }
    expect(typeof body.source).toBe('string')
    expect(Array.isArray(body.items)).toBe(true)
    expect(lastCreateArgs.value).toBeNull()
  })
})

describe('suggestions route — prompt shape', () => {
  // Library big enough to clear COLD_START_THRESHOLD (10) so the route
  // takes the Claude path.
  const sonarrSeries = [
    { title: 'Sons of Anarchy', year: 2008, tmdbId: 1001, genres: ['Crime', 'Drama'] },
    { title: 'House of the Dragon', year: 2022, tmdbId: 1002, genres: ['Drama', 'Fantasy'] },
    { title: 'The Crown', year: 2016, tmdbId: 1003, genres: ['Drama', 'History'] },
    { title: 'Succession', year: 2018, tmdbId: 1004, genres: ['Drama'] },
    { title: 'Better Call Saul', year: 2015, tmdbId: 1005, genres: ['Crime', 'Drama'] },
    { title: 'Mindhunter', year: 2017, tmdbId: 1006, genres: ['Crime', 'Drama'] },
    { title: 'Halt and Catch Fire', year: 2014, tmdbId: 1007, genres: ['Drama'] },
    { title: 'Ozark', year: 2017, tmdbId: 1008, genres: ['Crime', 'Drama', 'Thriller'] },
    { title: 'The Wire', year: 2002, tmdbId: 1009, genres: ['Crime', 'Drama'] },
    { title: 'The Americans', year: 2013, tmdbId: 1010, genres: ['Crime', 'Drama', 'Thriller'] },
  ]

  function stubFetchForSonarr() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as { url: string }).url
        if (url.includes('/api/v3/series')) {
          return new Response(JSON.stringify(sonarrSeries), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        // Default: empty list (TMDB trending lookups, etc.).
        return new Response('[]', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )
  }

  it('includes titled rejection bullets in the cached system block', async () => {
    await addRejection('tv', 8001, 'Pokémon')
    await addRejection('tv', 8002, 'Delicious in Dungeon')
    stubFetchForSonarr()

    const r = await appUnderTest().request('/tv', {
      headers: {
        Cookie: await userCookie(),
        'X-Anthropic-Api-Key': 'sk-ant-test-fakekey',
      },
    })
    expect(r.status).toBe(200)
    expect(lastCreateArgs.value).not.toBeNull()
    const args = lastCreateArgs.value as {
      system: Array<{ type: string; text: string }>
    }
    const blocks = args.system.map((s) => s.text).join('\n')
    expect(blocks).toContain('NEVER SUGGEST')
    expect(blocks).toContain('- Pokémon')
    expect(blocks).toContain('- Delicious in Dungeon')
  })

  it('renders [TMDB id N] fallback bullets for legacy untitled entries the backfill could not resolve', async () => {
    await addRejection('tv', 8003, '') // legacy bare-id row, TMDB key absent → no backfill
    await addRejection('tv', 8004, 'Severance')
    // No TMDB key in test env → tmdbTitleById short-circuits to null
    stubFetchForSonarr()

    const r = await appUnderTest().request('/tv', {
      headers: {
        Cookie: await userCookie(),
        'X-Anthropic-Api-Key': 'sk-ant-test-fakekey',
      },
    })
    expect(r.status).toBe(200)
    const args = lastCreateArgs.value as {
      system: Array<{ type: string; text: string }>
    }
    const blocks = args.system.map((s) => s.text).join('\n')
    expect(blocks).toContain('- Severance')
    // Fallback bullet for the unresolved id — still in the prompt.
    expect(blocks).toContain('- [TMDB id 8003]')
  })

  it('backfills missing titles via TMDB id-lookup and persists them', async () => {
    // Pre-seed the rejection list with a bare-id row.
    await addRejection('tv', 8005, '')

    // Stub fetch: Sonarr returns library; TMDB /tv/8005 returns a name.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as { url: string }).url
        if (url.includes('/api/v3/series')) {
          return new Response(JSON.stringify(sonarrSeries), { status: 200 })
        }
        if (url.includes('themoviedb.org/3/tv/8005')) {
          return new Response(JSON.stringify({ name: 'Squid Game' }), { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    // Force a key so tmdbTitleById doesn't short-circuit.
    _setTmdbApiKeyForTests('test-key')

    const r = await appUnderTest().request('/tv', {
      headers: {
        Cookie: await userCookie(),
        'X-Anthropic-Api-Key': 'sk-ant-test-fakekey',
      },
    })
    expect(r.status).toBe(200)
    const args = lastCreateArgs.value as {
      system: Array<{ type: string; text: string }>
    }
    const blocks = args.system.map((s) => s.text).join('\n')
    expect(blocks).toContain('- Squid Game')
    expect(blocks).not.toContain('- [TMDB id 8005]')

    // Persisted: a follow-up read should see the resolved title.
    const { getRejections } = await import('../services/rejections.js')
    const after = await getRejections()
    expect(after.tv).toContainEqual({ id: 8005, title: 'Squid Game' })

  })

  it('falls back to trending when every Claude pick is filtered out (after retry)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    let claudeCallCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as { url: string }).url
        if (url.includes('/api/v3/series')) {
          return new Response(JSON.stringify(sonarrSeries), { status: 200 })
        }
        if (url.includes('themoviedb.org/3/search/tv')) {
          // Always resolve to a library-overlap id so every pick fails validation.
          return new Response(
            JSON.stringify({
              results: [
                { id: 1001, name: 'Sons of Anarchy', poster_path: null, first_air_date: '2008-09-03' },
              ],
            }),
            { status: 200 },
          )
        }
        return new Response('[]', { status: 200 })
      }),
    )
    _setTmdbApiKeyForTests('test-key')
    // Both initial + retry return a single pick that resolves to a
    // library duplicate, so the route falls through to trending (also empty in this stub).
    fakeResponse.value = {
      content: [
        {
          type: 'tool_use',
          id: 'tu_' + ++claudeCallCount,
          name: 'submit_recommendations',
          input: { picks: [{ title: 'Sons of Anarchy', year: 2008 }] },
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    }

    const r = await appUnderTest().request('/tv', {
      headers: {
        Cookie: await userCookie(),
        'X-Anthropic-Api-Key': 'sk-ant-test-fakekey',
      },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { source: string; items: unknown[] }
    expect(body.source).toBe('personalized_empty_trending_fallback')
    expect(body.items).toEqual([]) // TMDB trending stub returns []
    const call = warnSpy.mock.calls.find((c) =>
      String(c[0]).includes('Personalized picks short of target'),
    )
    expect(call).toBeDefined()
    expect(call?.[1]).toMatchObject({ accepted: 0, retryAttempted: true })

    warnSpy.mockRestore()
  })

  it('logs an error and falls back to trending when Claude returns no tool_use', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    stubFetchForSonarr()
    // No tool_use block — should hit the readToolUse error path and treat picks as empty.
    fakeResponse.value = {
      content: [{ type: 'text', text: 'whoops, no tool here' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }

    const r = await appUnderTest().request('/tv', {
      headers: {
        Cookie: await userCookie(),
        'X-Anthropic-Api-Key': 'sk-ant-test-fakekey',
      },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { source: string; items: unknown[] }
    expect(body.source).toBe('personalized_empty_trending_fallback')
    expect(body.items).toEqual([])
    const call = errSpy.mock.calls.find((c) => String(c[0]).includes('no tool_use block'))
    expect(call).toBeDefined()
    errSpy.mockRestore()
  })

  it('injects a PRIORITY TASTE SIGNAL volatile block after the cached library when library size exceeds the trigger', async () => {
    // Library big enough to trip the priority-taste trigger (>=60 items).
    const bigLib = Array.from({ length: 70 }, (_, i) => ({
      title: `Show ${i}`,
      year: 2010 + (i % 14),
      tmdbId: 7000 + i,
      genres: i % 3 === 0 ? ['Drama', 'Crime'] : i % 3 === 1 ? ['Drama'] : ['Sci-Fi & Fantasy', 'Action & Adventure'],
    }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as { url: string }).url
        if (url.includes('/api/v3/series')) {
          return new Response(JSON.stringify(bigLib), { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/tv', {
      headers: { Cookie: await userCookie(), 'X-Anthropic-Api-Key': 'sk-ant-test-fakekey' },
    })
    expect(r.status).toBe(200)
    const args = lastCreateArgs.value as {
      system: Array<{ type: string; text: string; cache_control?: unknown }>
    }
    const priority = args.system.find((s) => s.text.includes('PRIORITY TASTE SIGNAL'))
    expect(priority).toBeDefined()
    expect(priority?.cache_control).toBeUndefined() // volatile, not cached
    // Should pull at most PRIORITY_TASTE_CAP titles into the block.
    const bulletCount = (priority?.text.match(/^- /gm) ?? []).length
    expect(bulletCount).toBeLessThanOrEqual(30)
    expect(bulletCount).toBeGreaterThanOrEqual(20)
  })

  it('does NOT inject the priority-taste block for small libraries (full library already fits in the attended zone)', async () => {
    stubFetchForSonarr() // 10-item library, well below the 60-item trigger
    const r = await appUnderTest().request('/tv', {
      headers: { Cookie: await userCookie(), 'X-Anthropic-Api-Key': 'sk-ant-test-fakekey' },
    })
    expect(r.status).toBe(200)
    const args = lastCreateArgs.value as { system: Array<{ text: string }> }
    const found = args.system.find((s) => s.text.includes('PRIORITY TASTE SIGNAL'))
    expect(found).toBeUndefined()
  })

  it('injects a per-request salt + rotation quota in the user message so refreshes vary', async () => {
    stubFetchForSonarr()
    const r1 = await appUnderTest().request('/tv', {
      headers: { Cookie: await userCookie(), 'X-Anthropic-Api-Key': 'sk-ant-test-fakekey' },
    })
    expect(r1.status).toBe(200)
    const args1 = lastCreateArgs.value as { messages: Array<{ content: string }> }
    const user1 = args1.messages[0].content
    expect(user1).toContain('ROTATION QUOTA')
    expect(user1).toMatch(/Request salt[^:]*:\s*([0-9a-f]{8})/)
    const m1 = user1.match(/Request salt[^:]*:\s*([0-9a-f]{8})/)!
    // Second request — fresh salt, must differ
    lastCreateArgs.value = null
    const r2 = await appUnderTest().request('/tv', {
      headers: { Cookie: await userCookie(), 'X-Anthropic-Api-Key': 'sk-ant-test-fakekey' },
    })
    expect(r2.status).toBe(200)
    const args2 = lastCreateArgs.value as { messages: Array<{ content: string }> }
    const user2 = args2.messages[0].content
    const m2 = user2.match(/Request salt[^:]*:\s*([0-9a-f]{8})/)!
    expect(m1[1]).not.toBe(m2[1])
  })

  it('uses tool_choice to force submit_recommendations', async () => {
    stubFetchForSonarr()
    const r = await appUnderTest().request('/tv', {
      headers: {
        Cookie: await userCookie(),
        'X-Anthropic-Api-Key': 'sk-ant-test-fakekey',
      },
    })
    expect(r.status).toBe(200)
    const args = lastCreateArgs.value as {
      tools?: Array<{ name: string }>
      tool_choice?: { type: string; name: string; disable_parallel_tool_use?: boolean }
    }
    expect(args.tools?.[0]?.name).toBe('submit_recommendations')
    expect(args.tool_choice).toEqual({
      type: 'tool',
      name: 'submit_recommendations',
      disable_parallel_tool_use: true,
    })
  })

  it('emits user-likes block after the cached prefix when titles are present', async () => {
    await setLike('1', 'tv', 9001, 'Sons of Anarchy')
    stubFetchForSonarr()

    const r = await appUnderTest().request('/tv', {
      headers: {
        Cookie: await userCookie(),
        'X-Anthropic-Api-Key': 'sk-ant-test-fakekey',
      },
    })
    expect(r.status).toBe(200)
    const args = lastCreateArgs.value as {
      system: Array<{ type: string; text: string; cache_control?: unknown }>
    }
    // Find the user-likes block — it's the one without cache_control.
    const likes = args.system.find((s) => s.text.includes('explicitly LIKED'))
    expect(likes).toBeDefined()
    expect(likes?.cache_control).toBeUndefined()
    expect(likes?.text).toContain('- Sons of Anarchy')
  })

  it('orders liked titles most-recently-liked first in the likes block', async () => {
    // Likes are stored oldest-first (push). The block should reverse
    // so the most recently liked title has the highest prompt attention.
    await setLike('1', 'tv', 9001, 'Show Alpha') // liked first → oldest
    await setLike('1', 'tv', 9002, 'Show Beta')  // liked second
    await setLike('1', 'tv', 9003, 'Show Gamma') // liked last → newest, should appear first
    stubFetchForSonarr()

    const r = await appUnderTest().request('/tv', {
      headers: { Cookie: await userCookie(), 'X-Anthropic-Api-Key': 'sk-ant-test-fakekey' },
    })
    expect(r.status).toBe(200)
    const args = lastCreateArgs.value as { system: Array<{ text: string }> }
    const likes = args.system.find((s) => s.text.includes('explicitly LIKED'))!
    const gammaPos = likes.text.indexOf('Show Gamma')
    const alphaPos = likes.text.indexOf('Show Alpha')
    // Gamma (newest) should appear BEFORE Alpha (oldest).
    expect(gammaPos).toBeGreaterThanOrEqual(0)
    expect(alphaPos).toBeGreaterThanOrEqual(0)
    expect(gammaPos).toBeLessThan(alphaPos)
  })

  it('skips user-likes block entirely when no titled likes exist', async () => {
    stubFetchForSonarr()
    const r = await appUnderTest().request('/tv', {
      headers: {
        Cookie: await userCookie(),
        'X-Anthropic-Api-Key': 'sk-ant-test-fakekey',
      },
    })
    expect(r.status).toBe(200)
    const args = lastCreateArgs.value as {
      system: Array<{ text: string }>
    }
    const found = args.system.find((s) => s.text.includes('explicitly LIKED'))
    expect(found).toBeUndefined()
  })

  it('includes a TARGET GENRE MIX line with computed percentages', async () => {
    stubFetchForSonarr()
    const r = await appUnderTest().request('/tv', {
      headers: {
        Cookie: await userCookie(),
        'X-Anthropic-Api-Key': 'sk-ant-test-fakekey',
      },
    })
    expect(r.status).toBe(200)
    const args = lastCreateArgs.value as {
      system: Array<{ text: string }>
    }
    const blocks = args.system.map((s) => s.text).join('\n')
    expect(blocks).toContain('TARGET GENRE MIX')
    // Library is 3 dramas + 1 crime + 1 fantasy + 1 history.
    // Drama appears in all 3 (3/6 = 50%).
    expect(blocks).toMatch(/Drama 50%/)
  })

  it('injects a CANDIDATE POOL block in the system stack when TMDB /discover returns results', async () => {
    // Verify that the candidate-pool block appears after the cached
    // library block and is NOT itself cached (it must be volatile so
    // the pool can vary each request).
    _setTmdbApiKeyForTests('test-key')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as { url: string }).url
        if (url.includes('/api/v3/series')) {
          return new Response(JSON.stringify(sonarrSeries), { status: 200 })
        }
        if (url.includes('themoviedb.org/3/discover/')) {
          const rows = Array.from({ length: 5 }, (_, i) => ({
            id: 9_800_000 + i,
            name: `Pool Show ${i + 1}`,
            poster_path: null,
            first_air_date: '2023-01-01',
          }))
          return new Response(JSON.stringify({ results: rows }), { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/tv', {
      headers: { Cookie: await userCookie(), 'X-Anthropic-Api-Key': 'sk-ant-test-fakekey' },
    })
    expect(r.status).toBe(200)
    const args = lastCreateArgs.value as {
      system: Array<{ type: string; text: string; cache_control?: unknown }>
    }
    const poolBlock = args.system.find((s) => s.text.includes('CANDIDATE POOL'))
    expect(poolBlock).toBeDefined()
    expect(poolBlock?.cache_control).toBeUndefined() // must be volatile
    expect(poolBlock?.text).toContain('Pool Show 1')
  })

  it('pool picks are accepted without a TMDB /search round-trip and carry personalized provenance', async () => {
    // Pool item title exactly matches a Claude pick → validate fast-path
    // skips the TMDB /search call and returns the pool item's id.
    _setTmdbApiKeyForTests('test-key')
    let searchCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as { url: string }).url
        if (url.includes('/api/v3/series')) {
          return new Response(JSON.stringify(sonarrSeries), { status: 200 })
        }
        if (url.includes('themoviedb.org/3/discover/')) {
          const rows = [{ id: 9_900_001, name: 'Pool Pick A', poster_path: null, first_air_date: '2022-01-01' }]
          return new Response(JSON.stringify({ results: rows }), { status: 200 })
        }
        if (url.includes('themoviedb.org/3/search/')) {
          searchCalls++
          return new Response(JSON.stringify({ results: [] }), { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    // Claude picks the pool item by exact title.
    fakeResponse.value = {
      content: [
        {
          type: 'tool_use',
          id: 'tu_pool',
          name: 'submit_recommendations',
          input: {
            picks: Array.from({ length: 20 }, () => ({
              title: 'Pool Pick A',
              year: 2022,
              reason: 'matches crime cluster',
            })),
          },
        },
      ],
      usage: { input_tokens: 50, output_tokens: 30 },
    }
    const r = await appUnderTest().request('/tv', {
      headers: { Cookie: await userCookie(), 'X-Anthropic-Api-Key': 'sk-ant-test-fakekey' },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { source: string; items: Array<{ id: number; provenance: string; reason: string | null }> }
    // First accepted item should come from the pool (id matches discover row).
    expect(body.items[0]?.id).toBe(9_900_001)
    expect(body.items[0]?.provenance).toBe('personalized')
    // No /search call fired — pool fast-path skipped it.
    expect(searchCalls).toBe(0)
  })
})

describe('suggestions route — TMDB validation', () => {
  const sonarrSeries = [
    { title: 'Sons of Anarchy', year: 2008, tmdbId: 1001, genres: ['Crime', 'Drama'] },
    { title: 'House of the Dragon', year: 2022, tmdbId: 1002, genres: ['Drama', 'Fantasy'] },
    { title: 'The Crown', year: 2016, tmdbId: 1003, genres: ['Drama', 'History'] },
    { title: 'Succession', year: 2018, tmdbId: 1004, genres: ['Drama'] },
    { title: 'Better Call Saul', year: 2015, tmdbId: 1005, genres: ['Crime', 'Drama'] },
    { title: 'Mindhunter', year: 2017, tmdbId: 1006, genres: ['Crime', 'Drama'] },
    { title: 'Halt and Catch Fire', year: 2014, tmdbId: 1007, genres: ['Drama'] },
    { title: 'Ozark', year: 2017, tmdbId: 1008, genres: ['Crime', 'Drama'] },
    { title: 'The Wire', year: 2002, tmdbId: 1009, genres: ['Crime', 'Drama'] },
    { title: 'The Americans', year: 2013, tmdbId: 1010, genres: ['Crime', 'Drama'] },
  ]

  it('drops movie picks whose TMDB top-match year is far from the requested year', async () => {
    // Year guard is movie-only — TV picks routinely hit legitimate
    // year mismatches (series-premiere vs latest-season year) so the
    // guard does more harm than good there.
    const radarrLibrary = [
      { title: 'The Dark Knight', year: 2008, tmdbId: 2001, genres: ['Action', 'Crime'] },
      { title: 'Inception', year: 2010, tmdbId: 2002, genres: ['Action', 'Sci-Fi'] },
      { title: 'Interstellar', year: 2014, tmdbId: 2003, genres: ['Sci-Fi', 'Drama'] },
      { title: 'Heat', year: 1995, tmdbId: 2004, genres: ['Action', 'Crime', 'Drama'] },
      { title: 'No Country for Old Men', year: 2007, tmdbId: 2005, genres: ['Crime', 'Drama', 'Thriller'] },
      { title: 'There Will Be Blood', year: 2007, tmdbId: 2006, genres: ['Drama'] },
      { title: 'The Departed', year: 2006, tmdbId: 2007, genres: ['Crime', 'Drama', 'Thriller'] },
      { title: 'Zodiac', year: 2007, tmdbId: 2008, genres: ['Crime', 'Drama', 'Mystery'] },
      { title: 'Prisoners', year: 2013, tmdbId: 2009, genres: ['Crime', 'Drama', 'Mystery', 'Thriller'] },
      { title: 'Sicario', year: 2015, tmdbId: 2010, genres: ['Action', 'Crime', 'Drama', 'Thriller'] },
    ]
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let claudeCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as { url: string }).url
        if (url.includes('/api/v3/movie')) {
          return new Response(JSON.stringify(radarrLibrary), { status: 200 })
        }
        if (url.includes('themoviedb.org/3/search/movie')) {
          // Return a 1990 result for a pick that asked for 2020 — far outside the ±5 window.
          return new Response(
            JSON.stringify({
              results: [
                { id: 7777, title: 'Different Movie With Same Words', poster_path: null, release_date: '1990-01-01' },
              ],
            }),
            { status: 200 },
          )
        }
        return new Response('[]', { status: 200 })
      }),
    )
    _setTmdbApiKeyForTests('test-key')
    fakeResponse.value = {
      content: [
        {
          type: 'tool_use',
          id: 'tu_' + ++claudeCalls,
          name: 'submit_recommendations',
          input: { picks: [{ title: 'Brand New Movie', year: 2020 }] },
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    }

    const r = await appUnderTest().request('/movie', {
      headers: {
        Cookie: await userCookie(),
        'X-Anthropic-Api-Key': 'sk-ant-test-fakekey',
      },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { source: string; items: unknown[] }
    // Pick was dropped — no personalized survivors → empty trending fallback.
    expect(body.source).toBe('personalized_empty_trending_fallback')
    expect(body.items).toEqual([])
    warnSpy.mockRestore()
  })

  it('caches Sonarr library across two consecutive calls (single upstream fetch)', async () => {
    const sonarrSeriesLocal = [
      { title: 'Sons of Anarchy', year: 2008, tmdbId: 1001, genres: ['Crime', 'Drama'] },
      { title: 'House of the Dragon', year: 2022, tmdbId: 1002, genres: ['Drama', 'Fantasy'] },
      { title: 'The Crown', year: 2016, tmdbId: 1003, genres: ['Drama', 'History'] },
      { title: 'Succession', year: 2018, tmdbId: 1004, genres: ['Drama'] },
      { title: 'Better Call Saul', year: 2015, tmdbId: 1005, genres: ['Crime', 'Drama'] },
      { title: 'Mindhunter', year: 2017, tmdbId: 1006, genres: ['Crime', 'Drama'] },
      { title: 'Halt and Catch Fire', year: 2014, tmdbId: 1007, genres: ['Drama'] },
      { title: 'Ozark', year: 2017, tmdbId: 1008, genres: ['Crime', 'Drama'] },
      { title: 'The Wire', year: 2002, tmdbId: 1009, genres: ['Crime', 'Drama'] },
      { title: 'The Americans', year: 2013, tmdbId: 1010, genres: ['Crime', 'Drama'] },
    ]
    let sonarrFetches = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as { url: string }).url
        if (url.includes('/api/v3/series')) {
          sonarrFetches++
          return new Response(JSON.stringify(sonarrSeriesLocal), { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    _setTmdbApiKeyForTests('test-key')
    fakeResponse.value = {
      content: [
        { type: 'tool_use', id: 'tu_a', name: 'submit_recommendations', input: { picks: [] } },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    }

    const app = appUnderTest()
    const cookie = await userCookie()
    const r1 = await app.request('/tv', {
      headers: { Cookie: cookie, 'X-Anthropic-Api-Key': 'sk-ant-test-fakekey' },
    })
    expect(r1.status).toBe(200)
    const r2 = await app.request('/tv', {
      headers: { Cookie: cookie, 'X-Anthropic-Api-Key': 'sk-ant-test-fakekey' },
    })
    expect(r2.status).toBe(200)
    // Single Sonarr fetch despite two route invocations.
    expect(sonarrFetches).toBe(1)
  })

  it('emits a Server-Timing response header with phase durations', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as { url: string }).url
        if (url.includes('/api/v3/series')) {
          return new Response(JSON.stringify([]), { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/tv', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
    const st = r.headers.get('Server-Timing') ?? ''
    // Cold-start path runs prologue + trending.
    expect(st).toMatch(/prologue;dur=[\d.]+/)
    expect(st).toMatch(/trending;dur=[\d.]+/)
  })

  it('omits RECENTLY SHOWN block on the first call but injects it on the second (call-to-call variety)', async () => {
    const sonarrSeriesLocal = [
      { title: 'Sons of Anarchy', year: 2008, tmdbId: 1001, genres: ['Crime', 'Drama'] },
      { title: 'House of the Dragon', year: 2022, tmdbId: 1002, genres: ['Drama', 'Fantasy'] },
      { title: 'The Crown', year: 2016, tmdbId: 1003, genres: ['Drama', 'History'] },
      { title: 'Succession', year: 2018, tmdbId: 1004, genres: ['Drama'] },
      { title: 'Better Call Saul', year: 2015, tmdbId: 1005, genres: ['Crime', 'Drama'] },
      { title: 'Mindhunter', year: 2017, tmdbId: 1006, genres: ['Crime', 'Drama'] },
      { title: 'Halt and Catch Fire', year: 2014, tmdbId: 1007, genres: ['Drama'] },
      { title: 'Ozark', year: 2017, tmdbId: 1008, genres: ['Crime', 'Drama'] },
      { title: 'The Wire', year: 2002, tmdbId: 1009, genres: ['Crime', 'Drama'] },
      { title: 'The Americans', year: 2013, tmdbId: 1010, genres: ['Crime', 'Drama'] },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as { url: string }).url
        if (url.includes('/api/v3/series')) {
          return new Response(JSON.stringify(sonarrSeriesLocal), { status: 200 })
        }
        if (url.includes('themoviedb.org/3/search/tv')) {
          return new Response(
            JSON.stringify({
              results: [{ id: 9001, name: 'Severance', poster_path: '/p.jpg', first_air_date: '2022-02-18' }],
            }),
            { status: 200 },
          )
        }
        return new Response('[]', { status: 200 })
      }),
    )
    _setTmdbApiKeyForTests('test-key')
    fakeResponse.value = {
      content: [
        {
          type: 'tool_use',
          id: 'tu_first',
          name: 'submit_recommendations',
          input: { picks: [{ title: 'Severance', year: 2022 }] },
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    }

    const app = appUnderTest()
    const cookie = await userCookie()

    // First call — no history yet.
    const r1 = await app.request('/tv', {
      headers: { Cookie: cookie, 'X-Anthropic-Api-Key': 'sk-ant-test-fakekey' },
    })
    expect(r1.status).toBe(200)
    const args1 = lastCreateArgs.value as {
      system: Array<{ text: string; cache_control?: unknown }>
    }
    expect(args1.system.find((s) => s.text.includes('RECENTLY SHOWN'))).toBeUndefined()

    // Second call — recorded items from r1 should now appear in
    // RECENTLY SHOWN, in the volatile (non-cached) portion of the stack.
    lastCreateArgs.value = null
    const r2 = await app.request('/tv', {
      headers: { Cookie: cookie, 'X-Anthropic-Api-Key': 'sk-ant-test-fakekey' },
    })
    expect(r2.status).toBe(200)
    const args2 = lastCreateArgs.value as {
      system: Array<{ text: string; cache_control?: unknown }>
    }
    const recentBlock = args2.system.find((s) => s.text.includes('RECENTLY SHOWN'))
    expect(recentBlock).toBeDefined()
    expect(recentBlock?.text).toContain('- Severance')
    // Volatile block — must NOT carry cache_control or it would
    // invalidate the household library cache prefix on every call.
    expect(recentBlock?.cache_control).toBeUndefined()
  })

  it('uses TMDB discover with library top genres when personalized picks short, before falling back to trending', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchedUrls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as { url: string }).url
        fetchedUrls.push(url)
        if (url.includes('/api/v3/series')) {
          return new Response(JSON.stringify(sonarrSeries), { status: 200 })
        }
        if (url.includes('themoviedb.org/3/discover/tv')) {
          return new Response(
            JSON.stringify({
              results: [
                { id: 5555, name: 'Discover Drama Pick', poster_path: '/p.jpg', first_air_date: '2021-05-01' },
              ],
            }),
            { status: 200 },
          )
        }
        if (url.includes('themoviedb.org/3/search/tv')) {
          // Claude's pick can't be looked up — forces the fill path.
          return new Response(JSON.stringify({ results: [] }), { status: 200 })
        }
        return new Response('[]', { status: 200 })
      }),
    )
    _setTmdbApiKeyForTests('test-key')
    fakeResponse.value = {
      content: [
        {
          type: 'tool_use',
          id: 'tu_zero',
          name: 'submit_recommendations',
          input: { picks: [{ title: 'Some Title That Won’t Resolve', year: 2024 }] },
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    }

    const r = await appUnderTest().request('/tv', {
      headers: {
        Cookie: await userCookie(),
        'X-Anthropic-Api-Key': 'sk-ant-test-fakekey',
      },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      source: string
      items: Array<{ id: number; title: string }>
      _diag?: { fillSource?: string }
    }
    expect(body.source).toBe('personalized_empty_trending_fallback')
    // Discover fired (either from prefetch or the fill path itself).
    expect(fetchedUrls.some((u) => u.includes('themoviedb.org/3/discover/tv'))).toBe(true)
    expect(body.items.find((i) => i.id === 5555)).toBeDefined()
    expect(body._diag?.fillSource).toMatch(/^discover/)
    warnSpy.mockRestore()
  })
})
