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

  it('starts ffmpeg with copy codec + hls sliding-window flags', () => {
    const s = startRemuxSession({ streamId: '10', sub: 'plex:test', upstreamUrl: 'https://x/y.ts' })

    expect(spawnMock).toHaveBeenCalledWith('ffmpeg', expect.any(Array), expect.objectContaining({ cwd: s.dir }))
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('-c')
    expect(args).toContain('copy')
    expect(args).toContain('-f')
    expect(args).toContain('hls')
    expect(args).toContain('-hls_time')
    expect(args).toContain('4')
    expect(args).toContain('-hls_list_size')
    expect(args).toContain('8')
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
