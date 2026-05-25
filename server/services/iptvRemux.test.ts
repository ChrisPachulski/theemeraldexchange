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
  },
}))

import {
  startRemuxSession,
  heartbeatRemuxSession,
  stopRemuxSession,
  listRemuxSessions,
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
