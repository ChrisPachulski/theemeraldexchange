import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ApiError } from './errors'
import { mediaApi, browserCaps, probedCaps, resetProbedCapsForTest } from './media'
import { SESSION_EXPIRED_EVENT } from '../queryClient'

const fetchMock = vi.fn()
let expiryClock = 20_000

beforeEach(() => {
  expiryClock += 3_000
  vi.spyOn(Date, 'now').mockReturnValue(expiryClock)
  fetchMock.mockReset()
  globalThis.fetch = fetchMock as typeof fetch
  const windowTarget = new EventTarget() as EventTarget & {
    location: { origin: string }
  }
  windowTarget.location = { origin: 'http://localhost' }
  vi.stubGlobal('window', windowTarget)
})

function jsonRes(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

describe('mediaApi', () => {
  it('movies(q) hits /api/media/movies?q=... with credentials', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ items: [], total: 0 }))

    await mediaApi.movies('matrix')

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/media/movies?q=matrix'),
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('movies() without a query omits the q param', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ items: [], total: 0 }))

    await mediaApi.movies()

    const calledUrl = String(fetchMock.mock.calls[0][0])
    expect(calledUrl).toContain('/api/media/movies')
    expect(calledUrl).not.toContain('q=')
  })

  it('normalizes snake_case rows to camelCase', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({
        items: [
          {
            id: 7,
            tmdb_id: 603,
            imdb_id: 'tt0133093',
            title: 'The Matrix',
            year: 1999,
            added_at: '2026-01-01T00:00:00Z',
            file_id: 42,
            overview: null,
            poster_path: null,
          },
        ],
        total: 1,
      }),
    )

    const res = await mediaApi.movies('matrix')

    expect(res.total).toBe(1)
    expect(res.items[0]).toMatchObject({
      id: 7,
      tmdbId: 603,
      imdbId: 'tt0133093',
      title: 'The Matrix',
      year: 1999,
      addedAt: '2026-01-01T00:00:00Z',
      fileId: 42,
      overview: null,
      posterPath: null,
    })
  })

  it('allMovies() pages past the 200-row cap and concatenates every page', async () => {
    // media-core clamps limit to 200; a >200-title library spans multiple
    // pages. allMovies must fetch them ALL (the "Play Direct" index bug:
    // a single un-limited call only returned the first 50). Page 1 = full
    // 200 rows -> keep going; page 2 = 30 rows (< 200) -> stop.
    const row = (id: number) => ({
      id,
      tmdb_id: id + 1000,
      imdb_id: null,
      title: `M${id}`,
      year: 2000,
      added_at: '2026-01-01T00:00:00Z',
      file_id: id,
      overview: null,
      poster_path: null,
    })
    const page1 = Array.from({ length: 200 }, (_, i) => row(i))
    const page2 = Array.from({ length: 30 }, (_, i) => row(200 + i))
    fetchMock
      .mockResolvedValueOnce(jsonRes({ items: page1, total: 230 }))
      .mockResolvedValueOnce(jsonRes({ items: page2, total: 230 }))

    const all = await mediaApi.allMovies()

    expect(all).toHaveLength(230)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // First page offset 0, second page offset 200, both at limit 200.
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/limit=200/)
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/offset=0/)
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/offset=200/)
    expect(all[229]).toMatchObject({ id: 229, tmdbId: 1229 })
  })

  it('allMovies() stops after a single page when the library fits under the cap', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ items: [], total: 0 }))
    const all = await mediaApi.allMovies()
    expect(all).toHaveLength(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shows() normalizes show rows including tvdbId', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({
        items: [
          {
            id: 3,
            tmdb_id: null,
            tvdb_id: 81189,
            title: 'Breaking Bad',
            year: 2008,
            added_at: '2026-02-02T00:00:00Z',
            imdb_id: null,
            overview: null,
            poster_path: null,
          },
        ],
        total: 1,
      }),
    )

    const res = await mediaApi.shows()
    expect(res.items[0]).toMatchObject({
      id: 3,
      tmdbId: null,
      tvdbId: 81189,
      title: 'Breaking Bad',
      addedAt: '2026-02-02T00:00:00Z',
    })
  })

  it('defaults total to items.length when the response omits it', async () => {
    // The show-scoped /shows/{id}/episodes route has no `total`.
    fetchMock.mockResolvedValueOnce(
      jsonRes({
        items: [
          { id: 1, show_id: 3, season: 1, episode: 1, title: 'Pilot', air_date: null, file_id: 9 },
          { id: 2, show_id: 3, season: 1, episode: 2, title: null, air_date: null, file_id: 10 },
        ],
      }),
    )

    const res = await mediaApi.episodes(3)
    expect(res.total).toBe(2)
    expect(res.items[0]).toMatchObject({ showId: 3, season: 1, episode: 1, fileId: 9 })
  })

  it('throws a typed ApiError on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({ error: 'not_found' }, { status: 404 }),
    )

    await expect(mediaApi.movies('nope')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      code: 'not_found',
    } satisfies Partial<ApiError>)
  })

  it('scan() POSTs /api/media/scan', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ status: 'started', jobId: 'abc' }))

    const res = await mediaApi.scan()

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/media/scan'),
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    )
    expect(res).toMatchObject({ status: 'started' })
  })
})

