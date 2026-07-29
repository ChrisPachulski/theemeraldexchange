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
  _resetLibraryStaleFallbackForTests,
  _resetTmdbInFlightForTests,
} from './suggestions.js'
import { createMemberSession as createSession } from '../test/authFixture.js'
import { _setRejectionsPathForTests } from '../services/rejections.js'
import { _setUserFeedbackPathForTests } from '../services/userFeedback.js'
import { _setUsageLogPathForTests } from '../services/usageLog.js'
import { serverDb } from '../services/serverDb.js'
import { setUserApiKey } from '../services/userApiKeys.js'
import type { Env } from '../middleware/auth.js'

// Key-resolution precedence on the legacy BYO-key Claude path
// (services/suggestionsClaudePath.ts):
//   1. X-Anthropic-Api-Key header (back-compat) wins when present.
//   2. The server-stored key (PUT /api/settings/anthropic-key) is used
//      when the header is absent — the post-migration SPA never holds
//      the key client-side.
//   3. Neither → 402 api_key_required (unchanged).
// The Anthropic constructor is captured so the tests can assert exactly
// which key the pipeline authenticated with.

const constructedWith = vi.hoisted(() => ({ keys: [] as Array<string | undefined> }))

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = {
      create: async () => ({
        content: [
          { type: 'tool_use', id: 'tu_default', name: 'submit_recommendations', input: { picks: [] } },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    }
    constructor(opts: { apiKey?: string }) {
      constructedWith.keys.push(opts?.apiKey)
    }
  }
  return { default: FakeAnthropic }
})

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', suggestions)
  return app
}

const SUB = 'plex:7771'

async function userCookie() {
  const t = await createSession({ sub: SUB, username: 'stored-key-user', role: 'user' })
  return `eex.session=${t}`
}

// 11 movies — above the cold-start threshold so the request reaches the
// key gate instead of short-circuiting to trending.
function stubLibraryFetch() {
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
        return new Response(
          JSON.stringify(
            Array.from({ length: 11 }, (_, i) => ({
              title: `Stored Key Lib ${i}`,
              year: 2010 + i,
              tmdbId: 7100 + i,
              genres: ['Drama'],
            })),
          ),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }),
  )
}

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'sugg-storedkey-'))
  _setRejectionsPathForTests(join(tmpRoot, 'rejections.json'))
  _setUserFeedbackPathForTests(join(tmpRoot, 'feedback.json'))
  _setUsageLogPathForTests(join(tmpRoot, 'usage.jsonl'))
  _setTmdbApiKeyForTests('test-key')
  _resetRecentlyShownForTests()
  _resetLibraryCacheForTests()
  _resetLibraryStaleFallbackForTests()
  _resetTmdbInFlightForTests()
  constructedWith.keys.length = 0
  serverDb().raw.exec('DELETE FROM user_api_keys;')
  stubLibraryFetch()
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
  vi.unstubAllGlobals()
  _setTmdbApiKeyForTests(null)
})

describe('suggestions route — stored-key resolution', () => {
  it('402s when neither header nor stored key exists', async () => {
    const r = await appUnderTest().request('/movie', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(402)
    expect(constructedWith.keys).toEqual([])
  })

  it('uses the server-stored key when the header is absent', async () => {
    setUserApiKey(SUB, 'sk-ant-stored-key-1111')
    const r = await appUnderTest().request('/movie', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
    expect(constructedWith.keys).toEqual(['sk-ant-stored-key-1111'])
  })

  it('header wins over the stored key (back-compat precedence)', async () => {
    setUserApiKey(SUB, 'sk-ant-stored-key-1111')
    const r = await appUnderTest().request('/movie', {
      headers: {
        Cookie: await userCookie(),
        'X-Anthropic-Api-Key': 'sk-ant-header-key-2222',
      },
    })
    expect(r.status).toBe(200)
    expect(constructedWith.keys).toEqual(['sk-ant-header-key-2222'])
  })

  it("another user's stored key is never used (sub-scoped lookup)", async () => {
    setUserApiKey('plex:someone-else', 'sk-ant-other-user-3333')
    const r = await appUnderTest().request('/movie', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(402)
    expect(constructedWith.keys).toEqual([])
  })
})
