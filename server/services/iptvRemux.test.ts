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
  },
}))

import {
  startRemuxSession,
  heartbeatRemuxSession,
  stopRemuxSession,
  listRemuxSessions,
  drainRemuxSessions,
  scrubXtreamCreds,
} from './iptvRemux.js'

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
    // ~48s window: a briefly-lagging player must still find its segments.
    expect(args).toContain('24')
    expect(args).toContain('-hls_flags')
    expect(args).toContain('delete_segments+append_list+omit_endlist')
    expect(args).toContain('-hls_segment_filename')
    expect(args).toContain('seg_%05d.ts')
    expect(s.sessionId).toMatch(/^remux:10:/)
    expect(s.manifestPath).toMatch(/index\.m3u8$/)
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
