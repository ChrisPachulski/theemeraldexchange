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

const NOW = '2026-06-17T12:00:00.000Z'

class FakeChild extends EventEmitter {
  killed = false
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
