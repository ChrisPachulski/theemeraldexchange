// Direct unit coverage for the SAB service wrapper. Unlike Sonarr/Radarr, SAB
// takes its apikey as a QUERY param, not a header — this file holds the only
// copy of SAB_API_KEY in the process. The key-leak guard test asserts the
// apikey is in the query and NOT in any fetch header.
//
// sabCall returns the fetchWithTimeout-wrapped Response directly (it does NOT
// throw on failure), so the unreachable case is asserted as a 504 Response.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from '../env.js'
import { sabCall } from './sab.js'

let mockFetch: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('console', { ...console, error: vi.fn() })
  mockFetch = vi.fn(async () => new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', mockFetch)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sabCall', () => {
  it('hits env.sabUrl + /api', async () => {
    await sabCall('queue')
    const url = new URL(String(mockFetch.mock.calls[0][0]))
    expect(url.pathname.endsWith('/api')).toBe(true)
    expect(`${url.origin}${url.pathname}`).toBe(`${env.sabUrl}/api`)
  })

  it('sets mode, output=json, apikey as QUERY params — never a header (key-leak guard)', async () => {
    await sabCall('queue')
    const call = mockFetch.mock.calls[0]
    const url = new URL(String(call[0]))
    expect(url.searchParams.get('mode')).toBe('queue')
    expect(url.searchParams.get('output')).toBe('json')
    expect(url.searchParams.get('apikey')).toBe(env.sabApiKey)

    // The apikey must NOT leak into any request header. sabCall passes {} as
    // init, so there are no headers at all — and certainly no apikey.
    const init = (call[1] ?? {}) as RequestInit
    const headers = (init.headers ?? {}) as Record<string, string>
    expect(Object.keys(headers)).toHaveLength(0)
    const headerBlob = JSON.stringify(headers)
    expect(headerBlob).not.toContain(env.sabApiKey)
  })

  it('splices extra entries into the query and percent-encodes spaces', async () => {
    await sabCall('addurl', { name: 'foo', nzbname: 'bar baz' })
    const url = new URL(String(mockFetch.mock.calls[0][0]))
    expect(url.searchParams.get('name')).toBe('foo')
    expect(url.searchParams.get('nzbname')).toBe('bar baz')
    // The raw query must not contain the literal space — URLSearchParams encodes it.
    expect(url.search).not.toContain('bar baz')
  })

  it('keeps the reserved params present when extra omits them', async () => {
    await sabCall('history', { start: '0', limit: '50' })
    const url = new URL(String(mockFetch.mock.calls[0][0]))
    expect(url.searchParams.get('mode')).toBe('history')
    expect(url.searchParams.get('output')).toBe('json')
    expect(url.searchParams.get('apikey')).toBe(env.sabApiKey)
    expect(url.searchParams.get('start')).toBe('0')
    expect(url.searchParams.get('limit')).toBe('50')
  })

  it('forwards a 200 JSON body unchanged', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{"status":true}', { status: 200 }))
    const r = await sabCall('queue')
    expect(r.status).toBe(200)
    const body = (await r.json()) as { status: boolean }
    expect(body.status).toBe(true)
  })

  it('returns a synthesized 504 (not a throw) when fetch throws', async () => {
    // sabCall returns the fetchWithTimeout Response — an unreachable NAS
    // surfaces as a 504 with { service: 'sab' }, not a rejected promise.
    mockFetch.mockImplementationOnce(async () => {
      throw new TypeError('fetch failed')
    })
    const r = await sabCall('queue')
    expect(r.status).toBe(504)
    const body = (await r.json()) as { service: string }
    expect(body.service).toBe('sab')
  })
})
