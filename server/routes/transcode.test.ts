import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../env.js', () => ({
  env: {
    transcoderUrl: 'http://transcoder.test',
    internalPrincipalSecret: 'test-secret',
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

type FetchInitWithHeaders = { headers: Record<string, string> }

vi.mock('../services/recommenderCaller.js', () => ({
  recommenderCallerFromSession: vi.fn(() => ({ kind: 'user', id: 'u1' })),
}))

import { transcode, appendTokenToManifest } from './transcode.js'
import { fetchStreamWithConnectTimeout } from '../services/upstream.js'
import { mintInternalPrincipal } from '../services/internalPrincipal.js'
import { recommenderCallerFromSession } from '../services/recommenderCaller.js'

const mockFetch = vi.mocked(fetchStreamWithConnectTimeout)
const mockMint = vi.mocked(mintInternalPrincipal)
const mockCaller = vi.mocked(recommenderCallerFromSession)

describe('transcode proxy route', () => {
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
})
