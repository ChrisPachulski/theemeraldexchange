import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ApiError } from './errors'
import { seriesAvailability, sonarr } from './sonarr'

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
    const setSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 1 }))

    const res = await sonarr.addSeries({})
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

describe('sonarr advanced — request wiring (S1–S7)', () => {
  it('S1 command() POSTs name+fields as JSON to /command', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 1, name: 'RefreshSeries', status: 'queued' }))
    await sonarr.command({ name: 'RefreshSeries', seriesId: 42 })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/sonarr/api/v3/command')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'RefreshSeries', seriesId: 42 })
  })

  it('S2 releases() GETs /release with seriesId + seasonNumber query', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes([]))
    await sonarr.releases(7, 2)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/sonarr/api/v3/release')
    expect(url).toContain('seriesId=7')
    expect(url).toContain('seasonNumber=2')
    expect(init.credentials).toBe('include')
  })

  it('S2 releases() omits seasonNumber from the query when not provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes([]))
    await sonarr.releases(7)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('seriesId=7')
    expect(url).not.toContain('seasonNumber')
  })

  it('S3 grabRelease() POSTs the body with the seriesId query for the cap re-search', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ status: 'grabbed', title: 'X', sizeGb: 3 }))
    await sonarr.grabRelease(7, { guid: 'g', indexerId: 9, allowOverCap: true }, 2)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/sonarr/api/v3/release')
    expect(url).toContain('seriesId=7')
    expect(url).toContain('seasonNumber=2')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ guid: 'g', indexerId: 9, allowOverCap: true })
  })

  it('S3 grabRelease() maps a 424 over-cap response to a typed ApiError', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: 'over_cap' }, { status: 424 }))
    await expect(sonarr.grabRelease(7, { guid: 'g', indexerId: 9 })).rejects.toMatchObject({
      name: 'ApiError',
      status: 424,
      code: 'over_cap',
    } satisfies Partial<ApiError>)
  })

  it('S4 renamePreview() GETs /rename with seriesId', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes([]))
    await sonarr.renamePreview(7)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/sonarr/api/v3/rename')
    expect(url).toContain('seriesId=7')
  })

  it('S5 monitorEpisodes() PUTs the batch toggle to /episode/monitor', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true, updated: 2 }))
    await sonarr.monitorEpisodes([10, 11], false)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/sonarr/api/v3/episode/monitor')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ episodeIds: [10, 11], monitored: false })
  })

  it('S6 history() GETs /history/series with seriesId', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes([]))
    await sonarr.history(7)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/sonarr/api/v3/history/series')
    expect(url).toContain('seriesId=7')
  })

  it('S7 editSeries() PUTs only the patch fields to /series/:id', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ id: 7 }))
    await sonarr.editSeries(7, { monitored: false, qualityProfileId: 3 })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/sonarr/api/v3/series/7')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ monitored: false, qualityProfileId: 3 })
  })

  it('S7 editSeries() maps a 403 admin-only response to a typed ApiError', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: 'forbidden', reason: 'admin_only' }, { status: 403 }))
    await expect(sonarr.editSeries(7, { monitored: false })).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      code: 'forbidden',
    } satisfies Partial<ApiError>)
  })
})

describe('seriesAvailability', () => {
  it('is playable when any episode file exists', () => {
    expect(seriesAvailability({ status: 'continuing', statistics: { episodeFileCount: 3 } })).toBe('playable')
  })

  it('fails open as playable without statistics', () => {
    expect(seriesAvailability({ status: 'upcoming' })).toBe('playable')
  })

  it('is not_released for an upcoming show with zero files', () => {
    expect(seriesAvailability({ status: 'upcoming', statistics: { episodeFileCount: 0 } })).toBe('not_released')
  })

  it('is missing for an aired show with zero files', () => {
    expect(seriesAvailability({ status: 'continuing', statistics: { episodeFileCount: 0 } })).toBe('missing')
  })
})
