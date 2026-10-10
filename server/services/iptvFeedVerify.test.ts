import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openIptvDb, type IptvDb } from './iptvDb.js'
import { FP_FRAME_BYTES } from './iptvFeedFingerprint.js'
import { getFeedCheck, recordFeedCheck } from './iptvFeedChecks.js'
import {
  _resetFeedCheckSchedulerForTests,
  checkFeedStandalone,
  checkLiveSession,
  scheduleLiveFeedCheck,
  type FeedCheckIo,
  type LiveSessionRef,
} from './iptvFeedVerify.js'

// ── Synthetic broadcasts (see iptvFeedFingerprint.test.ts) ────────────────────

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function broadcast(seed: number, frames = 300): Uint8Array {
  const r = rng(seed)
  const out = new Uint8Array(frames * FP_FRAME_BYTES)
  let scene = new Uint8Array(FP_FRAME_BYTES)
  for (let f = 0; f < frames; f++) {
    if (f % 12 === 0) scene = Uint8Array.from({ length: FP_FRAME_BYTES }, () => Math.floor(r() * 256))
    for (let i = 0; i < FP_FRAME_BYTES; i++) out[f * FP_FRAME_BYTES + i] = scene[i]
  }
  return out
}

/** `count` frames of `src` from `start`, as another source would deliver them. */
function slice(src: Uint8Array, start: number, count = 125): Uint8Array {
  return src.map((v) => Math.round(v * 0.9 + 10)).slice(start * FP_FRAME_BYTES, (start + count) * FP_FRAME_BYTES)
}

const SHO1 = broadcast(1)
const SHO2 = broadcast(2)
const EXTREME = broadcast(3)

// ── Fixtures ─────────────────────────────────────────────────────────────────

function seed(db: IptvDb): void {
  const rows: Array<[number, number, string, string]> = [
    [200163566, 154, 'US: Showtime', 'showtime.us'],
    [5864, 5386, 'US Showtime East (S)', 'showtime.us'],
    [22597, 7280, 'US Showtime (East) (H)', 'showtime.us'],
    [22599, 7357, 'US Showtime 2 (East) (H)', 'showtime2.us'],
    [200163569, 225, 'US: Showtime Extreme', 'showtimeextreme.us'],
  ]
  for (const [stream_id, num, name, epg_channel_id] of rows) {
    db.stmts.upsertChannel.run({
      stream_id, num, name, stream_icon: null, epg_channel_id, category_id: 123, is_adult: 0,
      tv_archive: 0, tv_archive_duration: null, added_ts: null, fetched_at: '2026-10-10T00:00:00Z',
    })
  }
  for (const [channel_id, title] of [['showtime.us', 'My Cousin Vinny'], ['showtime2.us', 'Blade Runner 2049'],
    ['showtimeextreme.us', 'Heat']]) {
    db.stmts.upsertEpg.run({
      channel_id, start_utc: '2026-10-10T02:30:00Z', stop_utc: '2026-10-10T04:30:00Z', title, description: null,
    })
  }
}

/** A fake ffmpeg child that writes `frames` to stdout and exits with `code`. */
function fakeProc(frames: Uint8Array | null, code: number | null = 0): ChildProcess {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>
  const stdout = new EventEmitter()
  proc.stdout = stdout
  proc.stderr = Object.assign(new EventEmitter(), { resume: () => undefined })
  proc.kill = vi.fn()
  setImmediate(() => {
    if (frames) stdout.emit('data', Buffer.from(frames))
    proc.emit('close', code, code === null ? 'SIGKILL' : null)
  })
  return proc as unknown as ChildProcess
}

function streamOf(args: string[]): number {
  return Number(/\/(\d+)\.ts$/.exec(args[args.indexOf('-i') + 1])![1])
}

function harness(opts: { session: Uint8Array; feeds: Record<number, Uint8Array>; upstream?: (id: number) => ChildProcess | null }) {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedverify-'))
  const db = openIptvDb(path.join(dbDir, 'iptv.db'))
  seed(db)
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedverify-sess-'))
  for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(sessionDir, `seg_0000${i}.ts`), '')
  const captured: number[] = []
  const io: FeedCheckIo = {
    db: db.raw,
    upstreamUrlFor: (id) => `http://up/${id}.ts`,
    userAgent: 'UA',
    spawnUpstream: (args) => {
      const id = streamOf(args)
      captured.push(id)
      return opts.upstream ? opts.upstream(id) : fakeProc(opts.feeds[id] ?? null)
    },
    spawnLocal: () => fakeProc(opts.session),
    isDead: () => false,
    sleep: async () => undefined,
    now: () => Date.now(),
  }
  const ref: LiveSessionRef = {
    tunedStreamId: 200163566, dialedStreamId: 200163566, sessionId: 'sess-1', dir: sessionDir,
    startedAt: Date.now() - 60_000,
  }
  return { db, io, ref, captured }
}

const FEEDS = {
  5864: slice(SHO1, 140),
  22597: slice(SHO1, 150),
  22599: slice(SHO2, 140),
  200163569: slice(EXTREME, 140),
}

beforeEach(() => _resetFeedCheckSchedulerForTests())

