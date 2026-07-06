import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'

const spawnMock = vi.hoisted(() => vi.fn())
const remuxTmpDir = vi.hoisted(() => `/tmp/iptv-remux-vitest-${process.pid}`)

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}))

vi.mock('../env.js', () => ({
  env: {
    IPTV_REMUX_TMP_DIR: remuxTmpDir,
    XTREAM_USERNAME: 'testuser',
    XTREAM_PASSWORD: 'secret123',
    // High by default so existing tests never trip the cap; the cap test lowers
    // it temporarily.
    IPTV_MAX_UPSTREAM_CONNECTIONS: 10,
    IPTV_REENCODE_PRESET: 'veryfast',
    IPTV_REENCODE_THREADS: 2,
    IPTV_REENCODE_MAX_HEIGHT: 1080,
  },
}))

import {
  startRemuxSession,
  heartbeatRemuxSession,
  stopRemuxSession,
  listRemuxSessions,
  drainRemuxSessions,
  scrubXtreamCreds,
  channelNeedsReencode,
  channelIsDeadFeed,
  _clearDeadFeedMemoryForTests,
} from './iptvRemux.js'
import { env } from '../env.js'

type FakeProcess = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
  pid: number
}

function fakeProcess(): FakeProcess {
  const proc = new EventEmitter() as FakeProcess
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()
  proc.pid = 12345
  return proc
}

