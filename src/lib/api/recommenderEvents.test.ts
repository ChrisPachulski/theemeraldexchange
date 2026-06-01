import { describe, it, expect, vi, beforeEach } from 'vitest'
import { postClickEvent } from './recommenderEvents'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  globalThis.fetch = fetchMock as typeof fetch
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } })
})

describe('postClickEvent', () => {
  it('POSTs a clicked signal for a movie and returns void synchronously', () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))

    const ret = postClickEvent('movie', 603)

    expect(ret).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/recommender/event')
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(init.body).toBe(JSON.stringify({ kind: 'movie', tmdbId: 603, signal: 'clicked' }))
  })

  it('sends kind=tv for a tv click', () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))

    postClickEvent('tv', 1396)

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.kind).toBe('tv')
  })

  it('swallows network errors without throwing or producing an unhandled rejection', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))

    expect(() => postClickEvent('movie', 603)).not.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Flush the rejected-promise microtask. The internal .catch(() => {})
    // must absorb it; an unhandled rejection here would fail the run.
    await Promise.resolve()
    await Promise.resolve()
  })
})
