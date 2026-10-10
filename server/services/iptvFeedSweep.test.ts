import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { env } from '../env.js'
import { openIptvDb, type IptvDb } from './iptvDb.js'
import { FP_FRAME_BYTES } from './iptvFeedFingerprint.js'
import { getFeedCheck, recordFeedCheck } from './iptvFeedChecks.js'
import { _resetFeedCheckSchedulerForTests, type FeedCheckIo } from './iptvFeedVerify.js'
import { _setViewerActivityForTests } from './iptvRemux.js'
import {
  _resetFeedCheckSweepForTests,
  nextSweepChannel,
  rememberGuideScope,
  runFeedCheckSweep,
  sweepIdle,
  sweepWindowOpen,
  VIEWER_QUIET_MS,
} from './iptvFeedSweep.js'

// Inside the default sweep window (9-15 UTC).
const NOW = Date.parse('2026-10-10T10:00:00Z')

// [stream_id, num, name, guide id, category]
const CHANNELS: Array<[number, number, string, string, number]> = [
  [900, 1, 'US: CNN', 'cnn.us', 123], // the only CNN stream: nothing to compare
  [200163566, 154, 'US: Showtime', 'showtime.us', 123],
  [200163567, 204, 'US: Showtime 2', 'showtime2.us', 123],
  [5864, 5386, 'US Showtime East (S)', 'showtime.us', 999],
  [22599, 7357, 'US Showtime 2 (East) (H)', 'showtime2.us', 999],
  [777, 9000, 'HBO Zone', 'hbozone.us', 999],
  [778, 9001, 'HBO Zone HD', 'hbozone.us', 999],
]

function seed(db: IptvDb): void {
  for (const [stream_id, num, name, epg_channel_id, category_id] of CHANNELS) {
    db.stmts.upsertChannel.run({
      stream_id, num, name, stream_icon: null, epg_channel_id, category_id, is_adult: 0,
      tv_archive: 0, tv_archive_duration: null, added_ts: null, fetched_at: '2026-10-10T00:00:00Z',
    })
  }
  for (const id of ['cnn.us', 'showtime.us', 'showtime2.us', 'hbozone.us']) {
    db.stmts.upsertEpg.run({
      // Far-future stop: the sweep reads the real clock.
      channel_id: id, start_utc: '2026-10-10T04:00:00Z', stop_utc: '2099-01-01T00:00:00Z', title: id, description: null,
    })
  }
  // HBO Zone was watched recently: it goes before the guide's channels.
  db.raw.prepare(`INSERT INTO iptv_watch_history (sub, kind, item_id, position_secs, watched_at)
    VALUES ('u', 'live', '777', 0, '2026-10-09T20:00:00Z')`).run()
}

/** Every stream shows one broadcast, so every comparison matches. */
const BROADCAST = Uint8Array.from({ length: 125 * FP_FRAME_BYTES }, (_, i) => {
  const scene = Math.floor(i / (12 * FP_FRAME_BYTES))
  return ((i % FP_FRAME_BYTES) * 37 + scene * 101) % 251
})

function fakeProc(): ChildProcess {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>
  const stdout = new EventEmitter()
  proc.stdout = stdout
  proc.stderr = Object.assign(new EventEmitter(), { resume: () => undefined })
  proc.kill = vi.fn()
  setImmediate(() => {
    stdout.emit('data', Buffer.from(BROADCAST))
    proc.emit('close', 0, null)
  })
  return proc as unknown as ChildProcess
}

function fakeIo(db: IptvDb, captured: number[]): FeedCheckIo {
  return {
    db: db.raw,
    upstreamUrlFor: (id) => `http://up/${id}.ts`,
    userAgent: 'UA',
    spawnUpstream: (args) => {
      captured.push(Number(/\/(\d+)\.ts$/.exec(args[args.indexOf('-i') + 1])![1]))
      return fakeProc()
    },
    spawnLocal: () => fakeProc(),
    isDead: () => false,
    sleep: async () => undefined,
    now: () => Date.now(),
  }
}

