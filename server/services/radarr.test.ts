// Direct unit coverage for the Radarr service wrapper. This file holds the
// ONLY copy of the Radarr X-Api-Key in the process; the route tests exercise
// it indirectly but never assert the wrapper's own contract (header inject,
// URL build, query merge, init.headers preservation, and the rootfolder
// error surface). These tests lock that contract.
//
// Each call routes through fetchWithTimeout, which re-wraps the upstream
// Response into a fresh Response — so we assert on the RETURNED Response and
// read the actual URL/headers off the vi.fn mock's call args.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from '../env.js'
import { radarrFetch, radarrRootFolders } from './radarr.js'

let mockFetch: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('console', { ...console, error: vi.fn() })
  mockFetch = vi.fn(async () => new Response('[]', { status: 200 }))
  vi.stubGlobal('fetch', mockFetch)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('radarrFetch', () => {
  it('injects X-Api-Key and Accept: application/json', async () => {
    await radarrFetch('/api/v3/rootfolder')
    const init = mockFetch.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['X-Api-Key']).toBe(env.radarrApiKey)
    expect(headers.Accept).toBe('application/json')
  })

  it('builds the URL as env.radarrUrl + path', async () => {
    await radarrFetch('/api/v3/rootfolder')
    expect(String(mockFetch.mock.calls[0][0])).toBe(`${env.radarrUrl}/api/v3/rootfolder`)
  })

  it('merges a query URLSearchParams into the URL and percent-encodes special chars', async () => {
    await radarrFetch('/api/v3/movie/lookup', {}, new URLSearchParams({ term: 'tron' }))
    const url = String(mockFetch.mock.calls[0][0])
    expect(url).toContain('term=tron')

    mockFetch.mockClear()
    await radarrFetch('/api/v3/movie/lookup', {}, new URLSearchParams({ term: 'star wars' }))
    const url2 = new URL(String(mockFetch.mock.calls[0][0]))
    // URLSearchParams encodes the space (as + or %20); decoded value round-trips.
    expect(url2.searchParams.get('term')).toBe('star wars')
    expect(url2.search).not.toContain('star wars')
  })

  it('preserves caller-supplied init.headers AND still injects X-Api-Key, keeps method', async () => {
    await radarrFetch('/api/v3/movie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    const init = mockFetch.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['X-Api-Key']).toBe(env.radarrApiKey)
    expect(init.method).toBe('POST')
  })

  it('forwards the upstream status/body unchanged on a 200', async () => {
    mockFetch.mockResolvedValueOnce(new Response('[]', { status: 200 }))
    const r = await radarrFetch('/api/v3/rootfolder')
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('[]')
  })

  it('normalizes an upstream credential 401 to a typed 502', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    )

    const r = await radarrFetch('/api/v3/movie')

    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ error: 'radarr_auth_failed' })
  })

  it('honors a custom timeout override — aborts at timeoutMs, not the 15s LAN default', async () => {
    // Interactive search (GET /release) passes SEARCH_TIMEOUT_MS so a 20–60s
    // indexer query is not killed at 15s. Prove the 4th arg drives the abort
    // timer: a 50ms override aborts a hanging fetch → synthesized 504.
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
      const p = radarrFetch('/api/v3/release', { method: 'GET' }, undefined, 50)
      await vi.advanceTimersByTimeAsync(60)
      const r = await p
      expect(r.status).toBe(504)
      expect(((await r.json()) as { error?: string }).error).toBe('upstream_timeout')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('radarrRootFolders', () => {
  it('returns the parsed JSON array on 200', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify([{ id: 1, path: '/movies' }]), { status: 200 }),
    )
    const folders = await radarrRootFolders()
    expect(folders).toEqual([{ id: 1, path: '/movies' }])
  })

  it('throws `radarr rootfolder <status>` on a non-ok status', async () => {
    mockFetch.mockResolvedValueOnce(new Response('', { status: 503 }))
    await expect(radarrRootFolders()).rejects.toThrow(/radarr rootfolder 503/)
  })

  it('throws radarr rootfolder 504 when the NAS is unreachable (fetch throws)', async () => {
    // fetchWithTimeout turns a network throw into a synthesized 504 Response,
    // so an unreachable NAS surfaces as an error here — never a silent [].
    mockFetch.mockImplementationOnce(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(radarrRootFolders()).rejects.toThrow(/radarr rootfolder 504/)
  })
})