describe('iptv remux session', () => {
  beforeEach(() => {
    for (const s of listRemuxSessions()) stopRemuxSession(s.sessionId)
    fs.rmSync(remuxTmpDir, { recursive: true, force: true })
    _clearDeadFeedMemoryForTests()
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => fakeProcess())
  })

  afterEach(() => {
    for (const s of listRemuxSessions()) stopRemuxSession(s.sessionId)
    fs.rmSync(remuxTmpDir, { recursive: true, force: true })
  })

  it('copies video, re-encodes audio to AAC-LC, + hls sliding-window flags', () => {
    const s = startRemuxSession({ streamId: '10', sub: 'plex:test', upstreamUrl: 'https://x/y.ts' })

    expect(spawnMock).toHaveBeenCalledWith('ffmpeg', expect.any(Array), expect.objectContaining({ cwd: s.dir }))
    const args = spawnMock.mock.calls[0][1] as string[]
    // Video copied losslessly; audio re-encoded HE-AAC(SBR) -> AAC-LC stereo so
    // AVPlayer doesn't play it a hair behind the video (SBR decoder delay).
    // Larger probe ceiling so late-declaring HEVC channels resolve their codec
    // parameters before the HLS muxer needs them (H.264 unaffected — it's a cap).
    expect(args).toContain('-probesize')
    expect(args).toContain('-analyzeduration')
    expect(args).toContain('10M')
    expect(args).toContain('-c:v')
    expect(args).toContain('copy')
    expect(args).toContain('-c:a')
    expect(args).toContain('aac')
    expect(args).toContain('-ac')
    expect(args).toContain('2')
    expect(args).toContain('-f')
    expect(args).toContain('hls')
    expect(args).toContain('-hls_time')
    // 2s segments (matches VOD): halves Apple TV live startup/buffering latency.
    expect(args).toContain('2')
    expect(args).toContain('-hls_list_size')
    // ~80s window: deep enough for the client to sit ~15s back and tolerate the
    // irregular-keyframe segment sizes this provider emits without underrunning.
    expect(args).toContain('40')
    // Broken-timestamp hardening: drop the provider's bogus input DTS and rebase
    // the output to a clean monotonic timeline so segments stitch without flushes.
    expect(args).toContain('+discardcorrupt+genpts+igndts')
    expect(args).toContain('-avoid_negative_ts')
    expect(args).toContain('make_zero')
    expect(args).toContain('-hls_flags')
    expect(args).toContain('delete_segments+append_list+omit_endlist')
    expect(args).toContain('-hls_segment_filename')
    expect(args).toContain('seg_%05d.ts')
    expect(s.sessionId).toMatch(/^remux:10:/)
    expect(s.manifestPath).toMatch(/index\.m3u8$/)
  })

  it('default video path copies; reencodeVideo uses libx264 + governance flags', () => {
    const a = startRemuxSession({ streamId: '50', sub: 'plex:test', upstreamUrl: 'https://x/y.ts' })
    const copyArgs = spawnMock.mock.calls[0][1] as string[]
    expect(copyArgs).toContain('copy')
    expect(copyArgs).not.toContain('libx264')
    stopRemuxSession(a.sessionId)

    startRemuxSession({ streamId: '51', sub: 'plex:test', upstreamUrl: 'https://x/z.ts', reencodeVideo: true })
    const reArgs = spawnMock.mock.calls[1][1] as string[]
    expect(reArgs).toContain('libx264')
    expect(reArgs).toContain('-preset')
    expect(reArgs).toContain('veryfast')
    expect(reArgs).toContain('-threads')
    // Video is encoded, not copied (audio AAC re-encode is separate).
    expect(reArgs).not.toContain('copy')
  })

  it('a copy session whose INPUT video is non-H.264 marks the channel + kills ffmpeg', () => {
    const proc = fakeProcess()
    spawnMock.mockReturnValueOnce(proc)
    startRemuxSession({ streamId: '60', sub: 'plex:test', upstreamUrl: 'https://x/y.ts' })

    expect(channelNeedsReencode('60')).toBe(false)
    proc.stderr.emit(
      'data',
      Buffer.from('  Stream #0:0[0x100]: Video: hevc (Main), yuv420p(tv), 1920x1080\n'),
    )
    expect(channelNeedsReencode('60')).toBe(true)
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('a copy session whose INPUT video IS H.264 leaves the channel on the copy path', () => {
    const proc = fakeProcess()
    spawnMock.mockReturnValueOnce(proc)
    startRemuxSession({ streamId: '61', sub: 'plex:test', upstreamUrl: 'https://x/y.ts' })

    proc.stderr.emit(
      'data',
      Buffer.from('  Stream #0:0[0x100]: Video: h264 (High), yuv420p, 1920x1080\n'),
    )
    expect(channelNeedsReencode('61')).toBe(false)
    expect(proc.kill).not.toHaveBeenCalled()
  })

  it('heartbeat extends lifetime; stop removes the entry', () => {
    const s = startRemuxSession({ streamId: '10', sub: 'plex:test', upstreamUrl: 'https://x/y.ts' })
    const before = listRemuxSessions().find((x) => x.sessionId === s.sessionId)
    expect(before).toBeTruthy()

    heartbeatRemuxSession(s.sessionId)
    const after = listRemuxSessions().find((x) => x.sessionId === s.sessionId)
    expect(after?.lastSeen).toBeGreaterThanOrEqual(before!.lastSeen)

    stopRemuxSession(s.sessionId)
    expect(listRemuxSessions().some((x) => x.sessionId === s.sessionId)).toBe(false)
  })

  it('removes the entry when ffmpeg exits', () => {
    const proc = fakeProcess()
    spawnMock.mockReturnValueOnce(proc)
    const s = startRemuxSession({ streamId: '11', sub: 'plex:test', upstreamUrl: 'https://x/z.ts' })

    proc.emit('exit', 0, null)

    expect(listRemuxSessions().some((x) => x.sessionId === s.sessionId)).toBe(false)
  })

  // ── dead-feed detection (S1 item 7) ───────────────────────────────────────
  it('tags a clean fast EOF (code 0 under 60s) as a dead feed', () => {
    const proc = fakeProcess()
    spawnMock.mockReturnValueOnce(proc)
    startRemuxSession({ streamId: '70', sub: 'plex:test', upstreamUrl: 'https://x/y.ts' })
    expect(channelIsDeadFeed('70')).toBe(false)

    // ffmpeg copies the ~30s dead-channel stub then EOFs cleanly, almost at once.
    proc.emit('exit', 0, null)

    expect(channelIsDeadFeed('70')).toBe(true)
  })

  it('does NOT tag a non-zero exit (corrupt feed / 255) as a dead feed', () => {
    const proc = fakeProcess()
    spawnMock.mockReturnValueOnce(proc)
    startRemuxSession({ streamId: '71', sub: 'plex:test', upstreamUrl: 'https://x/y.ts' })

    proc.emit('exit', 255, null)

    expect(channelIsDeadFeed('71')).toBe(false)
  })

  it('does NOT tag our own SIGKILL/SIGTERM teardown as a dead feed', () => {
    const proc = fakeProcess()
    spawnMock.mockReturnValueOnce(proc)
    startRemuxSession({ streamId: '72', sub: 'plex:test', upstreamUrl: 'https://x/y.ts' })

    proc.emit('exit', null, 'SIGKILL')

    expect(channelIsDeadFeed('72')).toBe(false)
  })

  it('does NOT tag a code-0 exit AFTER a long healthy run as a dead feed', () => {
    const proc = fakeProcess()
    spawnMock.mockReturnValueOnce(proc)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    try {
      startRemuxSession({ streamId: '73', sub: 'plex:test', upstreamUrl: 'https://x/y.ts' })
      // Ran ~2 min: a clean EOF here is a normal end of a real feed, not a stub.
      nowSpy.mockReturnValue(1_000_000 + 120_000)
      proc.emit('exit', 0, null)
    } finally {
      nowSpy.mockRestore()
    }
    expect(channelIsDeadFeed('73')).toBe(false)
  })

  it('drainRemuxSessions SIGTERMs every active session and clears the registry (finding 14-2)', async () => {
    const procs: FakeProcess[] = []
    spawnMock.mockImplementation(() => {
      const p = fakeProcess()
      procs.push(p)
      return p
    })
    startRemuxSession({ streamId: '20', sub: 'plex:a', upstreamUrl: 'https://x/a.ts' })
    startRemuxSession({ streamId: '21', sub: 'plex:b', upstreamUrl: 'https://x/b.ts' })
    expect(listRemuxSessions()).toHaveLength(2)

    // stopRemuxSession (called by drain) deletes the Map entry synchronously and
    // SIGTERMs the child, so drain resolves promptly and the registry is empty.
    await drainRemuxSessions(2_000)

    for (const p of procs) expect(p.kill).toHaveBeenCalledWith('SIGTERM')
    expect(listRemuxSessions()).toHaveLength(0)
  })

  it('caps simultaneous upstream connections, evicting the least-recently-seen', () => {
    const prev = env.IPTV_MAX_UPSTREAM_CONNECTIONS
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(env as { IPTV_MAX_UPSTREAM_CONNECTIONS: number }).IPTV_MAX_UPSTREAM_CONNECTIONS = 2
    try {
      const a = startRemuxSession({ streamId: '40', sub: 'plex:a', upstreamUrl: 'https://x/a.ts' })
      const b = startRemuxSession({ streamId: '41', sub: 'plex:b', upstreamUrl: 'https://x/b.ts' })
      heartbeatRemuxSession(b.sessionId) // keep b fresher than a so a is the LRU
      // Third tune is at the cap → the oldest (a) is evicted, never exceeding 2.
      const c = startRemuxSession({ streamId: '42', sub: 'plex:c', upstreamUrl: 'https://x/c.ts' })
      const ids = listRemuxSessions().map((s) => s.sessionId)
      expect(ids).toHaveLength(2)
      expect(ids).not.toContain(a.sessionId)
      expect(ids).toContain(b.sessionId)
      expect(ids).toContain(c.sessionId)
    } finally {
      ;(env as { IPTV_MAX_UPSTREAM_CONNECTIONS: number }).IPTV_MAX_UPSTREAM_CONNECTIONS = prev
      warn.mockRestore()
    }
  })

  it('drainRemuxSessions is a no-op with no active sessions', async () => {
    // Ensure the registry is empty first (beforeEach already stops any leftovers).
    for (const s of listRemuxSessions()) stopRemuxSession(s.sessionId)
    await expect(drainRemuxSessions(100)).resolves.toBeUndefined()
  })

  it('scrubs credentials out of ffmpeg stderr before logging it', () => {
    const proc = fakeProcess()
    spawnMock.mockReturnValueOnce(proc)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    startRemuxSession({ streamId: '30', sub: 'plex:test', upstreamUrl: 'https://x/y.ts' })

    proc.stderr.emit('data', Buffer.from('https://h/live/testuser/secret123/30.ts: 404'))
    proc.stderr.emit('data', Buffer.from('   ')) // whitespace-only → trimmed away, not logged

    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(warn).toHaveBeenCalledTimes(1) // the blank line is dropped by the `if (line)` guard
    expect(logged).not.toContain('secret123')
    expect(logged).toContain('REDACTED')
    warn.mockRestore()
  })

  it('removes the session and cleans up when ffmpeg emits an error', () => {
    const proc = fakeProcess()
    spawnMock.mockReturnValueOnce(proc)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = startRemuxSession({ streamId: '31', sub: 'plex:test', upstreamUrl: 'https://x/y.ts' })

    proc.emit('error', new Error('spawn ffmpeg ENOENT'))

    expect(listRemuxSessions().some((x) => x.sessionId === s.sessionId)).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('rejects a non-http(s) upstream before spawning ffmpeg', () => {
    expect(() =>
      startRemuxSession({ streamId: '32', sub: 'p', upstreamUrl: 'file:///etc/passwd' }),
    ).toThrow(/protocol not allowed/)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects a malformed upstream URL before spawning ffmpeg', () => {
    expect(() =>
      startRemuxSession({ streamId: '33', sub: 'p', upstreamUrl: 'not a url' }),
    ).toThrow(/not a valid URL/)
    expect(spawnMock).not.toHaveBeenCalled()
  })
})

describe('scrubXtreamCreds', () => {
  it('redacts the literal password from a path-style ffmpeg error URL', () => {
    const line = 'https://iptv.example.com/live/testuser/secret123/1234.ts: Connection refused'
    const scrubbed = scrubXtreamCreds(line)
    expect(scrubbed).not.toContain('secret123')
    expect(scrubbed).not.toContain('testuser')
    expect(scrubbed).toContain('REDACTED')
    expect(scrubbed).toContain('iptv.example.com')
    expect(scrubbed).toContain('1234.ts')
    expect(scrubbed).toContain('Connection refused')
  })

  it('redacts query-style username/password parameters', () => {
    const line = 'GET https://iptv.example.com/player_api.php?username=testuser&password=secret123&action=get_live_streams failed'
    const scrubbed = scrubXtreamCreds(line)
    expect(scrubbed).not.toContain('secret123')
    expect(scrubbed).not.toContain('testuser')
    expect(scrubbed).toContain('username=REDACTED')
    expect(scrubbed).toContain('password=REDACTED')
    expect(scrubbed).toContain('action=get_live_streams')
  })

  it('leaves lines with no credentials unchanged', () => {
    const line = '[rtsp @ 0x7f] Retrying with TCP'
    expect(scrubXtreamCreds(line)).toBe(line)
  })

  it('handles generic path-style URL even when env credentials do not match', () => {
    const line = 'https://other.host.com/live/someuser/somepass/99.ts: Timeout'
    const scrubbed = scrubXtreamCreds(line)
    expect(scrubbed).toContain('/REDACTED/REDACTED/')
    expect(scrubbed).not.toContain('someuser')
    expect(scrubbed).not.toContain('somepass')
  })
})
