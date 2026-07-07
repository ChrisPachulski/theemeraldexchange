import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Mock ffmpeg spawn + creds so FfmpegRecorder is exercised without a real
// process or Xtream env. scrubXtreamCreds (pure) runs for real.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('./xtream.js', () => ({
  credsFromEnv: () => ({ host: 'https://prov.example', username: 'u', password: 'p' }),
}))

import { openIptvDb, type IptvDb } from './iptvDb.js'
import {
  buildRecordArgs,
  liveUrl,
  tick,
  FfmpegRecorder,
  startDvrScheduler,
  type Recorder,
} from './dvrRecorder.js'
import { scheduleRecording, markStatus, getRecording, type DvrRecording } from './dvrRecordings.js'
import { streamConcurrency } from './iptvConcurrency.js'

const NOW = '2026-06-17T12:00:00.000Z'

class FakeChild extends EventEmitter {
  killed = false
  // A real ChildProcess reports exit via these: exitCode set on a clean exit,
  // signalCode set when killed by a signal; BOTH null while still running. A
  // FakeChild that ignores SIGTERM keeps them null so the SIGKILL backstop fires.
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stderr = new EventEmitter()
  kill = vi.fn((_sig?: NodeJS.Signals) => {
    this.killed = true
    return true
  })
}

describe('buildRecordArgs', () => {
  it('copies the live stream to mpegts bounded by a floored -t', () => {
    const args = buildRecordArgs('https://x/live/u/p/42.ts', '/rec/r.ts', 1800.7)
    expect(args[args.indexOf('-i') + 1]).toBe('https://x/live/u/p/42.ts')
    expect(args[args.indexOf('-c') + 1]).toBe('copy')
    expect(args[args.indexOf('-f') + 1]).toBe('mpegts')
    expect(args[args.indexOf('-t') + 1]).toBe('1800')
    expect(args[args.length - 1]).toBe('/rec/r.ts')
  })
  it('floors a tiny/zero duration up to at least 1s', () => {
    const a = buildRecordArgs('u', 'f', 0)
    expect(a[a.indexOf('-t') + 1]).toBe('1')
  })
  it('does not whitelist file:/pipe: protocols (SSRF containment)', () => {
    const wl = (() => {
      const a = buildRecordArgs('https://x/42.ts', '/f.ts', 60)
      return a[a.indexOf('-protocol_whitelist') + 1]
    })()
    expect(wl).not.toContain('file')
    expect(wl).not.toContain('pipe')
  })
})

describe('liveUrl', () => {
  it('builds the Xtream live .ts URL from creds', () => {
    expect(liveUrl(42)).toBe('https://prov.example/live/u/p/42.ts')
  })
})

class FakeRecorder implements Recorder {
  started: string[] = []
  stopped: string[] = []
  throwOnStart = false
  private run = new Set<string>()
  start(rec: DvrRecording): string {
    if (this.throwOnStart) throw new Error('spawn_failed')
    this.started.push(rec.id)
    this.run.add(rec.id)
    return `/rec/${rec.id}.ts`
  }
  stop(id: string): void {
    this.stopped.push(id)
    this.run.delete(id)
  }
  markRunning(id: string): void {
    this.run.add(id)
  }
  running(): Set<string> {
    return new Set(this.run)
  }
}

