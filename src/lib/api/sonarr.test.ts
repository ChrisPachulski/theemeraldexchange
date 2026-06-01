import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ApiError } from './errors'
import { sonarr } from './sonarr'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  globalThis.fetch = fetchMock as typeof fetch
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } })
})

afterEach(() => {
  vi.useRealTimers()
})

function jsonRes(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

describe('sonarr post() timeout/abort branch', () => {
  it('maps an AbortError to the friendly 60s-timeout message and preserves cause', async () => {
    vi.useFakeTimers()
    // fetch hangs until its signal aborts, then rejects like the real runtime.
    fetchMock.mockImplementation((_url, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        )
      }),
    )

    // Do NOT await before advancing timers — start the call, then trip the timer.
    const p = sonarr.addSeries({})
    // Attach a no-op catch immediately so the rejection is observed and does not
    // surface as an unhandled rejection while we advance fake time.
    const settled = p.catch((e) => e)

    await vi.advanceTimersByTimeAsync(60_000)

    await expect(p).rejects.toThrow(/timed out after 60s/)
    await expect(p).rejects.toThrow(/Sonarr/)

    const err = (await settled) as Error
    expect(err.cause).toBeInstanceOf(DOMException)
  })

  it('rethrows a non-AbortError from fetch unchanged (not wrapped in timeout message)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'))

    await expect(sonarr.addSeries({})).rejects.toThrow('network down')
    await expect(sonarr.addSeries({})).rejects.not.toThrow(/timed out/)
  })

  it('clears the timer on success so a late timer cannot produce a false timeout', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 1 }))

    const res = await sonarr.addSeries({})
    expect(res).toMatchObject({ id: 1 })

    // The finally{} clearTimeout ran; advancing past the timeout is a no-op
    // and must not reject or corrupt the already-resolved value.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(res).toMatchObject({ id: 1 })
  })
})

describe('sonarr post() request wiring', () => {
  it('POSTs with method/headers/credentials and an AbortSignal', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 1 }))

    await sonarr.addSeries({})

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/sonarr/api/v3/series'),
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    )

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('throws a typed ApiError on a non-ok response (and clears the timer on the throw path)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({ error: 'forbidden', reason: 'admin_only' }, { status: 403 }),
    )

    await expect(sonarr.addSeries({})).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      code: 'forbidden',
    } satisfies Partial<ApiError>)
  })
})

describe('sonarr get() helper', () => {
  it('qualityProfiles() hits /api/sonarr/api/v3/qualityprofile with credentials', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes([]))

    await sonarr.qualityProfiles()

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/sonarr/api/v3/qualityprofile'),
      expect.objectContaining({ credentials: 'include' }),
    )
  })
})
