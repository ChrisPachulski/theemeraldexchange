import { describe, it, expect, vi, beforeEach } from 'vitest'

const membershipState = vi.hoisted(() => ({
  status: 'allowed' as 'allowed' | 'revoked' | 'not_member',
}))

vi.mock('../env.js', () => ({
  env: {
    transcoderUrl: 'http://transcoder.test',
    internalPrincipalSecret: 'test-secret',
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
    c.set('session', { userId: 'u1', role: 'user' })
    return next()
  },
}))

vi.mock('../services/membership.js', () => ({
  memberStatus: vi.fn(() => membershipState.status),
}))

type FetchInitWithHeaders = { headers: Record<string, string> }

vi.mock('../services/recommenderCaller.js', () => ({
  recommenderCallerFromSession: vi.fn(() => ({ kind: 'user', id: 'u1' })),
}))

import { transcode, appendTokenToManifest } from './transcode.js'
import { fetchStreamWithConnectTimeout } from '../services/upstream.js'
import { mintInternalPrincipal } from '../services/internalPrincipal.js'
import { recommenderCallerFromSession } from '../services/recommenderCaller.js'
import { signMediaToken, mediaSessionResourceId, MEDIA_HLS_KIND } from '../services/mediaStreamToken.js'

const mockFetch = vi.mocked(fetchStreamWithConnectTimeout)
const mockMint = vi.mocked(mintInternalPrincipal)
const mockCaller = vi.mocked(recommenderCallerFromSession)

describe('transcode proxy route', () => {
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

  it('proxies the HLS manifest with a minted internal-principal header', async () => {
    mockFetch.mockResolvedValue(
      new Response('#EXTM3U', {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
      }),
    )

    const res = await transcode.request('/session/abc/index.m3u8', {
      method: 'GET',
      headers: { host: 'localhost' },
    })

    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('http://transcoder.test/api/transcode/session/abc/index.m3u8')
    expect((init as FetchInitWithHeaders).headers['authorization']).toBe('Bearer minted-token')
    expect(res.headers.get('content-type')).toBe('application/vnd.apple.mpegurl')
  })

  it('sends the rewritten manifest fixed-length with edge no-buffer headers', async () => {
    const token = signMediaToken({
      kind: MEDIA_HLS_KIND,
      rid: mediaSessionResourceId('abc'),
      sub: 'plex:42',
    })
    // Multibyte title: content-length must be the BYTE length, not the string length.
    const manifest = '#EXTM3U\n#EXTINF:4.000000,Ωmega\nseg_00000.m4s\n'
    mockFetch.mockResolvedValue(
      new Response(manifest, {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
      }),
    )

    const res = await transcode.request(`/session/abc/index.m3u8?t=${token}`, {
      method: 'GET',
      headers: { host: 'localhost' },
    })

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain(`seg_00000.m4s?t=${token}`)
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(body)))
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-accel-buffering')).toBe('no')
  })

  it('rejects an HLS stream token after membership revocation', async () => {
    const token = signMediaToken({
      kind: MEDIA_HLS_KIND,
      rid: mediaSessionResourceId('abc'),
      sub: 'plex:42',
    })
    membershipState.status = 'revoked'

    const res = await transcode.request(`/session/abc/index.m3u8?t=${token}`, {
      method: 'GET',
      headers: { host: 'localhost' },
    })

    expect(res.status).toBe(401)
    expect((await res.json()) as { error: string }).toEqual({ error: 'access_revoked' })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('fails closed with 502 when mint throws while a secret is configured', async () => {
    mockMint.mockImplementation(() => {
      throw new Error('no secret')
    })
    mockFetch.mockResolvedValue(new Response('x', { status: 200 }))

    const res = await transcode.request('/session/abc/index.m3u8', {
      method: 'GET',
      headers: { host: 'localhost' },
    })

    expect(res.status).toBe(502)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('forwards Range on a .ts segment and round-trips a 206 with range headers', async () => {
    mockFetch.mockResolvedValue(
      new Response('partial', {
        status: 206,
        headers: {
          'Content-Type': 'video/mp2t',
          'Content-Range': 'bytes 0-1023/8096',
          'Content-Length': '1024',
          'Accept-Ranges': 'bytes',
        },
      }),
    )

    const res = await transcode.request('/session/abc/seg_00003.ts', {
      method: 'GET',
      headers: { host: 'localhost', range: 'bytes=0-1023' },
    })

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('http://transcoder.test/api/transcode/session/abc/seg_00003.ts')
    expect((init as FetchInitWithHeaders).headers['range']).toBe('bytes=0-1023')

    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-1023/8096')
    expect(res.headers.get('content-length')).toBe('1024')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-type')).toBe('video/mp2t')
  })

  it('forwards a POST heartbeat (with body + content-type)', async () => {
    mockFetch.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))

    const res = await transcode.request('/session/abc/heartbeat', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('http://transcoder.test/api/transcode/session/abc/heartbeat')
    expect((init as FetchInitWithHeaders).headers['content-type']).toBe('application/json')
  })

  it('forwards the internal principal (sub + role) on the GET /sessions list path', async () => {
    // /sessions is a NON-/session/ subpath: it has no per-session stream token
    // so it authenticates via requireAuth (cookie/bearer). The proxy must still
    // mint and attach the caller's principal — the transcoder filters the
    // session list for non-admins based on it.
    mockFetch.mockResolvedValue(
      new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )

    const res = await transcode.request('/sessions', {
      method: 'GET',
      headers: { host: 'localhost' },
    })

    expect(res.status).toBe(200)
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('http://transcoder.test/api/transcode/sessions')
    expect((init as FetchInitWithHeaders).headers['authorization']).toBe('Bearer minted-token')
    expect(mockMint).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'plex:1', role: 'user' }),
    )
  })

  it('proxies anonymously in off posture (no caller) without failing closed', async () => {
    mockCaller.mockReturnValue(null as unknown as ReturnType<typeof recommenderCallerFromSession>)
    mockFetch.mockResolvedValue(new Response('x', { status: 200 }))

    const res = await transcode.request('/session/abc/index.m3u8', {
      method: 'GET',
      headers: { host: 'localhost' },
    })

    expect(res.status).toBe(200)
    const [, init] = mockFetch.mock.calls[0]
    expect((init as FetchInitWithHeaders).headers['authorization']).toBeUndefined()
    expect(mockMint).not.toHaveBeenCalled()
  })
})

