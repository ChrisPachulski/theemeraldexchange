import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

// Non-deterministic by design: the real signer embeds a random jti + current
// iat, so every call yields a DIFFERENT token even for the same resourceId.
// The mock mirrors that with a monotonic nonce — only the segUrlCache can make
// a segment's URL stable across polls (the -12312 invariant under test).
const sign = vi.hoisted(() => ({ nonce: 0 }))
vi.mock('./iptvStreamToken.js', () => ({
  signStreamToken: (_secret: string, opts: { resourceId: string }) =>
    `TOK(${opts.resourceId}#${++sign.nonce})`,
}))
vi.mock('./iptvRemux.js', () => ({
  channelNeedsReencode: () => false,
  listRemuxSessions: () => h.state.active,
  startRemuxSession: () => h.start(),
  stopRemuxSession: (sessionId: string) => h.stop(sessionId),
}))
vi.mock('../env.js', () => ({
  env: { streamTokenSecret: 'sec', IPTV_STREAM_TOKEN_TTL_SECS: 300 },
}))

import {
  ensureLiveRemuxEntry,
  dropOtherLiveRemuxSessions,
  getActiveLiveRemuxEntry,
  forgetLiveRemuxEntry,
  rewriteRemuxManifest,
  remuxManifestReady,
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
    expect(out).toContain('/api/iptv/stream/live/42/remux/seg?t=TOK(sess%2Fseg_00000.ts')
    expect(out).toContain('/api/iptv/stream/live/42/remux/seg?t=TOK(sess%2Fseg_00001.ts')
    expect(out).toContain('#EXT-X-MEDIA-SEQUENCE:0')
  })

  // RFC 8216 §6.3.4: a Media Segment's URI must not change across playlist
  // reloads, or AVPlayer rejects the live playlist with "-12312 Media Entry URL
  // not match previous playlist" and stalls forever. Each manifest poll re-signs
  // tokens (random jti + iat), so without the per-session cache a segment's URL
  // rotates every ~2s reload. The cache pins it.
  it('keeps each segment URL stable across polls via the segUrlCache', () => {
    const cache = new Map<string, string>()
    const poll1 = rewriteRemuxManifest(cold, '42', 'sess', 'subA', cache)
    const poll2 = rewriteRemuxManifest(cold, '42', 'sess', 'subA', cache)
    const urlOf = (m: string, seg: string) =>
      m.split('\n').find((l) => l.includes(`%2F${seg}`))
    expect(urlOf(poll1, 'seg_00000.ts')).toBe(urlOf(poll2, 'seg_00000.ts'))
    expect(urlOf(poll1, 'seg_00001.ts')).toBe(urlOf(poll2, 'seg_00001.ts'))
    // Sanity: WITHOUT a cache the same segment rotates (proves the mock is
    // non-deterministic and the cache is what fixes it).
    const noCacheA = rewriteRemuxManifest(cold, '42', 'sess', 'subA')
    const noCacheB = rewriteRemuxManifest(cold, '42', 'sess', 'subA')
    expect(urlOf(noCacheA, 'seg_00000.ts')).not.toBe(urlOf(noCacheB, 'seg_00000.ts'))
  })

  it('prunes cache entries for segments that have rolled off the window', () => {
    const cache = new Map<string, string>()
    rewriteRemuxManifest(
      '#EXTINF:2.0,\nseg_00000.ts\n#EXTINF:2.0,\nseg_00001.ts\n',
      '42', 'sess', 'subA', cache,
    )
    expect([...cache.keys()].sort()).toEqual(['seg_00000.ts', 'seg_00001.ts'])
    // Window slides forward: 00000 rolls off, 00002 appears.
    rewriteRemuxManifest(
      '#EXTINF:2.0,\nseg_00001.ts\n#EXTINF:2.0,\nseg_00002.ts\n',
      '42', 'sess', 'subA', cache,
    )
    expect([...cache.keys()].sort()).toEqual(['seg_00001.ts', 'seg_00002.ts'])
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

describe('remuxManifestReady', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remux-ready-'))
  const write = (name: string, body: string) => {
    const p = path.join(tmp, name)
    fs.writeFileSync(p, body)
    return p
  }

  it('false when the manifest does not exist yet', () => {
    expect(remuxManifestReady(path.join(tmp, 'nope.m3u8'), 4)).toBe(false)
  })

  it('false with fewer than minSegments, true once it reaches the starting window', () => {
    const two = '#EXTM3U\n#EXTINF:2,\nseg_00000.ts\n#EXTINF:2,\nseg_00001.ts\n'
    expect(remuxManifestReady(write('two.m3u8', two), 4)).toBe(false)
    const four = two + '#EXTINF:2,\nseg_00002.ts\n#EXTINF:2,\nseg_00003.ts\n'
    expect(remuxManifestReady(write('four.m3u8', four), 4)).toBe(true)
  })

  it('counts only real segment lines, not tags or stray text', () => {
    const m = '#EXTM3U\n#EXT-X-DISCONTINUITY\nnot-a-seg.bin\n#EXTINF:2,\nseg_00000.ts\n'
    expect(remuxManifestReady(write('mixed.m3u8', m), 1)).toBe(true)
    expect(remuxManifestReady(write('mixed.m3u8', m), 2)).toBe(false)
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
    expect(a?.sessionId).toBe('sess-1')
    expect(b?.sessionId).toBe('sess-1')
    expect(h.start).toHaveBeenCalledTimes(1)
  })

  it('throttles re-dial after a fast failure, then restarts once cooldown elapses', () => {
    // t=1000: first dial (immediate, streak 0).
    const a = ensureLiveRemuxEntry({ streamId: '1', sub: 'u', upstreamUrl: 'http://x' }, 1_000)
    expect(a?.sessionId).toBe('sess-1')
    h.state.active = [] // ffmpeg exits young (corrupt feed / abuse block)
    // t=1500: died after 500ms → fast fail → 5s backoff → re-dial REFUSED (null).
    expect(ensureLiveRemuxEntry({ streamId: '1', sub: 'u', upstreamUrl: 'http://x' }, 1_500)).toBeNull()
    expect(h.start).toHaveBeenCalledTimes(1) // no new upstream connection opened
    // t=6500: 5s after the last dial → cooldown elapsed → re-dial allowed.
    const b = ensureLiveRemuxEntry({ streamId: '1', sub: 'u', upstreamUrl: 'http://x' }, 6_500)
    expect(b?.sessionId).toBe('sess-2')
    expect(h.start).toHaveBeenCalledTimes(2)
  })

  it('re-dials immediately when a healthy long-lived session exits (no backoff)', () => {
    const a = ensureLiveRemuxEntry({ streamId: '1', sub: 'u', upstreamUrl: 'http://x' }, 1_000)
    expect(a?.sessionId).toBe('sess-1')
    h.state.active = [] // exits after a long, healthy run (e.g. idle sweep)
    // Lived 60s (≥ FAST_FAIL_MS) → streak cleared → next tune is immediate.
    const b = ensureLiveRemuxEntry({ streamId: '1', sub: 'u', upstreamUrl: 'http://x' }, 61_000)
    expect(b?.sessionId).toBe('sess-2')
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
    const e = ensureLiveRemuxEntry({ streamId: '3', sub: 'u', upstreamUrl: 'http://x' })!
    forgetLiveRemuxEntry('3', 'u', e.sessionId)
    expect(h.stop).toHaveBeenCalledWith(e.sessionId)
    expect(getActiveLiveRemuxEntry('3', 'u')).toBeNull()
  })

  it('dropOtherLiveRemuxSessions stops the same sub\'s other channels, keeps the tuned one', () => {
    const old = ensureLiveRemuxEntry({ streamId: '1', sub: 'u', upstreamUrl: 'http://x' })!
    const keep = ensureLiveRemuxEntry({ streamId: '2', sub: 'u', upstreamUrl: 'http://x' })!
    const other = ensureLiveRemuxEntry({ streamId: '1', sub: 'other', upstreamUrl: 'http://x' })!

    const stopped = dropOtherLiveRemuxSessions('u', '2')

    expect(stopped).toEqual(['1'])
    expect(h.stop).toHaveBeenCalledWith(old.sessionId)
    expect(h.stop).not.toHaveBeenCalledWith(keep.sessionId)
    expect(h.stop).not.toHaveBeenCalledWith(other.sessionId) // different sub untouched
    expect(getActiveLiveRemuxEntry('1', 'u')).toBeNull()
    expect(getActiveLiveRemuxEntry('2', 'u')?.sessionId).toBe(keep.sessionId)
    expect(getActiveLiveRemuxEntry('1', 'other')?.sessionId).toBe(other.sessionId)
  })

  it('dropOtherLiveRemuxSessions is a no-op when the sub has only the tuned channel', () => {
    ensureLiveRemuxEntry({ streamId: '5', sub: 'u', upstreamUrl: 'http://x' })
    expect(dropOtherLiveRemuxSessions('u', '5')).toEqual([])
    expect(h.stop).not.toHaveBeenCalled()
  })
})
