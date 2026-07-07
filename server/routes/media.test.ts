import { describe, it, expect, vi, beforeEach } from 'vitest'

const membershipState = vi.hoisted(() => ({
  status: 'allowed' as 'allowed' | 'revoked' | 'not_member',
}))

vi.mock('../env.js', () => ({
  env: {
    mediaCoreUrl: 'http://media-core.test',
    internalPrincipalSecret: 'test-secret',
    // Real-ish secrets so signMediaToken (canonical Rust signer) round-trips in
    // the playback-grant tests below.
    streamTokenSecret: 'media-grant-test-secret-aaaaaaaaaaaaaaaa',
    sessionSecret: 'session-fallback-secret-bbbbbbbbbbbbbbbb',
    MEDIA_STREAM_TOKEN_TTL_SECS: 21_600,
    // The playback grant consults the per-user policy store (rating cap);
    // point it at a nonexistent file so every caller is default-open here.
    userPoliciesPath: '/tmp/eex-media-test-user-policies.json',
  },
}))

vi.mock('../services/internalPrincipal.js', () => ({
  mintInternalPrincipal: vi.fn(() => 'minted-token'),
}))

vi.mock('../services/upstream.js', () => ({
  fetchStreamWithConnectTimeout: vi.fn(),
  fetchWithTimeout: vi.fn(),
  LAN_TIMEOUT_MS: 5000,
}))

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (c: { set: (k: string, v: unknown) => void }, next: () => unknown) => {
    c.set('session', { sub: 'plex:42', username: 'u1', role: 'user' })
    return next()
  },
}))

vi.mock('../services/membership.js', () => ({
  memberStatus: vi.fn(() => membershipState.status),
}))

// Shape of the second arg the route passes to fetchWithTimeout: a fetch
// RequestInit whose headers we assert on. Narrow once here so the call-site
// casts stay readable.
type FetchInitWithHeaders = { headers: Record<string, string> }

vi.mock('../services/recommenderCaller.js', () => ({
  recommenderCallerFromSession: vi.fn(() => ({ kind: 'user', id: 'u1' })),
}))

import { media } from './media.js'
import { fetchStreamWithConnectTimeout, fetchWithTimeout } from '../services/upstream.js'
import { mintInternalPrincipal } from '../services/internalPrincipal.js'
import { recommenderCallerFromSession } from '../services/recommenderCaller.js'

// The media route deliberately splits wrappers: control-plane JSON (grant,
// transcode handoff, readiness probe) goes through fetchWithTimeout (whole-
// transfer deadline); only the streaming proxy uses the TTFB-only wrapper.
const mockFetch = vi.mocked(fetchStreamWithConnectTimeout)
const mockFetchTimed = vi.mocked(fetchWithTimeout)
const mockMint = vi.mocked(mintInternalPrincipal)
const mockCaller = vi.mocked(recommenderCallerFromSession)

