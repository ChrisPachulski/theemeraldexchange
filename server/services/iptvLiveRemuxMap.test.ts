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
  const state = {
    active: [] as Array<{ sessionId: string }>,
    starts: 0,
    // The streamId each startRemuxSession call actually dialed (in order), so a
    // test can assert a dead-feed failover advanced to a SIBLING id.
    dialedStreamIds: [] as string[],
    // streamIds iptvRemux currently remembers as dead-channel placeholders.
    deadFeeds: new Set<string>(),
  }
  const start = vi.fn((opts?: { streamId?: string }) => {
    state.starts += 1
    const sessionId = `sess-${state.starts}`
    state.active.push({ sessionId })
    if (opts?.streamId !== undefined) state.dialedStreamIds.push(opts.streamId)
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
  channelIsDeadFeed: (streamId: string) => h.state.deadFeeds.has(streamId),
  listRemuxSessions: () => h.state.active,
  startRemuxSession: (opts: { streamId: string }) => h.start(opts),
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
  isChannelOfflineUpstream,
  _resetLiveRemuxIndexForTests,
} from './iptvLiveRemuxMap.js'

beforeEach(() => {
  h.state.active = []
  h.state.starts = 0
  h.state.dialedStreamIds = []
  h.state.deadFeeds.clear()
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

  // ── Cross-session media-sequence continuity (sibling-failover -12312) ────────
  const seqOf = (m: string) => {
    const line = m.split('\n').find((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE:'))
    return line ? Number(line.split(':')[1]) : null
  }
  const discSeqOf = (m: string) => {
    const line = m.split('\n').find((l) => l.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:'))
    return line ? Number(line.split(':')[1]) : null
  }
  const window = (mediaSeq: number, first: number, count: number) => {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:3', `#EXT-X-MEDIA-SEQUENCE:${mediaSeq}`]
    for (let i = 0; i < count; i++) {
      lines.push('#EXTINF:2.0,', `seg_${String(first + i).padStart(5, '0')}.ts`)
    }
    return lines.join('\n') + '\n'
  }

  it('steady state (same session) leaves MEDIA-SEQUENCE untouched and emits no discontinuity sequence', () => {
    const p1 = rewriteRemuxManifest(window(10, 10, 3), '42', 'sess-A', 'subZ')
    const p2 = rewriteRemuxManifest(window(11, 11, 3), '42', 'sess-A', 'subZ')
    expect(seqOf(p1)).toBe(10)
    expect(seqOf(p2)).toBe(11)
    expect(discSeqOf(p1)).toBeNull()
    expect(discSeqOf(p2)).toBeNull()
  })

  it('a session swap keeps MEDIA-SEQUENCE monotonic and bumps the discontinuity sequence (fixes -12312)', () => {
    // Session A serves a window up to sequence 14 (first 12, 3 segments).
    const a = rewriteRemuxManifest(window(12, 12, 3), '42', 'sess-A', 'subZ')
    expect(seqOf(a)).toBe(14 - 2) // first served sequence is 12
    // A dead-feed failover swaps in sibling session B, whose ffmpeg restarts at
    // MEDIA-SEQUENCE:0. Served naively this jumps BACKWARDS (12 -> 0) and stalls
    // AVPlayer with -12312. The continuity carry must instead continue ABOVE 14.
    const b = rewriteRemuxManifest(window(0, 0, 3), '42', 'sess-B', 'subZ')
    expect(seqOf(b)).not.toBeNull()
    expect(seqOf(b)!).toBeGreaterThan(14) // > the max sequence session A served
    expect(discSeqOf(b)).toBe(1) // discontinuity-sequence bumped on the swap
    // The new session's subsequent polls stay monotonic above the swap point.
    const b2 = rewriteRemuxManifest(window(1, 1, 3), '42', 'sess-B', 'subZ')
    expect(seqOf(b2)!).toBeGreaterThan(seqOf(b)!)
    expect(discSeqOf(b2)).toBe(1)
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

describe('dead-feed failover (Fox Soccer Plus incident, S1 item 7)', () => {
  // Two channels share an epg_channel_id, so they are siblings carrying the same
  // event. The route wires these as (siblingFeeds, upstreamUrlFor).
  const siblingFeeds = () => ['1', '2']
  const upstreamUrlFor = (id: string) => `http://up/${id}`
  const opts = (streamId: string) => ({
    streamId,
    sub: 'u',
    upstreamUrl: `http://up/${streamId}`,
    siblingFeeds,
    upstreamUrlFor,
  })

  it('advances to the sibling stream_id when the tuned feed EOFs as a dead placeholder', () => {
    // t=1000: tune channel '1' — dials the tuned feed first.
    const a = ensureLiveRemuxEntry(opts('1'), 1_000)
    expect(a?.sessionId).toBe('sess-1')
    expect(h.state.dialedStreamIds).toEqual(['1'])

    // '1' turns out to be a dead-channel placeholder: ffmpeg exited code 0 after
    // a few segments, so iptvRemux tagged stream '1' dead and dropped the session.
    h.state.active = []
    h.state.deadFeeds.add('1')

    // Next ensure: the dead '1' is skipped and we advance to sibling '2' —
    // NOT re-dial the dead '1'.
    const b = ensureLiveRemuxEntry(opts('1'), 1_100)
    expect(b?.sessionId).toBe('sess-2')
    expect(h.state.dialedStreamIds).toEqual(['1', '2'])
    // The entry stays keyed to the tuned channel '1' but records the dialed sibling.
    expect(b?.streamId).toBe('1')
    expect(b?.dialedStreamId).toBe('2')
  })

  it('reports the channel offline (null) once EVERY candidate feed is dead', () => {
    ensureLiveRemuxEntry(opts('1'), 1_000)
    h.state.active = []
    h.state.deadFeeds.add('1') // tuned feed dead → fail over to '2'
    const b = ensureLiveRemuxEntry(opts('1'), 1_100)
    expect(b?.dialedStreamId).toBe('2')

    h.state.active = []
    h.state.deadFeeds.add('2') // sibling also dead → nothing left to dial
    expect(ensureLiveRemuxEntry(opts('1'), 1_200)).toBeNull()
    // No third dial happened — we did not re-open a known-dead upstream.
    expect(h.state.dialedStreamIds).toEqual(['1', '2'])
    // isChannelOfflineUpstream lets the route surface a terminal offline reason.
    expect(isChannelOfflineUpstream(['1', '2'])).toBe(true)
  })

  it('a dead-feed failover is NOT throttled like a corrupt-feed fast-fail', () => {
    // A corrupt feed dying young widens the reconnect backoff (see the throttle
    // tests above), which would BLOCK an immediate re-dial. A dead-feed EOF must
    // not: failing over to a sibling is a different upstream connection, so the
    // sibling dial fires immediately at t=1_100 despite the young death.
    ensureLiveRemuxEntry(opts('1'), 1_000)
    h.state.active = []
    h.state.deadFeeds.add('1')
    const b = ensureLiveRemuxEntry(opts('1'), 1_100) // <5s later, would be throttled if fast-fail
    expect(b?.dialedStreamId).toBe('2')
  })

  it('with no failover wiring, a dead tuned feed reports offline (single-feed channel)', () => {
    // Default opts (no siblingFeeds): the only candidate is the tuned feed. Once
    // it is dead, the channel is offline — the map returns null rather than
    // re-dialing a known-dead upstream.
    ensureLiveRemuxEntry({ streamId: '9', sub: 'u', upstreamUrl: 'http://up/9' }, 1_000)
    h.state.active = []
    h.state.deadFeeds.add('9')
    expect(
      ensureLiveRemuxEntry({ streamId: '9', sub: 'u', upstreamUrl: 'http://up/9' }, 1_100),
    ).toBeNull()
  })
})

describe('isChannelOfflineUpstream', () => {
  it('true only when every candidate feed is a known dead placeholder', () => {
    h.state.deadFeeds.add('1')
    expect(isChannelOfflineUpstream(['1', '2'])).toBe(false) // '2' still live
    h.state.deadFeeds.add('2')
    expect(isChannelOfflineUpstream(['1', '2'])).toBe(true)
  })

  it('false for an empty candidate list', () => {
    expect(isChannelOfflineUpstream([])).toBe(false)
  })
})