describe('mediaApi playback + watch', () => {
  it('playback() POSTs caps and absolutizes the returned progressive url', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({
        delivery: 'progressive',
        url: '/api/media/stream/movie/7?t=TOK',
        durationSecs: 1200,
      }),
    )

    const grant = await mediaApi.playback('movie', 7)

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/media/playback/movie/7'),
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    )
    // Default caps are sent in the body.
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body).toMatchObject({ containers: ['mp4'], video_codecs: ['h264'], hdr: false })
    // Root-relative url is resolved to an absolute URL (token preserved).
    expect(grant.delivery).toBe('progressive')
    expect(grant.url).toBe('http://localhost/api/media/stream/movie/7?t=TOK')
    expect(grant.durationSecs).toBe(1200)
    expect(grant.heartbeatUrl).toBeNull()
  })

  it('playback() sends a floored start_secs when resuming', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({
        delivery: 'hls',
        url: '/api/transcode/session/sid/index.m3u8?t=TOK',
        heartbeatUrl: '/api/transcode/session/sid/heartbeat?t=TOK',
        sessionId: 'sid',
        durationSecs: 1200,
      }),
    )

    await mediaApi.playback('movie', 7, browserCaps(), 95.8)

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.start_secs).toBe(95)
  })

  it('playback() absolutizes the HLS manifest + heartbeat + stop urls', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({
        delivery: 'hls',
        url: '/api/transcode/session/sid/index.m3u8?t=TOK',
        heartbeatUrl: '/api/transcode/session/sid/heartbeat?t=TOK',
        stopUrl: '/api/transcode/session/sid/stop?t=TOK',
        sessionId: 'sid',
        durationSecs: null,
      }),
    )

    const grant = await mediaApi.playback('episode', 42)

    expect(grant.url).toBe('http://localhost/api/transcode/session/sid/index.m3u8?t=TOK')
    expect(grant.heartbeatUrl).toBe('http://localhost/api/transcode/session/sid/heartbeat?t=TOK')
    expect(grant.stopUrl).toBe('http://localhost/api/transcode/session/sid/stop?t=TOK')
    expect(grant.sessionId).toBe('sid')
  })

  it('progressive grant has no stopUrl (nothing to reap)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({ delivery: 'progressive', url: '/api/media/stream/movie/7?t=TOK', durationSecs: 1200 }),
    )
    const grant = await mediaApi.playback('movie', 7)
    expect(grant.stopUrl).toBeNull()
  })

  it('absolutizes the sidecar subtitle url and keeps its language/forced', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({
        delivery: 'hls',
        url: '/api/transcode/session/sid/index.m3u8?t=TOK',
        heartbeatUrl: '/api/transcode/session/sid/heartbeat?t=TOK',
        sessionId: 'sid',
        durationSecs: null,
        subtitle: {
          url: '/api/transcode/session/sid/subtitles.vtt?t=TOK',
          language: 'eng',
          forced: true,
        },
      }),
    )
    const grant = await mediaApi.playback('movie', 7)
    expect(grant.subtitle).toEqual({
      url: 'http://localhost/api/transcode/session/sid/subtitles.vtt?t=TOK',
      language: 'eng',
      forced: true,
    })
  })

  it('grant without a sidecar subtitle reports subtitle: null', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({
        delivery: 'hls',
        url: '/api/transcode/session/sid/index.m3u8?t=TOK',
        sessionId: 'sid',
        durationSecs: null,
      }),
    )
    const grant = await mediaApi.playback('movie', 7)
    expect(grant.subtitle).toBeNull()
  })

  it('stop() POSTs the tokenised stop url with keepalive', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }))
    await mediaApi.stop('http://localhost/api/transcode/session/sid/stop?t=TOK')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/api/transcode/session/sid/stop?t=TOK',
      expect.objectContaining({ method: 'POST', keepalive: true }),
    )
  })

  it('watch() normalizes rows and coerces completed to boolean', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({
        items: [
          {
            media_kind: 'movie',
            media_id: 7,
            position_secs: 600,
            duration_secs: 1200,
            watched_at: '2026-06-07T00:00:00Z',
            completed: 0,
          },
        ],
      }),
    )

    const rows = await mediaApi.watch()
    expect(rows[0]).toMatchObject({
      mediaKind: 'movie',
      mediaId: 7,
      positionSecs: 600,
      durationSecs: 1200,
      completed: false,
    })
  })

  it('saveWatch() POSTs floored snake_case progress', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ ok: true }))

    await mediaApi.saveWatch({ kind: 'movie', id: 7, positionSecs: 12.9, durationSecs: 1200.4 })

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/media/watch')
    expect(init.method).toBe('POST')
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({
      media_kind: 'movie',
      media_id: 7,
      position_secs: 12,
      duration_secs: 1200,
      completed: false,
    })
  })

  it('flushWatch() dispatches session expiry for a swallowed unauthenticated 401 response', async () => {
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    fetchMock.mockResolvedValueOnce(
      jsonRes({ error: 'unauthenticated' }, { status: 401 }),
    )

    mediaApi.flushWatch({
      kind: 'movie',
      id: 7,
      positionSecs: 12,
      durationSecs: 1200,
    })
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
  })

  it('flushWatch() ignores a swallowed non-session 401 response', async () => {
    const listener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, listener)
    fetchMock.mockResolvedValueOnce(
      jsonRes({ error: 'media_core_auth_failed' }, { status: 401 }),
    )

    mediaApi.flushWatch({
      kind: 'movie',
      id: 7,
      positionSecs: 12,
      durationSecs: 1200,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(listener).not.toHaveBeenCalled()
  })
})