describe('media proxy route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    membershipState.status = 'allowed'
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
    // Machine-readable snake_case token (errors.ts convention).
    expect((await res.json()) as { error: string }).toEqual({ error: 'principal_mint_failed' })
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

  it('proxies GET /music/artists to media-core and round-trips the {items,total} shape', async () => {
    // S6: the music library ships as a flag-flip — media-core already serves
    // /music/artists|albums|tracks and the catch-all proxy forwards them. Lock
    // in the contract the client's musicArtists case decodes so a future proxy
    // refactor can't silently drop the Music tab: authed with the internal
    // principal, path preserved, body passed through verbatim.
    const payload = JSON.stringify({
      items: [{ id: 1, name: 'Miles Davis', album_count: 3 }],
      total: 1,
    })
    mockFetch.mockResolvedValue(
      new Response(payload, { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )

    const res = await media.request('/music/artists?limit=50', {
      method: 'GET',
      headers: { host: 'localhost' },
    })

    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0]
    // Path (and query) preserved onto the media-core music route.
    expect(url).toBe('http://media-core.test/api/media/music/artists?limit=50')
    expect((init as FetchInitWithHeaders).headers['authorization']).toBe('Bearer minted-token')
    const body = (await res.json()) as { items: { id: number; name: string }[]; total: number }
    expect(body.total).toBe(1)
    expect(body.items[0].name).toBe('Miles Davis')
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
    membershipState.status = 'allowed'
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
    expect(mockFetchTimed).not.toHaveBeenCalled()
  })

  it('direct-play → progressive grant with a tokenised stream url', async () => {
    // media-core returns directPlay:true.
    mockFetchTimed.mockResolvedValueOnce(
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
    // Only the capability grant was called (no transcode handoff) — and it
    // went through the whole-transfer wrapper, NOT the TTFB-only streaming
    // wrapper (whose cleared deadline would leave r.json() unbounded).
    expect(mockFetchTimed).toHaveBeenCalledOnce()
    expect(String(mockFetchTimed.mock.calls[0][0])).toContain('/api/media/play/movie/7/grant')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('track → progressive grant (audio is always direct play)', async () => {
    // media-core reports directPlay:true for a track regardless of caps.
    mockFetchTimed.mockResolvedValueOnce(
      new Response(JSON.stringify({ directPlay: true, file: { duration_secs: 215 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const res = await media.request('/playback/track/42', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { delivery: string; url: string; durationSecs: number }
    expect(body.delivery).toBe('progressive')
    expect(body.url).toMatch(/^\/api\/media\/stream\/track\/42\?t=.+/)
    expect(body.durationSecs).toBe(215)
    // Only the grant is called — never a transcode handoff for audio.
    expect(mockFetchTimed).toHaveBeenCalledOnce()
    expect(String(mockFetchTimed.mock.calls[0][0])).toContain('/api/media/play/track/42/grant')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('rejects a direct-play stream token after membership revocation', async () => {
    mockFetchTimed.mockResolvedValueOnce(
      new Response(JSON.stringify({ directPlay: true, file: { duration_secs: 1200 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const grant = await media.request('/playback/movie/7', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ containers: ['mp4'], video_codecs: ['h264'], hdr: false }),
    })
    const body = (await grant.json()) as { url: string }
    vi.clearAllMocks()
    membershipState.status = 'revoked'

    const res = await media.request(body.url.replace(/^\/api\/media/, ''), {
      method: 'GET',
      headers: { host: 'localhost' },
    })

    expect(res.status).toBe(401)
    expect((await res.json()) as { error: string }).toEqual({ error: 'access_revoked' })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('transcode → hls grant with tokenised manifest + heartbeat urls', async () => {
    // First call: capability grant denies direct play. Second: media-core
    // /stream handoff returns a transcoder session.
    mockFetchTimed
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
            subtitle: {
              url: '/api/transcode/session/sess-1/subtitles.vtt',
              language: 'eng',
              forced: false,
            },
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
      body: JSON.stringify({ start_secs: 95.8 }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      delivery: string
      url: string
      heartbeatUrl: string
      stopUrl: string
      sessionId: string
      durationSecs: number
      subtitle: { url: string; language: string | null; forced: boolean } | null
    }
    expect(body.delivery).toBe('hls')
    expect(body.url).toMatch(/^\/api\/transcode\/session\/sess-1\/index\.m3u8\?t=.+/)
    expect(body.heartbeatUrl).toMatch(/^\/api\/transcode\/session\/sess-1\/heartbeat\?t=.+/)
    // The sidecar .vtt is token-wrapped with the SAME session token as the
    // manifest/segments so the owner-bound asset route admits the <track> fetch.
    expect(body.subtitle?.url).toMatch(/^\/api\/transcode\/session\/sess-1\/subtitles\.vtt\?t=.+/)
    expect(body.subtitle?.language).toBe('eng')
    expect(body.subtitle?.forced).toBe(false)
    // Stop URL is derived from the manifest path (index.m3u8 -> stop) and
    // carries the same session token so the client can free the slot on close.
    expect(body.stopUrl).toMatch(/^\/api\/transcode\/session\/sess-1\/stop\?t=.+/)
    expect(body.sessionId).toBe('sess-1')
    expect(body.durationSecs).toBe(5400)
    // Second call hit the media-core /stream handoff with the caps query —
    // grant, handoff AND readiness probe all stayed on the whole-transfer
    // wrapper; the streaming wrapper was never touched.
    expect(String(mockFetchTimed.mock.calls[1][0])).toContain('/api/media/stream/episode/99?')
    expect(String(mockFetchTimed.mock.calls[1][0])).toContain('start_secs=95')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('surfaces a token-wrapped trickplayUrl when the transcoder serves an I-frame rendition', async () => {
    // S5: a re-encode session exposes iframe.m3u8; the grant probes it and, on a
    // hit, surfaces the URL wrapped with the SAME session token as the manifest.
    mockFetchTimed
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ directPlay: false, file: { duration_secs: 7200 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transcode: true,
            sessionId: 'sess-tp',
            manifestUrl: '/api/transcode/session/sess-tp/index.m3u8',
            heartbeatUrl: '/api/transcode/session/sess-tp/heartbeat',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      // Readiness probe: a segment is listed → ready.
      .mockResolvedValueOnce(
        new Response('#EXTM3U\n#EXTINF:6.0,\nseg_00000.ts\n', {
          status: 200,
          headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
        }),
      )
      // Trick-play probe: the transcoder returns the synthesized I-frame playlist.
      .mockResolvedValueOnce(
        new Response(
          '#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-I-FRAMES-ONLY\n#EXTINF:10.000000,\nthumb_00000.ts\n#EXT-X-ENDLIST\n',
          { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } },
        ),
      )

    const res = await media.request('/playback/movie/7', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ hls_fmp4_hevc: false }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { delivery: string; url: string; trickplayUrl: string | null }
    expect(body.delivery).toBe('hls')
    // Same session id + token class as the manifest, on the iframe.m3u8 sibling.
    expect(body.trickplayUrl).toMatch(/^\/api\/transcode\/session\/sess-tp\/iframe\.m3u8\?t=.+/)
    // The probe hit the transcoder's iframe route (derived from the manifest path).
    const probeUrl = String(mockFetchTimed.mock.calls[3][0])
    expect(probeUrl).toContain('/api/transcode/session/sess-tp/iframe.m3u8')
  })

  it('trickplayUrl is null when the transcoder has no I-frame rendition (copy-remux)', async () => {
    // A copy-remux / no-duration session 404s the iframe route → null, not a
    // dead URL. The grant otherwise succeeds unchanged.
    mockFetchTimed
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ directPlay: false, file: { duration_secs: 7200 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transcode: true,
            sessionId: 'sess-copy',
            manifestUrl: '/api/transcode/session/sess-copy/index.m3u8',
            heartbeatUrl: '/api/transcode/session/sess-copy/heartbeat',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response('#EXTM3U\n#EXTINF:6.0,\nseg_00000.m4s\n', {
          status: 200,
          headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
        }),
      )
      // Trick-play probe: the iframe route is not available for this session.
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'no such session or segment' }), { status: 404 }))

    const res = await media.request('/playback/movie/7', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ hls_fmp4_hevc: true }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { delivery: string; trickplayUrl: string | null }
    expect(body.delivery).toBe('hls')
    expect(body.trickplayUrl).toBeNull()
  })

  it('force_hls overrides a direct-play grant with buffered (hls) delivery', async () => {
    // Stall escalation: media-core says directPlay:true, but the client
    // demanded buffered delivery — the route must skip the progressive
    // early-return and run the stream handoff with force_transcode=true.
    mockFetchTimed
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ directPlay: true, file: { duration_secs: 5400 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transcode: true,
            sessionId: 'sess-esc',
            manifestUrl: '/api/transcode/session/sess-esc/index.m3u8',
            heartbeatUrl: '/api/transcode/session/sess-esc/heartbeat',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response('#EXTM3U\n#EXTINF:6.0,\nseg_00000.ts\n', {
          status: 200,
          headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
        }),
      )

    const res = await media.request('/playback/movie/7', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ force_hls: true, start_secs: 612 }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { delivery: string; url: string }
    expect(body.delivery).toBe('hls')
    expect(body.url).toMatch(/^\/api\/transcode\/session\/sess-esc\/index\.m3u8\?t=.+/)
    const handoffUrl = String(mockFetchTimed.mock.calls[1][0])
    expect(handoffUrl).toContain('/api/media/stream/movie/7?')
    expect(handoffUrl).toContain('force_transcode=true')
    expect(handoffUrl).toContain('start_secs=612')
  })

  it('force_hls absent → a direct-play grant stays progressive (no handoff)', async () => {
    mockFetchTimed.mockResolvedValueOnce(
      new Response(JSON.stringify({ directPlay: true, file: { duration_secs: 1200 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const res = await media.request('/playback/movie/7', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ force_hls: false }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { delivery: string }).delivery).toBe('progressive')
    expect(mockFetchTimed).toHaveBeenCalledOnce()
  })

  it('readiness poll is bounded by wall-clock, not iteration count', async () => {
    // Each probe consumes 5s (slow-but-responding transcoder, under its own
    // LAN timeout) and never reports a segment. The 12s wall-clock deadline
    // must end the loop after ~3 probes; the old 24-iteration bound would
    // have stretched this request to ~2 minutes (24 × (5s + 0.5s sleep)).
    vi.useFakeTimers()
    try {
      mockFetchTimed
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ directPlay: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              sessionId: 'sess-slow',
              manifestUrl: '/api/transcode/session/sess-slow/index.m3u8',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
        .mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve(new Response('not ready', { status: 503 })), 5_000),
            ),
        )

      const pending = media.request('/playback/movie/7', {
        method: 'POST',
        headers: { host: 'localhost', 'content-type': 'application/json' },
        body: '{}',
      })
      await vi.runAllTimersAsync()
      const res = await pending
      // The grant still returns (a not-yet-ready manifest is the client's
      // retry problem past the deadline) — the loop just must not run away.
      expect(res.status).toBe(200)
      const probeCalls = mockFetchTimed.mock.calls.length - 2
      expect(probeCalls).toBeGreaterThanOrEqual(1)
      expect(probeCalls).toBeLessThanOrEqual(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('502 media_core_unreachable when the grant body read fails', async () => {
    // fetchWithTimeout itself never throws on network errors (it synthesizes a
    // 504), so the catch covers a body/JSON failure on the buffered replay.
    mockFetchTimed.mockResolvedValueOnce(
      new Response('not-json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    const res = await media.request('/playback/movie/7', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(502)
    expect((await res.json()) as { error: string }).toEqual({ error: 'media_core_unreachable' })
  })

  it('502 transcoder_unreachable when the handoff body read fails', async () => {
    mockFetchTimed
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ directPlay: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('not-json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )
    const res = await media.request('/playback/movie/7', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(502)
    expect((await res.json()) as { error: string }).toEqual({ error: 'transcoder_unreachable' })
  })

  it('propagates a media-core 404 as 404', async () => {
    mockFetchTimed.mockResolvedValueOnce(new Response('{}', { status: 404 }))
    const res = await media.request('/playback/movie/123456', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(404)
  })

  it('forwards the native_hls cap to the stream handoff (multi-audio activation)', async () => {
    // goal-quality Tier S1 #1: the POST handler dropped native_hls from its caps
    // object, so capsQuery never emitted it and the transcoder's EXT-X-MEDIA
    // multi-audio renditions never activated for AVPlayer. The cap must reach the
    // media-core /stream handoff.
    mockFetchTimed
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
            sessionId: 'sess-na',
            manifestUrl: '/api/transcode/session/sess-na/index.m3u8',
            heartbeatUrl: '/api/transcode/session/sess-na/heartbeat',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      // Every post-handoff probe (readiness + optional I-frame) gets a ready,
      // non-iframe manifest so the grant returns promptly; we assert on the
      // handoff url (call[1]), not the probes.
      .mockResolvedValue(
        new Response('#EXTM3U\n#EXTINF:6.0,\nseg_00000.ts\n', {
          status: 200,
          headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
        }),
      )

    const res = await media.request('/playback/movie/7', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ native_hls: true, hls_fmp4_hevc: true }),
    })

    expect(res.status).toBe(200)
    const handoffUrl = String(mockFetchTimed.mock.calls[1][0])
    expect(handoffUrl).toContain('/api/media/stream/movie/7?')
    expect(handoffUrl).toContain('native_hls=true') // red before the fix (param absent)
  })

  it('omits native_hls from the handoff for a browser/MSE client that never sends it', async () => {
    // The capsQuery guard keeps native_hls off single-track MSE clients — the fix
    // must not force it on for everyone.
    mockFetchTimed
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ directPlay: false, file: { duration_secs: 100 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transcode: true,
            sessionId: 's',
            manifestUrl: '/api/transcode/session/s/index.m3u8',
            heartbeatUrl: '/api/transcode/session/s/heartbeat',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValue(
        new Response('#EXTM3U\n#EXTINF:6.0,\nseg_00000.ts\n', {
          status: 200,
          headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
        }),
      )

    const res = await media.request('/playback/movie/7', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    expect(String(mockFetchTimed.mock.calls[1][0])).not.toContain('native_hls')
  })
})
