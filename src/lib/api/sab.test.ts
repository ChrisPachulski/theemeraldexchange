import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ApiError } from './errors'
import { sab } from './sab'

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

describe('sab.queue', () => {
  it('hits /api/sab/api with mode=queue & output=json, credentials include', async () => {
    const body = { queue: { slots: [] } }
    fetchMock.mockResolvedValueOnce(jsonRes(body))

    const res = await sab.queue()

    const calledUrl = new URL(String(fetchMock.mock.calls[0][0]))
    expect(calledUrl.pathname).toBe('/api/sab/api')
    expect(calledUrl.searchParams.get('mode')).toBe('queue')
    expect(calledUrl.searchParams.get('output')).toBe('json')
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ credentials: 'include' }),
    )
    expect(res).toEqual(body)
  })

  it('rejects with a typed ApiError on a non-ok get()', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: 'unauthenticated' }, { status: 401 }))

    await expect(sab.queue()).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
    } satisfies Partial<ApiError>)
  })
})

describe('sab.history', () => {
  it('uses default limit=10 with mode=history', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ history: { slots: [] } }))

    await sab.history()

    const calledUrl = new URL(String(fetchMock.mock.calls[0][0]))
    expect(calledUrl.searchParams.get('mode')).toBe('history')
    expect(calledUrl.searchParams.get('output')).toBe('json')
    expect(calledUrl.searchParams.get('limit')).toBe('10')
  })

  it('passes an explicit limit', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ history: { slots: [] } }))

    await sab.history(25)

    const calledUrl = new URL(String(fetchMock.mock.calls[0][0]))
    expect(calledUrl.searchParams.get('limit')).toBe('25')
  })
})

describe('sab mutate operations', () => {
  it('pauseItem POSTs to a URL-encoded /pause path', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ status: true }))

    await sab.pauseItem('a/b')

    const calledUrl = String(fetchMock.mock.calls[0][0])
    expect(calledUrl).toContain('/api/sab/api/queue/a%2Fb/pause')
    expect(calledUrl).not.toContain('/api/sab/api/queue/a/b/pause')
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    )
  })

  it('resumeItem POSTs to a /resume path', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ status: true }))

    await sab.resumeItem('xyz')

    const calledUrl = String(fetchMock.mock.calls[0][0])
    expect(new URL(calledUrl).pathname.endsWith('/resume')).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('deleteItem DELETEs to the encoded queue path with no pause/resume suffix', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ status: true }))

    await sab.deleteItem('a/b')

    const calledUrl = String(fetchMock.mock.calls[0][0])
    expect(calledUrl).toContain('/api/sab/api/queue/a%2Fb')
    expect(calledUrl).not.toContain('/pause')
    expect(calledUrl).not.toContain('/resume')
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    )
  })

  it('rejects with a typed ApiError on a non-ok mutate()', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({}, { status: 502 }))

    await expect(sab.pauseItem('x')).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
    } satisfies Partial<ApiError>)
  })
})
