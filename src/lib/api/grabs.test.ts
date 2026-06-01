import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ApiError } from './errors'
import { grabs, type GrabEvent } from './grabs'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  globalThis.fetch = fetchMock as typeof fetch
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } })
})

function jsonRes(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

describe('grabs.recent', () => {
  it('hits /api/grabs/recent with default limit=20 and credentials', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes([]))

    const res = await grabs.recent()

    const calledUrl = new URL(String(fetchMock.mock.calls[0][0]))
    expect(calledUrl.pathname).toBe('/api/grabs/recent')
    expect(calledUrl.searchParams.get('limit')).toBe('20')
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ credentials: 'include' }),
    )
    expect(res).toEqual([])
  })

  it('passes an explicit limit through to the query', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes([]))

    await grabs.recent(5)

    const calledUrl = new URL(String(fetchMock.mock.calls[0][0]))
    expect(calledUrl.searchParams.get('limit')).toBe('5')
  })

  it('returns the parsed GrabEvent[] verbatim', async () => {
    const events: GrabEvent[] = [
      { type: 'grab_succeeded', app: 'radarr', itemId: 603, ts: '2026-06-01T00:00:00Z' },
    ]
    fetchMock.mockResolvedValueOnce(jsonRes(events))

    const res = await grabs.recent()
    expect(res).toEqual(events)
  })

  it('routes a non-ok response through throwApiError', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({ error: 'forbidden', reason: 'admin_only' }, { status: 403 }),
    )

    await expect(grabs.recent()).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      code: 'forbidden',
    } satisfies Partial<ApiError>)
  })
})

describe('grabs.byItem', () => {
  it('hits /api/grabs/by-item with app, itemId and limit params', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes([]))

    await grabs.byItem('sonarr', 42, 10)

    const calledUrl = new URL(String(fetchMock.mock.calls[0][0]))
    expect(calledUrl.pathname).toBe('/api/grabs/by-item')
    expect(calledUrl.searchParams.get('app')).toBe('sonarr')
    expect(calledUrl.searchParams.get('itemId')).toBe('42')
    expect(calledUrl.searchParams.get('limit')).toBe('10')
  })
})
