import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { plexLinks, _resetPlexLinksCacheForTests } from './plex-links.js'
import { createSession } from '../session.js'
import type { Env } from '../middleware/auth.js'

// Hono helper — wraps the route under test in a minimal app so we can
// fire requests at it without standing up the full server.
function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', plexLinks)
  return app
}

async function userCookie(opts: { withPlexToken?: boolean } = {}): Promise<string> {
  const t = await createSession({
    sub: '1',
    username: 'guest',
    role: 'user',
    plexAuthToken: opts.withPlexToken === false ? undefined : 'plex-test-token',
  })
  return `eex.session=${t}`
}

beforeEach(() => {
  _resetPlexLinksCacheForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  _resetPlexLinksCacheForTests()
})

describe('plex-links — auth + gating', () => {
  it('401s unauthenticated callers', async () => {
    const r = await appUnderTest().request('/library-links')
    expect(r.status).toBe(401)
  })

  it('409 no_plex_token when the session lacks a Plex auth token', async () => {
    const cookie = await userCookie({ withPlexToken: false })
    const r = await appUnderTest().request('/library-links', { headers: { Cookie: cookie } })
    expect(r.status).toBe(409)
    expect(await r.json()).toEqual({ error: 'no_plex_token' })
  })
})

describe('plex-links — resolver', () => {
  // The Plex JSON API returns { MediaContainer: { Directory|Metadata: [...] } }
  // for /library/sections and /library/sections/{key}/all. We stub fetch to
  // return shapes that match the real API verbatim.
  function stubPlex(opts: {
    sections?: Array<{ key: string; type: string; title?: string }>
    metadataByKey?: Record<string, Array<{ ratingKey: string; title?: string; Guid?: Array<{ id?: string }> }>>
    sectionsStatus?: number
    allStatus?: number
  }) {
    const sections = opts.sections ?? [
      { key: '1', type: 'movie', title: 'Movies' },
      { key: '2', type: 'show', title: 'TV Shows' },
    ]
    const metadataByKey = opts.metadataByKey ?? {}
    return vi.fn(async (input: unknown) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url
      if (url.endsWith('/library/sections')) {
        if (opts.sectionsStatus && opts.sectionsStatus >= 400) {
          return new Response('boom', { status: opts.sectionsStatus })
        }
        return new Response(
          JSON.stringify({ MediaContainer: { Directory: sections } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      const m = url.match(/\/library\/sections\/(\d+)\/all/)
      if (m) {
        if (opts.allStatus && opts.allStatus >= 400) {
          return new Response('boom', { status: opts.allStatus })
        }
        const items = metadataByKey[m[1]] ?? []
        return new Response(
          JSON.stringify({ MediaContainer: { Metadata: items } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('[]', { status: 200 })
    })
  }

  it('parses tmdb:// GUIDs into { movie, tv } maps with ratingKeys', async () => {
    vi.stubGlobal(
      'fetch',
      stubPlex({
        metadataByKey: {
          '1': [
            { ratingKey: '101', title: 'Inception', Guid: [{ id: 'tmdb://27205' }, { id: 'imdb://tt1375666' }] },
            { ratingKey: '102', title: 'Arrival', Guid: [{ id: 'tmdb://329865' }] },
            { ratingKey: '103', title: 'Unmatched', Guid: [{ id: 'imdb://tt9999999' }] }, // no tmdb GUID
          ],
          '2': [
            { ratingKey: '201', title: 'Severance', Guid: [{ id: 'tmdb://95396' }] },
          ],
        },
      }),
    )
    const r = await appUnderTest().request('/library-links', { headers: { Cookie: await userCookie() } })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { movie: Record<string, string>; tv: Record<string, string> }
    expect(body.movie['27205']).toBe('101')
    expect(body.movie['329865']).toBe('102')
    expect(body.movie['103']).toBeUndefined()
    expect(body.tv['95396']).toBe('201')
  })

  it('strips query suffixes from tmdb GUIDs (Plex sometimes appends `?lang=…`)', async () => {
    vi.stubGlobal(
      'fetch',
      stubPlex({
        metadataByKey: {
          '1': [
            { ratingKey: '999', title: 'Edge case', Guid: [{ id: 'tmdb://12345?lang=en' }] },
          ],
        },
      }),
    )
    const r = await appUnderTest().request('/library-links', { headers: { Cookie: await userCookie() } })
    const body = (await r.json()) as { movie: Record<string, string>; tv: Record<string, string> }
    expect(body.movie['12345']).toBe('999')
  })

  it('returns an empty map when Plex has no Movie or Show sections', async () => {
    vi.stubGlobal('fetch', stubPlex({ sections: [{ key: '3', type: 'artist', title: 'Music' }] }))
    const r = await appUnderTest().request('/library-links', { headers: { Cookie: await userCookie() } })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { movie: Record<string, string>; tv: Record<string, string> }
    expect(body.movie).toEqual({})
    expect(body.tv).toEqual({})
  })

  it('502 plex_unreachable when /library/sections errors', async () => {
    vi.stubGlobal('fetch', stubPlex({ sectionsStatus: 500 }))
    const r = await appUnderTest().request('/library-links', { headers: { Cookie: await userCookie() } })
    expect(r.status).toBe(502)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('plex_unreachable')
  })

  it('survives a single section throwing (returns the rest)', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url
        if (url.endsWith('/library/sections')) {
          return new Response(
            JSON.stringify({
              MediaContainer: {
                Directory: [
                  { key: '1', type: 'movie' },
                  { key: '2', type: 'show' },
                ],
              },
            }),
            { status: 200 },
          )
        }
        if (url.includes('/library/sections/1/')) {
          calls++
          return new Response('boom', { status: 500 })
        }
        if (url.includes('/library/sections/2/')) {
          return new Response(
            JSON.stringify({
              MediaContainer: {
                Metadata: [{ ratingKey: '201', Guid: [{ id: 'tmdb://95396' }] }],
              },
            }),
            { status: 200 },
          )
        }
        return new Response('[]', { status: 200 })
      }),
    )
    const r = await appUnderTest().request('/library-links', { headers: { Cookie: await userCookie() } })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { movie: Record<string, string>; tv: Record<string, string> }
    expect(body.movie).toEqual({}) // movie section failed
    expect(body.tv['95396']).toBe('201') // show section succeeded
    expect(calls).toBe(1)
  })

  it('caches the resolved map for 5 minutes (second hit does not call Plex again)', async () => {
    const fetchSpy = stubPlex({
      metadataByKey: {
        '1': [{ ratingKey: '101', Guid: [{ id: 'tmdb://27205' }] }],
        '2': [{ ratingKey: '201', Guid: [{ id: 'tmdb://95396' }] }],
      },
    })
    vi.stubGlobal('fetch', fetchSpy)
    const cookie = await userCookie()
    const r1 = await appUnderTest().request('/library-links', { headers: { Cookie: cookie } })
    expect(r1.status).toBe(200)
    const callCount1 = fetchSpy.mock.calls.length
    const r2 = await appUnderTest().request('/library-links', { headers: { Cookie: cookie } })
    expect(r2.status).toBe(200)
    const callCount2 = fetchSpy.mock.calls.length
    // Second request hits the in-process cache; no extra Plex round-trips.
    expect(callCount2).toBe(callCount1)
  })

  it('coalesces in-flight requests (two concurrent callers → one upstream fetch)', async () => {
    let resolveSections!: (v: Response) => void
    const sectionsPromise = new Promise<Response>((res) => {
      resolveSections = res
    })
    const fetchSpy = vi.fn(async (input: unknown) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url
      if (url.endsWith('/library/sections')) return sectionsPromise
      return new Response(JSON.stringify({ MediaContainer: { Metadata: [] } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchSpy)

    const cookie = await userCookie()
    // Fire two concurrent calls — both hit the route while sections is in flight.
    const p1 = appUnderTest().request('/library-links', { headers: { Cookie: cookie } })
    const p2 = appUnderTest().request('/library-links', { headers: { Cookie: cookie } })
    // Resolve the sections fetch once.
    resolveSections(
      new Response(JSON.stringify({ MediaContainer: { Directory: [] } }), { status: 200 }),
    )
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    // Only one upstream /library/sections call across both incoming requests.
    const sectionsCalls = fetchSpy.mock.calls.filter((c) => {
      const url = c[0]
      const s = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as { url: string }).url
      return s.endsWith('/library/sections')
    })
    expect(sectionsCalls.length).toBe(1)
  })
})

describe('plex-links — /server-id', () => {
  it('returns the configured PLEX_SERVER_ID (or null)', async () => {
    const cookie = await userCookie()
    const r = await appUnderTest().request('/server-id', { headers: { Cookie: cookie } })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { serverId: string | null }
    // Test env has PLEX_SERVER_ID unset; production passes the env through.
    expect(body).toHaveProperty('serverId')
  })

  it('requires auth', async () => {
    const r = await appUnderTest().request('/server-id')
    expect(r.status).toBe(401)
  })
})
