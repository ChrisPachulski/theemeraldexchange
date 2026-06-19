import { describe, it, expect, vi } from 'vitest'

// Keep the unit hermetic: stub the token signer (real one calls a native crate)
// and the process-lifecycle module the map imports, plus env.
vi.mock('./iptvStreamToken.js', () => ({
  signStreamToken: (_secret: string, opts: { resourceId: string }) =>
    `TOK(${opts.resourceId})`,
}))
vi.mock('./iptvRemux.js', () => ({
  listRemuxSessions: () => [],
  startRemuxSession: () => ({ sessionId: 's', dir: '/tmp/s', manifestPath: '/tmp/s/index.m3u8' }),
  stopRemuxSession: () => {},
}))
vi.mock('../env.js', () => ({
  env: { streamTokenSecret: 'sec', IPTV_STREAM_TOKEN_TTL_SECS: 300 },
}))

import { rewriteRemuxManifest } from './iptvLiveRemuxMap.js'

describe('rewriteRemuxManifest', () => {
  // Cold-start manifest ffmpeg writes at MEDIA-SEQUENCE:0 — note the
  // discontinuity BEFORE the first segment, which stalls AVPlayer forever.
  const cold = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:3',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:2.069000,',
    'seg_00000.ts',
    '#EXTINF:2.502000,',
    'seg_00001.ts',
    '',
  ].join('\n')

  it('drops the discontinuity that precedes the first segment', () => {
    const out = rewriteRemuxManifest(cold, '42', 'sess', 'subA')
    expect(out).not.toContain('#EXT-X-DISCONTINUITY')
    // segments still rewritten to tokenised proxy URLs
    expect(out).toContain('/api/iptv/stream/live/42/remux/seg?t=TOK(sess%2Fseg_00000.ts)')
    expect(out).toContain('/api/iptv/stream/live/42/remux/seg?t=TOK(sess%2Fseg_00001.ts)')
    // headers preserved
    expect(out).toContain('#EXT-X-MEDIA-SEQUENCE:0')
  })

  it('keeps a genuine mid-stream discontinuity (between two segments)', () => {
    const mid = [
      '#EXTM3U',
      '#EXT-X-MEDIA-SEQUENCE:10',
      '#EXTINF:2.0,',
      'seg_00010.ts',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:2.0,',
      'seg_00011.ts',
      '',
    ].join('\n')
    const out = rewriteRemuxManifest(mid, '42', 'sess', 'subA')
    expect(out).toContain('#EXT-X-DISCONTINUITY')
  })
})