describe('browserCaps', () => {
  it('advertises the conservative mp4/h264 web-safe profile', () => {
    const caps = browserCaps()
    expect(caps.containers).toEqual(['mp4'])
    expect(caps.video_codecs).toEqual(['h264'])
    expect(caps.hdr).toBe(false)
    expect(caps.audio_codecs).toEqual(['aac'])
    expect(caps.aac_max_channels).toBe(2)
    expect(caps.hls_fmp4_hevc).toBe(false)
    // NO screen-height gate: browsers downscale 4K natively; forcing those
    // titles through the transcoder traded a perfect picture for a re-encode.
    expect(caps.max_height).toBe(2160)
  })
})

describe('probedCaps', () => {
  afterEach(() => {
    resetProbedCapsForTest()
    vi.unstubAllGlobals()
  })

  /** Install a mediaCapabilities stub that answers per-config. */
  function stubDecoding(
    answer: (cfg: {
      type: string
      video?: { contentType: string; height: number }
      audio?: { contentType: string; channels: string }
    }) => boolean,
  ) {
    vi.stubGlobal('navigator', {
      mediaCapabilities: {
        decodingInfo: (cfg: never) =>
          Promise.resolve({ supported: answer(cfg), smooth: true, powerEfficient: true }),
      },
    })
  }

  it('falls back to the web-safe baseline without mediaCapabilities', async () => {
    vi.stubGlobal('navigator', {})
    const caps = await probedCaps()
    expect(caps).toEqual(browserCaps())
  })

  it('advertises hevc + fmp4 + hdr + surround when every probe passes', async () => {
    stubDecoding(() => true)
    const caps = await probedCaps()
    expect(caps.video_codecs).toEqual(['h264', 'hevc', 'av1'])
    expect(caps.hls_fmp4_hevc).toBe(true)
    expect(caps.hdr).toBe(true)
    expect(caps.aac_max_channels).toBe(6)
    expect(caps.audio_codecs).toEqual(['aac', 'eac3', 'ac3'])
    expect(caps.containers).toEqual(['mp4']) // never mkv
  })

  it('stays h264/stereo when hevc and 6ch probes fail (Chrome-on-no-HW shape)', async () => {
    stubDecoding((cfg) => {
      if (cfg.video?.contentType.includes('hev1') || cfg.video?.contentType.includes('hvc1'))
        return false
      if (cfg.video?.contentType.includes('av01')) return false
      if (cfg.audio && cfg.audio.contentType.includes('mp4a') && cfg.audio.channels === '6')
        return false
      if (cfg.audio && !cfg.audio.contentType.includes('mp4a')) return false
      return true
    })
    const caps = await probedCaps()
    expect(caps.video_codecs).toEqual(['h264'])
    expect(caps.hls_fmp4_hevc).toBe(false)
    expect(caps.hdr).toBe(false)
    expect(caps.aac_max_channels).toBe(2)
    expect(caps.audio_codecs).toEqual(['aac'])
  })

  it('requires BOTH file and media-source decode before advertising eac3', async () => {
    // audio_codecs drives direct play AND the transcoder's copy-into-HLS
    // decision, so one-sided support (e.g. progressive-only) must not pass.
    stubDecoding((cfg) => {
      if (cfg.audio?.contentType.includes('ec-3')) return cfg.type === 'file'
      if (cfg.audio?.contentType.includes('ac-3')) return false
      return true
    })
    const caps = await probedCaps()
    expect(caps.audio_codecs).toEqual(['aac'])
  })

  it('is cached: a second call does not re-probe', async () => {
    const spy = vi.fn(() =>
      Promise.resolve({ supported: true, smooth: true, powerEfficient: true }),
    )
    vi.stubGlobal('navigator', { mediaCapabilities: { decodingInfo: spy } })
    await probedCaps()
    const callsAfterFirst = spy.mock.calls.length
    await probedCaps()
    expect(spy.mock.calls.length).toBe(callsAfterFirst)
  })
})
