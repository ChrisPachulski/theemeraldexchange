import { describe, it, expect, vi, beforeEach } from 'vitest'
import { postClickEvent } from './recommenderEvents'
import { SESSION_EXPIRED_EVENT } from '../queryClient'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  globalThis.fetch = fetchMock as typeof fetch
  const windowTarget = new EventTarget() as EventTarget & {
    location: { origin: string }
  }
  windowTarget.location = { origin: 'http://localhost' }
  vi.stubGlobal('window', windowTarget)
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

  it('dispatches session expiry when the swallowed response is a 401', async () => {
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))

    postClickEvent('movie', 603)
    await Promise.resolve()
    await Promise.resolve()

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not dispatch session expiry for a forbidden 403', async () => {
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }))

    postClickEvent('movie', 603)
    await Promise.resolve()
    await Promise.resolve()

    expect(listener).not.toHaveBeenCalled()
  })
})