describe('checkLiveSession', () => {
  it('catches a stream carrying another channel and names the stream to switch to (the Showtime incident)', async () => {
    const { db, io, ref, captured } = harness({ session: SHO2, feeds: FEEDS })
    const result = await checkLiveSession(io, ref, () => true)
    expect(result.outcome).toMatchObject({ kind: 'carries', epgId: 'showtime2.us', matchedStreamId: 22599 })
    expect(result.intendedEpg).toBe('showtime.us')
    expect(result.switchTo).toBe(5864)
    // Sibling first (no match), then Showtime 2 (match) — and it stops there.
    expect(captured).toEqual([5864, 22599])
    expect(getFeedCheck(db.raw, 200163566)).toMatchObject({
      verdict: 'mislabeled', listed_epg_id: 'showtime.us', actual_epg_id: 'showtime2.us', matched_stream_id: 22599,
    })
  })

  it('confirms a healthy stream with one comparison and no switch', async () => {
    const { db, io, ref, captured } = harness({ session: SHO1, feeds: FEEDS })
    const result = await checkLiveSession(io, ref, () => true)
    expect(result.outcome).toMatchObject({ kind: 'carries', epgId: 'showtime.us' })
    expect(result.switchTo).toBeNull()
    expect(captured).toEqual([5864])
    expect(getFeedCheck(db.raw, 200163566)?.verdict).toBe('match')
  })

  it('stops at an ambiguous picture instead of guessing', async () => {
    const blend = SHO1.map((v, i) => Math.round((v + SHO2[i]) / 2))
    const { db, io, ref, captured } = harness({ session: blend, feeds: FEEDS })
    const result = await checkLiveSession(io, ref, () => true)
    expect(result.outcome.kind).toBe('unknown')
    expect(result.switchTo).toBeNull()
    expect(captured).toEqual([5864])
    expect(getFeedCheck(db.raw, 200163566)?.verdict).toBe('inconclusive')
  })

  it('does not call a stream mislabeled on a related channel match alone', async () => {
    const { db, io, ref, captured } = harness({ session: SHO2, feeds: FEEDS })
    // No other Showtime stream left to compare: Showtime 2 matching could mean
    // either stream is the mislabeled one.
    db.raw.prepare('DELETE FROM channels WHERE stream_id IN (5864, 22597)').run()
    const result = await checkLiveSession(io, ref, () => true)
    expect(result.outcome.kind).toBe('unknown')
    expect(result.switchTo).toBeNull()
    expect(captured).toEqual([22599])
    expect(getFeedCheck(db.raw, 200163566)?.verdict).toBe('inconclusive')
  })

  it('records nothing when a viewer preempts the capture', async () => {
    const { db, io, ref } = harness({ session: SHO2, feeds: FEEDS, upstream: () => fakeProc(null, null) })
    const result = await checkLiveSession(io, ref, () => true)
    expect(result.outcome.kind).toBe('aborted')
    expect(getFeedCheck(db.raw, 200163566)).toBeUndefined()
  })

  it('records nothing when no upstream slot is free', async () => {
    const { db, io, ref } = harness({ session: SHO2, feeds: FEEDS, upstream: () => null })
    const result = await checkLiveSession(io, ref, () => true)
    expect(result.outcome).toEqual({ kind: 'aborted', reason: 'no free upstream slot' })
    expect(getFeedCheck(db.raw, 200163566)).toBeUndefined()
  })

  it('uses a fresh verdict without capturing anything', async () => {
    const { db, io, ref, captured } = harness({ session: SHO2, feeds: FEEDS })
    recordFeedCheck(db.raw, {
      stream_id: 200163566, verdict: 'mislabeled', listed_epg_id: 'showtime.us', actual_epg_id: 'showtime2.us',
      matched_stream_id: 22599, score: 0.97,
    })
    const result = await checkLiveSession(io, ref, () => true)
    // The guide now lists Showtime 2 on this stream, so tuning it means Showtime 2.
    expect(result.intendedEpg).toBe('showtime2.us')
    expect(result.outcome).toMatchObject({ kind: 'carries', epgId: 'showtime2.us', cached: true })
    expect(result.switchTo).toBeNull()
    expect(captured).toEqual([])
  })
})

describe('scheduleLiveFeedCheck', () => {
  it('switches the viewer once per session', async () => {
    const { io, ref } = harness({ session: SHO2, feeds: FEEDS })
    const onWrongFeed = vi.fn()
    scheduleLiveFeedCheck(io, ref, () => true, onWrongFeed)
    await vi.waitFor(() => expect(onWrongFeed).toHaveBeenCalledWith(5864))
    scheduleLiveFeedCheck(io, ref, () => true, onWrongFeed)
    await new Promise((r) => setTimeout(r, 20))
    expect(onWrongFeed).toHaveBeenCalledTimes(1)
  })

  it('does not switch a viewer who already left', async () => {
    const { io, ref } = harness({ session: SHO2, feeds: FEEDS })
    let active = true
    const onWrongFeed = vi.fn()
    scheduleLiveFeedCheck(io, ref, () => active, onWrongFeed)
    active = false
    await new Promise((r) => setTimeout(r, 50))
    expect(onWrongFeed).not.toHaveBeenCalled()
  })
})

describe('checkFeedStandalone', () => {
  it('captures subject and candidate side by side', async () => {
    const { db, io, captured } = harness({
      session: SHO2,
      feeds: { ...FEEDS, 200163566: slice(SHO2, 130) },
    })
    const outcome = await checkFeedStandalone(io, 200163566)
    expect(outcome).toMatchObject({ kind: 'carries', epgId: 'showtime2.us' })
    expect(captured).toEqual([200163566, 5864, 200163566, 22599])
    expect(getFeedCheck(db.raw, 200163566)?.verdict).toBe('mislabeled')
  })
})