describe('feed check sweep', () => {
  let db: IptvDb
  let enabled: boolean

  beforeEach(() => {
    db = openIptvDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'feedsweep-')), 'iptv.db'))
    seed(db)
    enabled = env.IPTV_FEED_CHECK
    ;(env as { IPTV_FEED_CHECK: boolean }).IPTV_FEED_CHECK = true
    _resetFeedCheckSweepForTests()
    _resetFeedCheckSchedulerForTests()
    _setViewerActivityForTests(0)
  })

  afterEach(() => {
    ;(env as { IPTV_FEED_CHECK: boolean }).IPTV_FEED_CHECK = enabled
  })

  it('remembers the guide the app shows, writing only on change', () => {
    rememberGuideScope(db.raw, [123, 2], 500)
    const first = db.stmts.getSyncState.get('feed_check_guide_scope') as { value: string; ts: string }
    expect(JSON.parse(first.value)).toEqual({ categoryIds: [2, 123], limit: 500 })
    db.raw.prepare("UPDATE iptv_sync_state SET ts = 'unchanged' WHERE key = 'feed_check_guide_scope'").run()
    rememberGuideScope(db.raw, [2, 123], 500)
    expect((db.stmts.getSyncState.get('feed_check_guide_scope') as { ts: string }).ts).toBe('unchanged')
  })

  it('goes watched channels first, then the guide in order, skipping the uncheckable and the fresh', () => {
    rememberGuideScope(db.raw, [123], 500)
    expect(nextSweepChannel(db.raw, NOW)).toBe(777)
    recordFeedCheck(db.raw, {
      stream_id: 777, verdict: 'match', listed_epg_id: 'hbozone.us', actual_epg_id: null, matched_stream_id: 778, score: 1,
    }, new Date(NOW))
    // CNN (channel 1) has no second stream to compare, so Showtime is next.
    expect(nextSweepChannel(db.raw, NOW)).toBe(200163566)
  })

  it('checks due channels back to back while idle, confirming matched streams on the way', async () => {
    rememberGuideScope(db.raw, [123], 500)
    const captured: number[] = []
    const ran = await runFeedCheckSweep(db.raw, { io: fakeIo(db, captured), idle: () => true, gapMs: 0 })
    // 777 confirms 778 too; 200163566 confirms 5864; 200163567 confirms 22599.
    expect(ran).toBe(3)
    expect(captured).toEqual([777, 778, 200163566, 5864, 200163567, 22599])
    for (const id of [777, 778, 200163566, 5864, 200163567, 22599]) {
      expect(getFeedCheck(db.raw, id)?.verdict).toBe('match')
    }
    expect(getFeedCheck(db.raw, 900)).toBeUndefined()
    expect(nextSweepChannel(db.raw)).toBeNull()
  })

  it('stops when a viewer appears and honours its check budget', async () => {
    rememberGuideScope(db.raw, [123], 500)
    // Idle for the first check (one look before it, one inside it), then a viewer.
    let calls = 0
    const ran = await runFeedCheckSweep(db.raw, { io: fakeIo(db, []), idle: () => calls++ < 2, gapMs: 0 })
    expect(ran).toBe(1)
    _resetFeedCheckSweepForTests()
    expect(await runFeedCheckSweep(db.raw, { io: fakeIo(db, []), idle: () => true, gapMs: 0, maxChecks: 1 })).toBe(1)
  })

  it('keeps clear of a recording about to start', () => {
    expect(sweepIdle(db.raw, NOW)).toBe(true)
    db.raw.prepare(`INSERT INTO dvr_recordings (id, channel_stream_id, channel_name, title, start_utc, stop_utc, status, created_at, updated_at)
      VALUES ('r1', 200163566, 'US: Showtime', 'Heat', ?, ?, 'scheduled', ?, ?)`)
      .run(new Date(NOW + 60_000).toISOString(), new Date(NOW + 3_600_000).toISOString(), new Date(NOW).toISOString(), new Date(NOW).toISOString())
    expect(sweepIdle(db.raw, NOW)).toBe(false)
  })

  it('waits out a quiet period after any viewer, since a gap between channel hops is not idle', () => {
    _setViewerActivityForTests(NOW - 10 * 60_000)
    expect(sweepIdle(db.raw, NOW)).toBe(false)
    _setViewerActivityForTests(NOW - VIEWER_QUIET_MS)
    expect(sweepIdle(db.raw, NOW)).toBe(true)
  })

  it('runs only in the overnight window, which may wrap midnight', () => {
    const at = (hhmm: string): number => Date.parse(`2026-10-10T${hhmm}:00Z`)
    expect(sweepWindowOpen(at('08:59'), '9-15')).toBe(false)
    expect(sweepWindowOpen(at('09:00'), '9-15')).toBe(true)
    expect(sweepWindowOpen(at('14:59'), '9-15')).toBe(true)
    expect(sweepWindowOpen(at('15:00'), '9-15')).toBe(false)
    expect(sweepWindowOpen(at('23:00'), '22-4')).toBe(true)
    expect(sweepWindowOpen(at('03:00'), '22-4')).toBe(true)
    expect(sweepWindowOpen(at('12:00'), '22-4')).toBe(false)
    expect(sweepWindowOpen(at('12:00'), 'always')).toBe(false)
    expect(sweepWindowOpen(at('12:00'), '9-9')).toBe(false)
    // The 2026-10-10 game: 4 PM Eastern is outside the window.
    expect(sweepIdle(db.raw, at('20:11'))).toBe(false)
  })

  it('does nothing when feed checks are turned off', async () => {
    ;(env as { IPTV_FEED_CHECK: boolean }).IPTV_FEED_CHECK = false
    rememberGuideScope(db.raw, [123], 500)
    expect(await runFeedCheckSweep(db.raw, { io: fakeIo(db, []), idle: () => true, gapMs: 0 })).toBe(0)
  })
})
