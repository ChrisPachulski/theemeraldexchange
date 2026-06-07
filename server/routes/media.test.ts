import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../env.js', () => ({
  env: {
    mediaCoreUrl: 'http://media-core.test',
    internalPrincipalSecret: 'test-secret',
    // Real-ish secrets so signMediaToken (canonical Rust signer) round-trips in
    // the playback-grant tests below.
    streamTokenSecret: 'media-grant-test-secret-aaaaaaaaaaaaaaaa',
    sessionSecret: 'session-fallback-secret-bbbbbbbbbbbbbbbb',
    MEDIA_STREAM_TOKEN_TTL_SECS: 21_600,
  },
}))

vi.mock('../services/internalPrincipal.js', () => ({
  mintInternalPrincipal: vi.fn(() => 'minted-token'),
}))

vi.mock('../services/upstream.js', () => ({
  fetchStreamWithConnectTimeout: vi.fn(),
  LAN_TIMEOUT_MS: 5000,
}))

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (c: { set: (k: string, v: unknown) => void }, next: () => unknown) => {
    c.set('session', { sub: 'plex:42', username: 'u1', role: 'user' })
    return next()
  },
}))

// Shape of the second arg the route passes to fetchWithTimeout: a fetch
// RequestInit whose headers we assert on. Narrow once here so the call-site
// casts stay readable.
type FetchInitWithHeaders = { headers: Record<string, string> }

vi.mock('../services/recommenderCaller.js', () => ({
  recommenderCallerFromSession: vi.fn(() => ({ kind: 'user', id: 'u1' })),
}))

import { media } from './media.js'
import { fetchStreamWithConnectTimeout } from '../services/upstream.js'
import { mintInternalPrincipal } from '../services/internalPrincipal.js'
import { recommenderCallerFromSession } from '../services/recommenderCaller.js'

const mockFetch = vi.mocked(fetchStreamWithConnectTimeout)
const mockMint = vi.mocked(mintInternalPrincipal)
const mockCaller = vi.mocked(recommenderCallerFromSession)

describe('media proxy route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMint.mockReturnValue('minted-token')
    mockCaller.mockReturnValue({
      sub: 'plex:1',
      role: 'user',
      authMode: 'plex',
      serverId: 'srv-test',
    })
  })

  it('proxies GET with minted internal-principal header', async () => {
    mockFetch.mockResolvedValue(
      new Response('body-bytes', { status: 200, headers: { 'Content-Type': 'video/mp4' } }),
    )

    const res = await media.request('/movies', {
      method: 'GET',
      headers: { host: 'localhost' },
    })

    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('http://media-core.test/api/media/movies')
    expect((init as FetchInitWithHeaders).headers['authorization']).toBe('Bearer minted-token')
  })

  it('fails closed with 502 when mint throws while a secret is configured', async () => {
    // caller present + secret configured (non-off posture) but mint throws →
    // must NOT proxy unauthenticated; must fail closed.
    mockMint.mockImplementation(() => {
      throw new Error('no secret')
    })
    mockFetch.mockResolvedValue(new Response('x', { status: 200 }))

    const res = await media.request('/movies', {
      method: 'GET',
      headers: { host: 'localhost' },
    })

    expect(res.status).toBe(502)
    // upstream must never be hit unauthenticated
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('forwards the inbound Range header to upstream and round-trips a 206 with range headers', async () => {
    mockFetch.mockResolvedValue(
      new Response('partial', {
        status: 206,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Range': 'bytes 0-1023/8096',
          'Content-Length': '1024',
          'Accept-Ranges': 'bytes',
          ETag: '"abc123"',
        },
      }),
    )

    const res = await media.request('/stream/42', {
      method: 'GET',
      headers: { host: 'localhost', range: 'bytes=0-1023' },
    })

    // inbound Range forwarded upstream
    const [, init] = mockFetch.mock.calls[0]
    expect((init as FetchInitWithHeaders).headers['range']).toBe('bytes=0-1023')

    // upstream 206 + range headers preserved on the way back
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-1023/8096')
    expect(res.headers.get('content-length')).toBe('1024')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('etag')).toBe('"abc123"')
    expect(res.headers.get('content-type')).toBe('video/mp4')
  })

  it('forwards conditional headers and round-trips a 304 Not Modified', async () => {
    mockFetch.mockResolvedValue(
      new Response(null, { status: 304, headers: { ETag: '"abc123"' } }),
    )

    const res = await media.request('/stream/42', {
      method: 'GET',
      headers: {
        host: 'localhost',
        'if-none-match': '"abc123"',
        'if-modified-since': 'Wed, 21 Oct 2025 07:28:00 GMT',
      },
    })

    const [, init] = mockFetch.mock.calls[0]
    expect((init as FetchInitWithHeaders).headers['if-none-match']).toBe('"abc123"')
    expect((init as FetchInitWithHeaders).headers['if-modified-since']).toBe('Wed, 21 Oct 2025 07:28:00 GMT')

    expect(res.status).toBe(304)
    expect(res.headers.get('etag')).toBe('"abc123"')
  })

  it('defaults content-type to application/octet-stream when upstream omits it', async () => {
    // Build an upstream response with NO content-type header. The string-body
    // Response constructor auto-injects text/plain, so strip it explicitly to
    // simulate an upstream that genuinely omits the header.
    const noCt = new Response('bytes', { status: 200 })
    noCt.headers.delete('content-type')
    mockFetch.mockResolvedValue(noCt)

    const res = await media.request('/blob', {
      method: 'GET',
      headers: { host: 'localhost' },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
  })

  it('proxies anonymously in off posture (no caller) without failing closed', async () => {
    mockCaller.mockReturnValue(null as unknown as ReturnType<typeof recommenderCallerFromSession>)
    mockFetch.mockResolvedValue(new Response('x', { status: 200 }))

    const res = await media.request('/movies', {
      method: 'GET',
      headers: { host: 'localhost' },
    })

    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledOnce()
    const [, init] = mockFetch.mock.calls[0]
    expect((init as FetchInitWithHeaders).headers['authorization']).toBeUndefined()
    expect(mockMint).not.toHaveBeenCalled()
  })

  it('forwards POST body and content-type', async () => {
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }))

    const res = await media.request('/scan', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ trigger: true }),
    })

    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledOnce()
    const [, init] = mockFetch.mock.calls[0]
    expect((init as FetchInitWithHeaders).headers['content-type']).toBe('application/json')
  })
})

