// Direct unit coverage for the Sonarr/Radarr service wrappers (one
// parameterized suite — the wrappers are the same client instantiated
// twice). This file holds the ONLY copies of the X-Api-Keys in the
// process; the route tests exercise the wrappers indirectly but never
// assert their own contract (header inject, URL build, query merge,
// init.headers preservation, and the rootfolder error surface).
//
// Each call routes through fetchWithTimeout, which re-wraps the upstream
// Response into a fresh Response — so we assert on the RETURNED Response
// and read the actual URL/headers off the vi.fn mock's call args.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from '../env.js'
import { radarrFetch, radarrRootFolders, sonarrFetch, sonarrRootFolders } from './arr.js'

const services = [
  {
    name: 'sonarr',
    arrFetch: sonarrFetch,
    rootFolders: sonarrRootFolders,
    baseUrl: () => env.sonarrUrl,
    apiKey: () => env.sonarrApiKey,
    lookupPath: '/api/v3/series/lookup',
    postPath: '/api/v3/series',
    folderPath: '/tv',
  },
  {
    name: 'radarr',
    arrFetch: radarrFetch,
    rootFolders: radarrRootFolders,
    baseUrl: () => env.radarrUrl,
    apiKey: () => env.radarrApiKey,
    lookupPath: '/api/v3/movie/lookup',
    postPath: '/api/v3/movie',
    folderPath: '/movies',
  },
] as const

let mockFetch: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('console', { ...console, error: vi.fn() })
  mockFetch = vi.fn(async () => new Response('[]', { status: 200 }))
  vi.stubGlobal('fetch', mockFetch)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe.each(services)('$name fetch wrapper', (s) => {
  it('injects X-Api-Key and Accept: application/json', async () => {
    await s.arrFetch('/api/v3/rootfolder')
    const init = mockFetch.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['X-Api-Key']).toBe(s.apiKey())
    expect(headers.Accept).toBe('application/json')
  })

  it('builds the URL as base url + path', async () => {
    await s.arrFetch('/api/v3/rootfolder')
    expect(String(mockFetch.mock.calls[0][0])).toBe(`${s.baseUrl()}/api/v3/rootfolder`)
  })

  it('merges a query URLSearchParams into the URL and percent-encodes special chars', async () => {
    await s.arrFetch(s.lookupPath, {}, new URLSearchParams({ term: 'tron' }))
    const url = String(mockFetch.mock.calls[0][0])
    expect(url).toContain('term=tron')

    mockFetch.mockClear()
    await s.arrFetch(s.lookupPath, {}, new URLSearchParams({ term: 'star wars' }))
    const url2 = new URL(String(mockFetch.mock.calls[0][0]))
    // URLSearchParams encodes the space (as + or %20); decoded value round-trips.
    expect(url2.searchParams.get('term')).toBe('star wars')
    expect(url2.search).not.toContain('star wars')
  })

  it('preserves caller-supplied init.headers AND still injects X-Api-Key, keeps method', async () => {
    await s.arrFetch(s.postPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    const init = mockFetch.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['X-Api-Key']).toBe(s.apiKey())
    expect(init.method).toBe('POST')
  })

  it('forwards the upstream status/body unchanged on a 200', async () => {
    mockFetch.mockResolvedValueOnce(new Response('[]', { status: 200 }))
    const r = await s.arrFetch('/api/v3/rootfolder')
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('[]')
  })

  it('honors a custom timeout override — aborts at timeoutMs, not the 15s LAN default', async () => {
    // Interactive search (GET /release) passes SEARCH_TIMEOUT_MS so a 20–60s
    // indexer query is not killed at 15s. Prove the 4th arg drives the abort
    // timer: a 50ms override aborts a hanging fetch → synthesized 504. If the
    // param were dropped (back to the 15s default) this advance would not fire
    // and the test would hang.
    vi.useFakeTimers()
    try {
      mockFetch.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            )
          }),
      )
      const p = s.arrFetch('/api/v3/release', { method: 'GET' }, undefined, 50)
      await vi.advanceTimersByTimeAsync(60)
      const r = await p
      expect(r.status).toBe(504)
      expect(((await r.json()) as { error?: string }).error).toBe('upstream_timeout')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe.each(services)('$name rootFolders', (s) => {
  it('returns the parsed JSON array on 200', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify([{ id: 1, path: s.folderPath }]), { status: 200 }),
    )
    const folders = await s.rootFolders()
    expect(folders).toEqual([{ id: 1, path: s.folderPath }])
  })

  it('throws `<service> rootfolder <status>` on a non-ok status', async () => {
    mockFetch.mockResolvedValueOnce(new Response('', { status: 503 }))
    await expect(s.rootFolders()).rejects.toThrow(new RegExp(`${s.name} rootfolder 503`))
  })

  it('throws <service> rootfolder 504 when the NAS is unreachable (fetch throws)', async () => {
    // fetchWithTimeout turns a network throw into a synthesized 504 Response,
    // so an unreachable NAS surfaces as an error here — never a silent [].
    mockFetch.mockImplementationOnce(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(s.rootFolders()).rejects.toThrow(new RegExp(`${s.name} rootfolder 504`))
  })
})
