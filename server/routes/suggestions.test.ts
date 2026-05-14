import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Hono } from 'hono'
import { suggestions, _setTmdbApiKeyForTests } from './suggestions.js'
import { createSession } from '../session.js'
import { _setRejectionsPathForTests, addRejection } from '../services/rejections.js'
import { _setUserFeedbackPathForTests, setLike } from '../services/userFeedback.js'
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
          content: [{ type: 'text', text: JSON.stringify({ picks: [] }) }],
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
  lastCreateArgs.value = null
  fakeResponse.value = null
  _setTmdbApiKeyForTests(null)
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
  // Library big enough to clear COLD_START_THRESHOLD (3) so the route
  // takes the Claude path.
  const sonarrSeries = [
    { title: 'Sons of Anarchy', year: 2008, tmdbId: 1001, genres: ['Crime', 'Drama'] },
    { title: 'House of the Dragon', year: 2022, tmdbId: 1002, genres: ['Drama', 'Fantasy'] },
    { title: 'The Crown', year: 2016, tmdbId: 1003, genres: ['Drama', 'History'] },
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

  it('logs an error when picks come back but all get dropped post-filter', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

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
          // Resolve Claude's pick to a library-overlapping id (1001 = Sons of Anarchy in fixture)
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
    fakeResponse.value = {
      content: [
        { type: 'text', text: JSON.stringify({ picks: [{ title: 'Sons of Anarchy', year: 2008 }] }) },
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
    const body = (await r.json()) as { items: unknown[] }
    expect(body.items).toEqual([])
    const call = errSpy.mock.calls.find((c) => String(c[0]).includes('All Claude picks dropped'))
    expect(call).toBeDefined()
    expect(call?.[1]).toMatchObject({ droppedAsLibrary: 1, picksReturned: 1 })

    delete process.env.TMDB_API_KEY
    errSpy.mockRestore()
  })

  it('logs an error and returns empty picks on unparseable JSON', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    stubFetchForSonarr()
    fakeResponse.value = {
      content: [{ type: 'text', text: 'this is not json {' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }

    const r = await appUnderTest().request('/tv', {
      headers: {
        Cookie: await userCookie(),
        'X-Anthropic-Api-Key': 'sk-ant-test-fakekey',
      },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { items: unknown[] }
    expect(body.items).toEqual([])
    const call = errSpy.mock.calls.find((c) => String(c[0]).includes('unparseable JSON'))
    expect(call).toBeDefined()
    errSpy.mockRestore()
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
})