describe('media playback grant', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMint.mockReturnValue('minted-token')
    mockCaller.mockReturnValue({
      sub: 'plex:42',
      role: 'user',
      authMode: 'plex',
      serverId: 'srv-test',
    })
  })

  it('rejects an unknown media kind with 400', async () => {
    const res = await media.request('/playback/bogus/7', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(400)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('direct-play → progressive grant with a tokenised stream url', async () => {
    // media-core returns directPlay:true.
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ directPlay: true, file: { duration_secs: 1200 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const res = await media.request('/playback/movie/7', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ containers: ['mp4'], video_codecs: ['h264'], hdr: false }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { delivery: string; url: string; durationSecs: number }
    expect(body.delivery).toBe('progressive')
    expect(body.url).toMatch(/^\/api\/media\/stream\/movie\/7\?t=.+/)
    expect(body.durationSecs).toBe(1200)
    // Only the capability grant was called (no transcode handoff).
    expect(mockFetch).toHaveBeenCalledOnce()
    expect(String(mockFetch.mock.calls[0][0])).toContain('/api/media/play/movie/7/grant')
  })

  it('transcode → hls grant with tokenised manifest + heartbeat urls', async () => {
    // First call: capability grant denies direct play. Second: media-core
    // /stream handoff returns a transcoder session.
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ directPlay: false, file: { duration_secs: 5400 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transcode: true,
            sessionId: 'sess-1',
            manifestUrl: '/api/transcode/session/sess-1/index.m3u8',
            heartbeatUrl: '/api/transcode/session/sess-1/heartbeat',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      // Manifest-ready probe: the grant polls the transcoder until a segment is
      // listed before returning, so the SPA's hls.js gets a 200 on first fetch.
      .mockResolvedValueOnce(
        new Response('#EXTM3U\n#EXTINF:6.0,\nseg_00000.ts\n', {
          status: 200,
          headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
        }),
      )

    const res = await media.request('/playback/episode/99', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: '{}',
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      delivery: string
      url: string
      heartbeatUrl: string
      sessionId: string
      durationSecs: number
    }
    expect(body.delivery).toBe('hls')
    expect(body.url).toMatch(/^\/api\/transcode\/session\/sess-1\/index\.m3u8\?t=.+/)
    expect(body.heartbeatUrl).toMatch(/^\/api\/transcode\/session\/sess-1\/heartbeat\?t=.+/)
    expect(body.sessionId).toBe('sess-1')
    expect(body.durationSecs).toBe(5400)
    // Second call hit the media-core /stream handoff with the caps query.
    expect(String(mockFetch.mock.calls[1][0])).toContain('/api/media/stream/episode/99?')
  })

  it('propagates a media-core 404 as 404', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 404 }))
    const res = await media.request('/playback/movie/123456', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(404)
  })
})
