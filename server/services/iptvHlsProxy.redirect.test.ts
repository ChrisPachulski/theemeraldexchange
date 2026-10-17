// 2026-10-16 review item 29: relative URIs in an on-demand HLS playlist were
// resolved against the URL before the provider's redirect, so a panel that
// 30x's to a CDN got its segments rewritten onto the panel host.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { env } from '../env.js'
import { fetchAndRewriteHlsPlaylist } from './iptvHlsProxy.js'
import { verifyStreamToken } from './iptvStreamToken.js'
import { __setSsrfLookupForTests } from './ssrfGuard.js'

afterEach(() => {
  vi.unstubAllGlobals()
  __setSsrfLookupForTests(null)
})

describe('fetchAndRewriteHlsPlaylist', () => {
  it('resolves relative segment URIs against the post-redirect URL', async () => {
    __setSsrfLookupForTests(async () => [{ address: '93.184.216.34' }])
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('https://panel.example/')) {
        return new Response(null, { status: 302, headers: { location: 'http://cdn.example/hls/abc/index.m3u8' } })
      }
      const res = new Response('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg_1.ts\n#EXT-X-ENDLIST\n')
      Object.defineProperty(res, 'url', { value: url })
      return res
    }))

    const res = await fetchAndRewriteHlsPlaylist({
      upstreamUrl: 'https://panel.example/movie/u/p/42.m3u8',
      sub: 'plex:1',
      clientSignal: new AbortController().signal,
    })
    const line = (await res.text()).split('\n').find((l) => l.startsWith('/api/iptv/stream/segment'))!
    const token = new URL(line, 'http://x').searchParams.get('u')!
    expect(verifyStreamToken(env.streamTokenSecret, token).rid).toBe('http://cdn.example/hls/abc/seg_1.ts')
  })
})