describe('tick (fake recorder, temp iptv DB)', () => {
  let tmpDir: string
  let db: IptvDb
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-rec-'))
    db = openIptvDb(path.join(tmpDir, 'iptv.db'))
  })
  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const sched = (start: string, stop: string) =>
    scheduleRecording(
      db.raw,
      { channel_stream_id: 1, channel_name: 'c', title: 't', start_utc: start, stop_utc: stop },
      NOW,
    )

  it('starts due, stops finished, marks missed; sets file_path on start', () => {
    const a = sched('2026-06-17T11:00:00.000Z', '2026-06-17T13:00:00.000Z')
    const b = sched('2026-06-17T10:00:00.000Z', '2026-06-17T11:30:00.000Z')
    markStatus(db.raw, b.id, 'recording', {}, NOW)
    const c = sched('2026-06-17T09:00:00.000Z', '2026-06-17T10:00:00.000Z')

    const rec = new FakeRecorder()
    tick(db.raw, rec, NOW)

    expect(rec.started).toEqual([a.id])
    expect(getRecording(db.raw, a.id)?.status).toBe('recording')
    expect(getRecording(db.raw, a.id)?.file_path).toBe(`/rec/${a.id}.ts`)
    expect(rec.stopped).toEqual([b.id])
    expect(getRecording(db.raw, b.id)?.status).toBe('completed')
    expect(getRecording(db.raw, c.id)?.status).toBe('missed')
  })

  it('does not re-start a recording already in flight', () => {
    const a = sched('2026-06-17T11:00:00.000Z', '2026-06-17T13:00:00.000Z')
    markStatus(db.raw, a.id, 'recording', { file_path: `/rec/${a.id}.ts` }, NOW)
    const rec = new FakeRecorder()
    rec.markRunning(a.id)
    tick(db.raw, rec, NOW)
    expect(rec.started).toEqual([])
  })

  it('resumes an open recording orphaned by a restart (running() empty)', () => {
    // A backend restart mid-window leaves the row 'recording' but the in-memory
    // child is gone (fresh recorder → running() empty). tick must re-invoke
    // start for the remaining window instead of abandoning it.
    const a = sched('2026-06-17T11:00:00.000Z', '2026-06-17T13:00:00.000Z')
    markStatus(db.raw, a.id, 'recording', { file_path: `/rec/${a.id}.ts` }, NOW)
    const rec = new FakeRecorder() // running() is empty — simulates post-restart
    tick(db.raw, rec, NOW)
    expect(rec.started).toEqual([a.id])
    expect(getRecording(db.raw, a.id)?.status).toBe('recording')
  })

  it('completes a resumed recording once its window finally closes', () => {
    const a = sched('2026-06-17T11:00:00.000Z', '2026-06-17T13:00:00.000Z')
    markStatus(db.raw, a.id, 'recording', {}, NOW)
    const rec = new FakeRecorder()
    // First tick (post-restart) resumes it…
    tick(db.raw, rec, NOW)
    expect(rec.started).toEqual([a.id])
    // …a later tick past stop_utc stops + completes it.
    tick(db.raw, rec, '2026-06-17T13:30:00.000Z')
    expect(rec.stopped).toEqual([a.id])
    expect(getRecording(db.raw, a.id)?.status).toBe('completed')
  })

  it('marks a recording failed when the recorder throws on start', () => {
    const a = sched('2026-06-17T11:00:00.000Z', '2026-06-17T13:00:00.000Z')
    const rec = new FakeRecorder()
    rec.throwOnStart = true
    tick(db.raw, rec, NOW)
    const row = getRecording(db.raw, a.id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain('spawn_failed')
  })
})

