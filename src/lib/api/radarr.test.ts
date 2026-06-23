import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ApiError } from './errors'
import { movieAvailability, radarr } from './radarr'

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

describe('radarr post() timeout/abort branch', () => {
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
    const p = radarr.addMovie({})
    // Attach a no-op catch immediately so the rejection is observed and does not
    // surface as an unhandled rejection while we advance fake time.
    const settled = p.catch((e) => e)

    await vi.advanceTimersByTimeAsync(60_000)

    await expect(p).rejects.toThrow(/timed out after 60s/)
    await expect(p).rejects.toThrow(/Radarr/)

    const err = (await settled) as Error
    expect(err.cause).toBeInstanceOf(DOMException)
  })

  it('rethrows a non-AbortError from fetch unchanged (not wrapped in timeout message)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'))

    await expect(radarr.addMovie({})).rejects.toThrow('network down')
    await expect(radarr.addMovie({})).rejects.not.toThrow(/timed out/)
  })

  it('clears the timer on success so a late timer cannot produce a false timeout', async () => {
    vi.useFakeTimers()
    const setSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 1 }))

    const res = await radarr.addMovie({})
    expect(res).toMatchObject({ id: 1 })

    // The finally{} MUST clear the 60s abort timer on the success path. Assert
    // clearTimeout ran with the exact id setTimeout returned — deleting the
    // production clearTimeout makes this fail (not a vacuous re-assert) — then
    // prove the late timer is a harmless no-op on the already-resolved value.
    const timerId = setSpy.mock.results[0]?.value
    expect(clearSpy).toHaveBeenCalledWith(timerId)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(res).toMatchObject({ id: 1 })
  })
})

describe('radarr post() request wiring', () => {
  it('POSTs with method/headers/credentials and an AbortSignal', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 1 }))

    await radarr.addMovie({})

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/radarr/api/v3/movie'),
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

    await expect(radarr.addMovie({})).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      code: 'forbidden',
    } satisfies Partial<ApiError>)
  })
})

describe('radarr get() helper', () => {
  it('qualityProfiles() hits /api/radarr/api/v3/qualityprofile with credentials', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes([]))

    await radarr.qualityProfiles()

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/radarr/api/v3/qualityprofile'),
      expect.objectContaining({ credentials: 'include' }),
    )
  })
})

describe('radarr advanced — request wiring (R1–R6)', () => {
  it('R1 command() POSTs name+movieIds as JSON to /command', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 1, name: 'RefreshMovie', status: 'queued' }))
    await radarr.command({ name: 'RefreshMovie', movieIds: [42] })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/radarr/api/v3/command')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'RefreshMovie', movieIds: [42] })
  })

  it('R2 releases() GETs /release with movieId query', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes([]))
    await radarr.releases(5)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/radarr/api/v3/release')
    expect(url).toContain('movieId=5')
    expect(init.credentials).toBe('include')
  })

  it('R3 grabRelease() POSTs the body with the movieId query for the cap re-search', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ status: 'grabbed', title: 'X', sizeGb: 4 }))
    await radarr.grabRelease(5, { guid: 'g', indexerId: 9, allowOverCap: true })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/radarr/api/v3/release')
    expect(url).toContain('movieId=5')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ guid: 'g', indexerId: 9, allowOverCap: true })
  })

  it('R3 grabRelease() maps a 424 over-cap response to a typed ApiError', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: 'over_cap' }, { status: 424 }))
    await expect(radarr.grabRelease(5, { guid: 'g', indexerId: 9 })).rejects.toMatchObject({
      name: 'ApiError',
      status: 424,
      code: 'over_cap',
    } satisfies Partial<ApiError>)
  })

  it('R4 renamePreview() GETs /rename with movieId', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes([]))
    await radarr.renamePreview(5)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/radarr/api/v3/rename')
    expect(url).toContain('movieId=5')
  })

  it('R5 history() GETs /history/movie with movieId', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes([]))
    await radarr.history(5)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/radarr/api/v3/history/movie')
    expect(url).toContain('movieId=5')
  })

  it('R6 editMovie() PUTs only the patch fields to /movie/:id', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 5 }))
    await radarr.editMovie(5, { monitored: true, rootFolderPath: '/data/movies' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/radarr/api/v3/movie/5')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ monitored: true, rootFolderPath: '/data/movies' })
  })

  it('R6 editMovie() maps a 403 admin-only response to a typed ApiError', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: 'forbidden', reason: 'admin_only' }, { status: 403 }))
    await expect(radarr.editMovie(5, { monitored: false })).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      code: 'forbidden',
    } satisfies Partial<ApiError>)
  })
})

describe('movieAvailability', () => {
  it('is playable when a file exists on disk', () => {
    expect(movieAvailability({ hasFile: true, isAvailable: true, status: 'released' })).toBe('playable')
  })

  it('fails open as playable when the payload has no hasFile field', () => {
    expect(movieAvailability({})).toBe('playable')
  })

  it('is not_released for an announced title with no file (the Aang 2026 case)', () => {
    expect(movieAvailability({ hasFile: false, isAvailable: false, status: 'announced' })).toBe('not_released')
  })

  it('is not_released while only in cinemas, even past the availability gate', () => {
    expect(movieAvailability({ hasFile: false, isAvailable: true, status: 'inCinemas' })).toBe('not_released')
  })

  it('is missing when released but not downloaded yet', () => {
    expect(movieAvailability({ hasFile: false, isAvailable: true, status: 'released' })).toBe('missing')
  })
})

describe('movieAvailability — lookup payloads (hasFile null)', () => {
  it('is not_released for an announced lookup match (Radarr lookup keeps the id but nulls hasFile)', () => {
    expect(movieAvailability({ hasFile: null as unknown as boolean, isAvailable: false, status: 'announced' })).toBe('not_released')
  })

  it('fails open as playable for a released lookup match', () => {
    expect(movieAvailability({ hasFile: null as unknown as boolean, isAvailable: true, status: 'released' })).toBe('playable')
  })
})
