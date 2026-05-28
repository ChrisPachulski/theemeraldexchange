import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { media } from './media.js'
import { createSession } from '../session.js'
import type { Env } from '../middleware/auth.js'

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/api/media', media)
  return app
}

async function userCookie() {
  const t = await createSession({ sub: 'plex:42', username: 'testuser', role: 'user' })
  return `eex.session=${t}`
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ movies: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GET /api/media/movies — authenticated proxy', () => {
  it('forwards to mediaCoreUrl with an authorization Bearer header', async () => {
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>
    const r = await appUnderTest().request('/api/media/movies', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)

    expect(fetchSpy).toHaveBeenCalledOnce()
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as [string, RequestInit & { headers?: Record<string, string> }]
    expect(calledUrl).toMatch(/\/api\/media\/movies$/)

    const authHeader = (calledInit.headers as Record<string, string> | undefined)?.['authorization'] ?? ''
    expect(authHeader).toMatch(/^Bearer /)
  })

  it('returns the upstream status and body to the caller', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ movies: [{ id: 1, title: 'Dune' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const r = await appUnderTest().request('/api/media/movies', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { movies: Array<{ id: number; title: string }> }
    expect(body.movies).toHaveLength(1)
    expect(body.movies[0].title).toBe('Dune')
  })

  it('returns a non-2xx upstream status unchanged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const r = await appUnderTest().request('/api/media/movies/999', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(404)
  })
})

describe('GET /api/media/movies — unauthenticated', () => {
  it('blocks an unauthenticated request with 401', async () => {
    const r = await appUnderTest().request('/api/media/movies')
    expect(r.status).toBe(401)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