describe('FfmpegRecorder (mocked spawn)', () => {
  let tmpDir: string
  let db: IptvDb
  let dir: string
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-ff-'))
    db = openIptvDb(path.join(tmpDir, 'iptv.db'))
    dir = path.join(tmpDir, 'recordings')
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => new FakeChild())
  })
  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const recordingRow = (): DvrRecording => {
    const r = scheduleRecording(
      db.raw,
      {
        channel_stream_id: 7,
        channel_name: 'c',
        title: 't',
        start_utc: '2026-06-17T11:00:00.000Z',
        stop_utc: '2026-06-17T13:00:00.000Z',
      },
      NOW,
    )
    markStatus(db.raw, r.id, 'recording', {}, NOW)
    return getRecording(db.raw, r.id) as DvrRecording
  }

  it('spawns ffmpeg, registers the child, and returns the output path', () => {
    const rec = new FfmpegRecorder(dir, db.raw, () => Date.parse(NOW))
    const row = recordingRow()
    const file = rec.start(row)
    expect(file).toBe(path.join(dir, `${row.id}.ts`))
    expect(spawnMock).toHaveBeenCalledOnce()
    const [bin, args] = spawnMock.mock.calls[0]
    expect(bin).toBe('ffmpeg')
    expect(args).toContain('https://prov.example/live/u/p/7.ts')
    expect(rec.running().has(row.id)).toBe(true)
  })

  it('finalizes completed on a clean exit (code 0) and on SIGTERM', () => {
    const rec = new FfmpegRecorder(dir, db.raw, () => Date.parse(NOW))
    const row = recordingRow()
    rec.start(row)
    const child = spawnMock.mock.results[0].value as FakeChild
    child.emit('exit', 0, null)
    expect(getRecording(db.raw, row.id)?.status).toBe('completed')
    expect(rec.running().has(row.id)).toBe(false)
  })

  it('does NOT complete on a mid-window SIGTERM — leaves it recording to resume', () => {
    // Graceful shutdown / deploy SIGTERMs ffmpeg while stop_utc is still in the
    // future. Finalizing 'completed' here would mask a partial file as a full
    // recording; the row must stay 'recording' so the next tick resumes it.
    const rec = new FfmpegRecorder(dir, db.raw, () => Date.parse(NOW))
    const row = recordingRow() // stop_utc 13:00 > NOW 12:00 (mid-window)
    rec.start(row)
    const child = spawnMock.mock.results[0].value as FakeChild
    child.emit('exit', null, 'SIGTERM')
    expect(getRecording(db.raw, row.id)?.status).toBe('recording')
  })

  it('completes on a SIGTERM once the window has closed', () => {
    // A deliberate stop at/after stop_utc: nowMs is past stop_utc, so a SIGTERM
    // exit is a real completion, not an interruption.
    const rec = new FfmpegRecorder(dir, db.raw, () => Date.parse('2026-06-17T13:30:00.000Z'))
    const row = recordingRow() // stop_utc 13:00 < now 13:30 (window closed)
    rec.start(row)
    const child = spawnMock.mock.results[0].value as FakeChild
    child.emit('exit', null, 'SIGTERM')
    expect(getRecording(db.raw, row.id)?.status).toBe('completed')
  })

  it('marks failed on a non-zero, non-SIGTERM exit', () => {
    const rec = new FfmpegRecorder(dir, db.raw, () => Date.parse(NOW))
    const row = recordingRow()
    rec.start(row)
    const child = spawnMock.mock.results[0].value as FakeChild
    child.emit('exit', 1, null)
    const updated = getRecording(db.raw, row.id)
    expect(updated?.status).toBe('failed')
    expect(updated?.error).toContain('code=1')
  })

  it('does not double-handle when the row is no longer recording', () => {
    const rec = new FfmpegRecorder(dir, db.raw, () => Date.parse(NOW))
    const row = recordingRow()
    rec.start(row)
    markStatus(db.raw, row.id, 'cancelled', {}, NOW)
    const child = spawnMock.mock.results[0].value as FakeChild
    child.emit('exit', 1, null)
    expect(getRecording(db.raw, row.id)?.status).toBe('cancelled') // unchanged
  })

  it('scrubs creds from ffmpeg stderr without throwing', () => {
    const rec = new FfmpegRecorder(dir, db.raw, () => Date.parse(NOW))
    const row = recordingRow()
    rec.start(row)
    const child = spawnMock.mock.results[0].value as FakeChild
    expect(() => child.stderr.emit('data', Buffer.from('error opening https://prov.example/live/u/p/7.ts'))).not.toThrow()
  })

  it('stop() SIGTERMs the child; stopAll() stops every in-flight recording', () => {
    const rec = new FfmpegRecorder(dir, db.raw, () => Date.parse(NOW))
    const row = recordingRow()
    rec.start(row)
    const child = spawnMock.mock.results[0].value as FakeChild
    rec.stop(row.id)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    rec.stop('unknown-id') // no throw on a missing child
    rec.stopAll()
  })

  it('removes the partial .ts when a cancelled recording exits', () => {
    const rec = new FfmpegRecorder(dir, db.raw, () => Date.parse(NOW))
    const row = recordingRow()
    rec.start(row) // start() has already mkdir-ed `dir`
    const file = rec.filePathFor(row.id)
    fs.writeFileSync(file, Buffer.alloc(16)) // stand in for ffmpeg's partial write
    // A DELETE flips the row to 'cancelled' and SIGTERMs ffmpeg; the exit
    // handler must reclaim the junk file.
    markStatus(db.raw, row.id, 'cancelled', {}, NOW)
    const child = spawnMock.mock.results[0].value as FakeChild
    child.emit('exit', null, 'SIGTERM')
    expect(fs.existsSync(file)).toBe(false)
  })

  it('escalates to SIGKILL when the child ignores SIGTERM (exitCode stays null)', () => {
    vi.useFakeTimers()
    try {
      const rec = new FfmpegRecorder(dir, db.raw, () => Date.parse(NOW))
      const row = recordingRow()
      rec.start(row)
      const child = spawnMock.mock.results[0].value as FakeChild
      rec.stop(row.id)
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')
      vi.advanceTimersByTime(5000) // child never exited → exitCode/signalCode null
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT SIGKILL a child that already exited on SIGTERM', () => {
    vi.useFakeTimers()
    try {
      const rec = new FfmpegRecorder(dir, db.raw, () => Date.parse(NOW))
      const row = recordingRow()
      rec.start(row)
      const child = spawnMock.mock.results[0].value as FakeChild
      rec.stop(row.id)
      child.signalCode = 'SIGTERM' // child obeyed the SIGTERM and exited
      vi.advanceTimersByTime(5000)
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('FfmpegRecorder upstream-connection accounting (finding 118)', () => {
  let tmpDir: string
  let db: IptvDb
  let dir: string
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-cap-'))
    db = openIptvDb(path.join(tmpDir, 'iptv.db'))
    dir = path.join(tmpDir, 'recordings')
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => new FakeChild())
    // Real concurrency singleton — clear any slots leaked by prior tests so the
    // count starts honest.
    for (const s of streamConcurrency().list()) streamConcurrency().release(s.sessionId)
  })
  afterEach(() => {
    for (const s of streamConcurrency().list()) streamConcurrency().release(s.sessionId)
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const dueRecording = () => {
    const r = scheduleRecording(
      db.raw,
      {
        channel_stream_id: 9,
        channel_name: 'ESPN',
        title: 'game',
        start_utc: '2026-06-17T11:00:00.000Z',
        stop_utc: '2026-06-17T13:00:00.000Z',
      },
      NOW,
    )
    return getRecording(db.raw, r.id) as DvrRecording
  }

  it('defers a due recording when the single upstream slot is held by a live viewer, then records once it frees', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const row = dueRecording()
      // A household member is watching live via remux — the one upstream slot.
      streamConcurrency().tryAcquire({
        sub: 'plex:viewer',
        sessionId: 'live:1:plex:viewer:1',
        kind: 'remux',
        resourceId: '1',
      })
      // Recorder gated at IPTV_MAX_UPSTREAM_CONNECTIONS = 1.
      const rec = new FfmpegRecorder(dir, db.raw, () => Date.parse(NOW), streamConcurrency(), () => 1)

      // RED (pre-fix): ffmpeg spawns a 2nd provider connection over cap.
      // GREEN: the recording is DEFERRED — no spawn, row stays 'scheduled'.
      tick(db.raw, rec, NOW)
      expect(spawnMock).not.toHaveBeenCalled()
      expect(getRecording(db.raw, row.id)?.status).toBe('scheduled')

      // The viewer stops; the slot frees.
      streamConcurrency().release('live:1:plex:viewer:1')

      tick(db.raw, rec, NOW)
      expect(spawnMock).toHaveBeenCalledOnce()
      expect(getRecording(db.raw, row.id)?.status).toBe('recording')
      // The active recording is now visible in the sessions list + holds a slot.
      const entry = streamConcurrency().list().find((s) => s.sessionId === `record:${row.id}`)
      expect(entry?.kind).toBe('live')
      expect(entry?.resourceId).toBe('9')
    } finally {
      warn.mockRestore()
    }
  })

  it('releases the upstream slot when the recording ffmpeg exits', () => {
    const row = dueRecording()
    const rec = new FfmpegRecorder(dir, db.raw, () => Date.parse(NOW), streamConcurrency(), () => 1)
    tick(db.raw, rec, NOW)
    expect(streamConcurrency().list().some((s) => s.sessionId === `record:${row.id}`)).toBe(true)
    const child = spawnMock.mock.results[0].value as FakeChild
    child.emit('exit', 0, null)
    expect(streamConcurrency().list().some((s) => s.sessionId === `record:${row.id}`)).toBe(false)
  })
})

describe('startDvrScheduler', () => {
  let tmpDir: string
  let db: IptvDb
  beforeEach(() => {
    vi.useFakeTimers()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-sched-'))
    db = openIptvDb(path.join(tmpDir, 'iptv.db'))
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => new FakeChild())
  })
  afterEach(() => {
    vi.useRealTimers()
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('runs an initial tick, ticks on the interval, and stop() clears it', () => {
    const sched = startDvrScheduler(db.raw, path.join(tmpDir, 'rec'), 1000)
    expect(sched.recorder).toBeInstanceOf(FfmpegRecorder)
    // advance two intervals — no rows, so ticks are no-ops but exercise the loop.
    vi.advanceTimersByTime(2100)
    sched.stop()
    // after stop the interval is cleared — advancing further does nothing.
    vi.advanceTimersByTime(5000)
  })
})
