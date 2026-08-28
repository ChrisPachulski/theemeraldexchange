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

  it('grantLive tunes every browser through the server remux (HLS) by default', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ url: '/api/iptv/stream/live/1/remux/index.m3u8?t=x', delivery: 'hls' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const grant = await iptvApi.grantLive('1')

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/iptv/stream/live/1/grant?client=avplayer'),
      expect.objectContaining({ method: 'POST' }),
    )
    expect(grant.delivery).toBe('hls')
  })

  it('grantLive with avplayer:false keeps the raw .ts byte path', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ url: '/api/iptv/stream/live/1.ts?t=x', delivery: 'mpegts' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await iptvApi.grantLive('1', { avplayer: false })

    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/api/iptv/stream/live/1/grant')
    expect(url).not.toContain('client=avplayer')
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
