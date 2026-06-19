import { describe, it, expect, vi, beforeEach } from 'vitest'

// Keep the unit hermetic: stub the token signer (the real one calls a native
// crate), the env, and the process-lifecycle module the map delegates to. The
// remux mock exposes a mutable session list (via vi.hoisted, so the hoisted
// vi.mock factory can reach it) to simulate active vs. stale (ffmpeg-exited)
// sessions.
const h = vi.hoisted(() => {
  const state = { active: [] as Array<{ sessionId: string }>, starts: 0 }
  const start = vi.fn(() => {
    state.starts += 1
    const sessionId = `sess-${state.starts}`
    state.active.push({ sessionId })
    return { sessionId, dir: `/tmp/${sessionId}`, manifestPath: `/tmp/${sessionId}/index.m3u8` }
  })
  const stop = vi.fn((sessionId: string) => {
    state.active = state.active.filter((s) => s.sessionId !== sessionId)
  })
  return { state, start, stop }
})

vi.mock('./iptvStreamToken.js', () => ({
  signStreamToken: (_secret: string, opts: { resourceId: string }) => `TOK(${opts.resourceId})`,
}))
vi.mock('./iptvRemux.js', () => ({
  listRemuxSessions: () => h.state.active,
  startRemuxSession: () => h.start(),
  stopRemuxSession: (sessionId: string) => h.stop(sessionId),
}))
vi.mock('../env.js', () => ({
  env: { streamTokenSecret: 'sec', IPTV_STREAM_TOKEN_TTL_SECS: 300 },
}))

import {
  ensureLiveRemuxEntry,
  getActiveLiveRemuxEntry,
  forgetLiveRemuxEntry,
  rewriteRemuxManifest,
  remuxSegmentResource,
  _resetLiveRemuxIndexForTests,
} from './iptvLiveRemuxMap.js'

beforeEach(() => {
  h.state.active = []
  h.state.starts = 0
  h.start.mockClear()
  h.stop.mockClear()
  _resetLiveRemuxIndexForTests()
})

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
    expect(out).toContain('/api/iptv/stream/live/42/remux/seg?t=TOK(sess%2Fseg_00000.ts)')
    expect(out).toContain('/api/iptv/stream/live/42/remux/seg?t=TOK(sess%2Fseg_00001.ts)')
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

  it('passes through an unrecognised non-tag, non-segment line untouched', () => {
    const out = rewriteRemuxManifest('#EXTINF:2.0,\nseg_00000.ts\nnot-a-segment.bin\n', '7', 's', 'u')
    expect(out).toContain('not-a-segment.bin')
  })
})

describe('remuxSegmentResource', () => {
  it('parses a well-formed <sessionId>/<segFile> resource id', () => {
    expect(remuxSegmentResource('remux:42:abc:171/seg_00007.ts')).toEqual({
      sessionId: 'remux:42:abc:171',
      segFile: 'seg_00007.ts',
    })
  })

  it('rejects malformed ids (no slash, leading slash, bad seg name)', () => {
    expect(remuxSegmentResource('seg_00007.ts')).toBeNull()
    expect(remuxSegmentResource('/seg_00007.ts')).toBeNull()
    expect(remuxSegmentResource('sess/')).toBeNull()
    expect(remuxSegmentResource('sess/evil.ts')).toBeNull()
  })
})

describe('ensureLiveRemuxEntry / getActiveLiveRemuxEntry / forgetLiveRemuxEntry', () => {
  it('starts a session on first call and reuses it while active', () => {
    const a = ensureLiveRemuxEntry({ streamId: '1', sub: 'u', upstreamUrl: 'http://x' })
    const b = ensureLiveRemuxEntry({ streamId: '1', sub: 'u', upstreamUrl: 'http://x' })
    expect(a.sessionId).toBe('sess-1')
    expect(b.sessionId).toBe('sess-1')
    expect(h.start).toHaveBeenCalledTimes(1)
  })

  it('restarts when the recorded session has exited (stale entry dropped)', () => {
    const a = ensureLiveRemuxEntry({ streamId: '1', sub: 'u', upstreamUrl: 'http://x' })
    h.state.active = [] // simulate ffmpeg exit
    const b = ensureLiveRemuxEntry({ streamId: '1', sub: 'u', upstreamUrl: 'http://x' })
    expect(a.sessionId).toBe('sess-1')
    expect(b.sessionId).toBe('sess-2')
    expect(h.start).toHaveBeenCalledTimes(2)
  })

  it('getActiveLiveRemuxEntry returns null when absent and after the session exits', () => {
    expect(getActiveLiveRemuxEntry('9', 'u')).toBeNull()
    ensureLiveRemuxEntry({ streamId: '9', sub: 'u', upstreamUrl: 'http://x' })
    expect(getActiveLiveRemuxEntry('9', 'u')?.sessionId).toBe('sess-1')
    h.state.active = [] // exit
    expect(getActiveLiveRemuxEntry('9', 'u')).toBeNull()
  })

  it('forgetLiveRemuxEntry drops the index entry and stops the session', () => {
    const e = ensureLiveRemuxEntry({ streamId: '3', sub: 'u', upstreamUrl: 'http://x' })
    forgetLiveRemuxEntry('3', 'u', e.sessionId)
    expect(h.stop).toHaveBeenCalledWith(e.sessionId)
    expect(getActiveLiveRemuxEntry('3', 'u')).toBeNull()
  })
})