describe('appendTokenToManifest', () => {
  it('appends ?t= to relative segment lines and leaves tags/blanks untouched', () => {
    const manifest = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:6',
      '#EXTINF:6.0,',
      'seg_00000.ts',
      '#EXTINF:6.0,',
      'seg_00001.ts',
      '',
    ].join('\n')

    const out = appendTokenToManifest(manifest, 'TOK')
    const lines = out.split('\n')
    expect(lines[0]).toBe('#EXTM3U')
    expect(lines[4]).toBe('seg_00000.ts?t=TOK')
    expect(lines[6]).toBe('seg_00001.ts?t=TOK')
    expect(lines[7]).toBe('') // trailing blank preserved
    // No tag line was mangled.
    expect(out).toContain('#EXT-X-TARGETDURATION:6')
  })

  it('uses & when a segment line already has a query string', () => {
    const out = appendTokenToManifest('seg_0.ts?foo=1', 'TOK')
    expect(out).toBe('seg_0.ts?foo=1&t=TOK')
  })

  it('leaves absolute URLs untouched', () => {
    const out = appendTokenToManifest('https://cdn.example/seg_0.ts', 'TOK')
    expect(out).toBe('https://cdn.example/seg_0.ts')
  })

  it('tokenizes the EXT-X-MAP init segment URI (fMP4 sessions)', () => {
    // fMP4 (HEVC copy) playlists reference an init segment via #EXT-X-MAP;
    // the player fetches it like any other asset, so an untokenized URI 401s
    // and the whole session grey-boxes.
    const manifest = [
      '#EXTM3U',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:4.0,',
      'seg_00000.m4s',
      '',
    ].join('\n')
    const out = appendTokenToManifest(manifest, 'TOK')
    const lines = out.split('\n')
    expect(lines[1]).toBe('#EXT-X-MAP:URI="init.mp4?t=TOK"')
    expect(lines[3]).toBe('seg_00000.m4s?t=TOK')
    // Other tags stay untouched.
    expect(lines[0]).toBe('#EXTM3U')
    // An absolute init URI is left alone (mirrors the segment-line rule).
    const abs = appendTokenToManifest('#EXT-X-MAP:URI="https://cdn.example/init.mp4"', 'TOK')
    expect(abs).toBe('#EXT-X-MAP:URI="https://cdn.example/init.mp4"')
  })
})
