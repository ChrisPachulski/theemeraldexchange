import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { openIptvDb, type IptvDb } from './iptvDb.js'
import { buildRecordArgs, tick, type Recorder } from './dvrRecorder.js'
import { scheduleRecording, markStatus, getRecording, type DvrRecording } from './dvrRecordings.js'

const NOW = '2026-06-17T12:00:00.000Z'

describe('buildRecordArgs', () => {
  it('copies the live stream to mpegts bounded by a floored -t', () => {
    const args = buildRecordArgs('https://x/live/u/p/42.ts', '/rec/r.ts', 1800.7)
    expect(args[args.indexOf('-i') + 1]).toBe('https://x/live/u/p/42.ts')
    expect(args[args.indexOf('-c') + 1]).toBe('copy')
    expect(args[args.indexOf('-f') + 1]).toBe('mpegts')
    expect(args[args.indexOf('-t') + 1]).toBe('1800') // floored
    expect(args[args.length - 1]).toBe('/rec/r.ts')
  })
  it('floors a tiny/zero duration up to at least 1s', () => {
    expect(buildRecordArgs('u', 'f', 0)[buildRecordArgs('u', 'f', 0).indexOf('-t') + 1]).toBe('1')
  })
  it('does not whitelist file:/pipe: protocols (SSRF containment)', () => {
    const args = buildRecordArgs('https://x/42.ts', '/f.ts', 60)
    const wl = args[args.indexOf('-protocol_whitelist') + 1]
    expect(wl).not.toContain('file')
    expect(wl).not.toContain('pipe')
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
    scheduleRecording(db.raw, { channel_stream_id: 1, channel_name: 'c', title: 't', start_utc: start, stop_utc: stop }, NOW)

  it('starts due, stops finished, marks missed; sets file_path on start', () => {
    const a = sched('2026-06-17T11:00:00.000Z', '2026-06-17T13:00:00.000Z') // open → start
    const b = sched('2026-06-17T10:00:00.000Z', '2026-06-17T11:30:00.000Z') // closed
    markStatus(db.raw, b.id, 'recording', {}, NOW) // now a recording row
    const c = sched('2026-06-17T09:00:00.000Z', '2026-06-17T10:00:00.000Z') // elapsed scheduled → missed

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
    rec.markRunning(a.id) // already running
    tick(db.raw, rec, NOW)
    expect(rec.started).toEqual([]) // a recording row isn't in toStart anyway
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
