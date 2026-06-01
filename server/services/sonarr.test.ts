// Direct unit coverage for the Sonarr service wrapper. Structurally identical
// to the radarr suite — this file holds the ONLY copy of the Sonarr X-Api-Key
// in the process, and the route tests never assert the wrapper's own contract.
//
// Each call routes through fetchWithTimeout, which re-wraps the upstream
// Response into a fresh Response — so we assert on the RETURNED Response and
// read the actual URL/headers off the vi.fn mock's call args.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from '../env.js'
import { sonarrFetch, sonarrRootFolders } from './sonarr.js'

let mockFetch: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('console', { ...console, error: vi.fn() })
  mockFetch = vi.fn(async () => new Response('[]', { status: 200 }))
  vi.stubGlobal('fetch', mockFetch)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sonarrFetch', () => {
  it('injects X-Api-Key and Accept: application/json', async () => {
    await sonarrFetch('/api/v3/rootfolder')
    const init = mockFetch.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['X-Api-Key']).toBe(env.sonarrApiKey)
    expect(headers.Accept).toBe('application/json')
  })

  it('builds the URL as env.sonarrUrl + path', async () => {
    await sonarrFetch('/api/v3/rootfolder')
    expect(String(mockFetch.mock.calls[0][0])).toBe(`${env.sonarrUrl}/api/v3/rootfolder`)
  })

  it('merges a query URLSearchParams into the URL and percent-encodes special chars', async () => {
    await sonarrFetch('/api/v3/series/lookup', {}, new URLSearchParams({ term: 'tron' }))
    const url = String(mockFetch.mock.calls[0][0])
    expect(url).toContain('term=tron')

    mockFetch.mockClear()
    await sonarrFetch('/api/v3/series/lookup', {}, new URLSearchParams({ term: 'star wars' }))
    const url2 = new URL(String(mockFetch.mock.calls[0][0]))
    expect(url2.searchParams.get('term')).toBe('star wars')
    expect(url2.search).not.toContain('star wars')
  })

  it('preserves caller-supplied init.headers AND still injects X-Api-Key, keeps method', async () => {
    await sonarrFetch('/api/v3/series', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    const init = mockFetch.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['X-Api-Key']).toBe(env.sonarrApiKey)
    expect(init.method).toBe('POST')
  })

  it('forwards the upstream status/body unchanged on a 200', async () => {
    mockFetch.mockResolvedValueOnce(new Response('[]', { status: 200 }))
    const r = await sonarrFetch('/api/v3/rootfolder')
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('[]')
  })
})

describe('sonarrRootFolders', () => {
  it('returns the parsed JSON array on 200', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify([{ id: 1, path: '/tv' }]), { status: 200 }),
    )
    const folders = await sonarrRootFolders()
    expect(folders).toEqual([{ id: 1, path: '/tv' }])
  })

  it('throws `sonarr rootfolder <status>` on a non-ok status', async () => {
    mockFetch.mockResolvedValueOnce(new Response('', { status: 503 }))
    await expect(sonarrRootFolders()).rejects.toThrow(/sonarr rootfolder 503/)
  })

  it('throws sonarr rootfolder 504 when the NAS is unreachable (fetch throws)', async () => {
    // fetchWithTimeout turns a network throw into a synthesized 504 Response,
    // so an unreachable NAS surfaces as an error here — never a silent [].
    mockFetch.mockImplementationOnce(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(sonarrRootFolders()).rejects.toThrow(/sonarr rootfolder 504/)
  })
})
