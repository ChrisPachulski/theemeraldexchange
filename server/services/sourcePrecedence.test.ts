import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mutable env so each case can flip creds / plex availability.
const envState = vi.hoisted(() => ({
  XTREAM_HOST: '',
  XTREAM_USERNAME: '',
  XTREAM_PASSWORD: '',
  plexServerUrl: '',
}))

// The network seam: sourcePrecedence imports fetchWithTimeout + LAN_TIMEOUT_MS
// from ./upstream.js. Mock before importing the SUT.
vi.mock('./upstream.js', () => ({
  fetchWithTimeout: vi.fn(),
  LAN_TIMEOUT_MS: 15000,
}))
vi.mock('../env.js', () => ({ env: envState }))

import { resolveSourcePrecedence } from './sourcePrecedence.js'
import { fetchWithTimeout } from './upstream.js'

const mockFetch = vi.mocked(fetchWithTimeout)

// Tiny fake Response — only `ok` is read by the resolver.
const fakeRes = (ok: boolean) => ({ ok }) as Response

// A realistic item ref reused across cases; we assert kind/id propagate verbatim.
const item = { kind: 'live', id: '123' }

// Did the IPTV (player_api.php) endpoint get probed at all?
const probedIptv = () =>
  mockFetch.mock.calls.some(([url]) => String(url).includes('player_api.php'))
// Did the Plex (/identity) endpoint get probed at all?
const probedPlex = () =>
  mockFetch.mock.calls.some(([url]) => String(url).includes('/identity'))

describe('resolveSourcePrecedence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    envState.XTREAM_HOST = 'https://panel.example.com'
    envState.XTREAM_USERNAME = 'u'
    envState.XTREAM_PASSWORD = 'p'
    envState.plexServerUrl = 'http://plex.local:32400'
  })

  it('resolves to IPTV when the panel is available (and never probes Plex)', async () => {
    mockFetch.mockImplementation(async (url: string | URL) =>
      String(url).includes('player_api.php') ? fakeRes(true) : fakeRes(false),
    )

    const result = await resolveSourcePrecedence(item)

    expect(result).toEqual({ resolved: { source: 'iptv', kind: 'live', id: '123' } })
    // Short-circuit in buildCandidates: Plex must not be probed.
    expect(probedIptv()).toBe(true)
    expect(probedPlex()).toBe(false)
  })

  it('falls through without probing IPTV when creds are absent', async () => {
    envState.XTREAM_HOST = ''
    // Plex down too, so we land on resolved:null / empty alternatives.
    mockFetch.mockImplementation(async () => fakeRes(false))

    const result = await resolveSourcePrecedence(item)

    expect(result).toEqual({ resolved: null, alternatives: [] })
    // probeIptv returns false before fetching when creds are missing.
    expect(probedIptv()).toBe(false)
  })

  it('returns Plex as an alternative when IPTV is down (5xx → ok:false) but Plex is up', async () => {
    mockFetch.mockImplementation(async (url: string | URL) =>
      String(url).includes('player_api.php') ? fakeRes(false) : fakeRes(true),
    )

    const result = await resolveSourcePrecedence(item)

    expect(result).toEqual({
      resolved: null,
      alternatives: [{ source: 'plex', displayName: 'Plex', kind: 'live', id: '123' }],
    })
  })

  it('returns empty alternatives when both IPTV and Plex are down', async () => {
    mockFetch.mockImplementation(async () => fakeRes(false))

    const result = await resolveSourcePrecedence(item)

    expect(result).toEqual({ resolved: null, alternatives: [] })
    expect(probedIptv()).toBe(true)
    expect(probedPlex()).toBe(true)
  })

  it('does not probe Plex when IPTV is down and Plex creds are absent', async () => {
    envState.plexServerUrl = ''
    mockFetch.mockImplementation(async (url: string | URL) =>
      String(url).includes('player_api.php') ? fakeRes(false) : fakeRes(true),
    )

    const result = await resolveSourcePrecedence(item)

    expect(result).toEqual({ resolved: null, alternatives: [] })
    expect(probedPlex()).toBe(false)
  })

  it('treats an IPTV probe that throws as unavailable and surfaces the Plex alternative', async () => {
    mockFetch.mockImplementation(async (url: string | URL) => {
      if (String(url).includes('player_api.php')) throw new Error('ETIMEDOUT')
      return fakeRes(true)
    })

    const result = await resolveSourcePrecedence(item)

    expect(result).toEqual({
      resolved: null,
      alternatives: [{ source: 'plex', displayName: 'Plex', kind: 'live', id: '123' }],
    })
  })

  it('treats an IPTV 4xx (expired line, ok:false) as unavailable, not resolved', async () => {
    mockFetch.mockImplementation(async (url: string | URL) =>
      String(url).includes('player_api.php') ? fakeRes(false) : fakeRes(true),
    )

    const result = await resolveSourcePrecedence(item)

    // Same fallback path as a 5xx: never resolves to IPTV.
    expect(result.resolved).toBeNull()
    expect(probedIptv()).toBe(true)
  })

  it('swallows a Plex probe that throws and yields empty alternatives', async () => {
    mockFetch.mockImplementation(async (url: string | URL) => {
      if (String(url).includes('player_api.php')) return fakeRes(false)
      throw new Error('ECONNREFUSED')
    })

    const result = await resolveSourcePrecedence(item)

    expect(result).toEqual({ resolved: null, alternatives: [] })
  })

  it('propagates kind/id verbatim into the resolved source', async () => {
    mockFetch.mockImplementation(async (url: string | URL) =>
      String(url).includes('player_api.php') ? fakeRes(true) : fakeRes(false),
    )

    const result = await resolveSourcePrecedence({ kind: 'series', id: 'ep-999' })

    expect(result).toEqual({ resolved: { source: 'iptv', kind: 'series', id: 'ep-999' } })
  })
})
