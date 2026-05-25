import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ApiError } from './errors'
import { iptvApi } from './iptv'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  globalThis.fetch = fetchMock as typeof fetch
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } })
})

describe('iptvApi', () => {
  it('listLive hits the right URL', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [], total: 0, limit: 50, offset: 0 }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await iptvApi.listLive({ q: 'cnn', limit: 25 })

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/iptv/live?q=cnn&limit=25'),
      expect.any(Object),
    )
  })

  it('vodDetail throws on 404 with a typed error', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }))

    await expect(iptvApi.vodDetail(20)).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      code: 'not_found',
    } satisfies Partial<ApiError>)
  })
})
