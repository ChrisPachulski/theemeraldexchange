// Feed checks: learn which channel a live stream really carries by comparing its
// picture with other streams' (see iptvFeedFingerprint for why the picture is
// the only ground truth), then correct the guide and the viewer's tune.
//
// On tune (checkLiveSession): as soon as a viewer's remux session has its first
// segments, capture ~15s of one candidate stream through a spare upstream slot
// and compare it with the session's own segments, so a comparison costs ONE
// extra provider connection. Candidates (iptvFeedChecks.feedCheckCandidates):
// another stream of the listed channel first, then related channels (Showtime 2
// for Showtime), then a second listed-channel stream. The first clear match
// decides which guide id the stream carries. A stream carrying another channel
// is recorded 'mislabeled' (the guide then lists that channel's programmes on
// it) and, when the viewer picked it for its listing, the caller redirects them
// to a stream of the listing they picked.
//
// Standalone (checkFeedStandalone, for the idle sweep and the CLI): no viewer
// session, so subject and candidate are captured side by side (two slots).
//
// A stream with no other stream of its listing can never be confirmed or caught
// (a related-channel match alone is symmetric, see compareAgainst), so it is
// recorded inconclusive without opening any connection.
//
// Captures never outrank a viewer: they go through spawnAuxUpstream, which only
// starts in a free slot, and any viewer or recording that needs the slot kills
// them (preemptAuxUpstreams). A preempted check records nothing, so a later tune
// or sweep simply tries again.

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { createLogger } from './logger.js'
import {
  compareFingerprints,
  FP_FPS,
  FP_FRAME_BYTES,
  liveCaptureArgs,
  segmentCaptureArgs,
  type FingerprintMatch,
} from './iptvFeedFingerprint.js'
import {
  effectiveEpgId,
  feedCheckCandidates,
  feedCheckIsFresh,
  getFeedCheck,
  knownCarriedEpgId,
  listedEpgId,
  recordFeedCheck,
  type FeedCandidate,
} from './iptvFeedChecks.js'

const log = createLogger('iptv-feed-check')

/** Fingerprint correlation at or above this: the same picture. */
export const MATCH_SCORE = 0.85
/** Below this: a different picture. Between the two: can't tell, stop. */
export const NO_MATCH_SCORE = 0.6

/** On tune the session's own footage spans the whole capture, so 15s (75
 *  frames) aligns fully; side-by-side captures start at different provider
 *  burst depths (measured up to 11s apart) and need the longer 25s. */
const SESSION_CAPTURE_SECS = 15
const STANDALONE_CAPTURE_SECS = 25
const CAPTURE_TIMEOUT_MS = 60_000
/** Session footage older than the capture start that may line up with it (the
 *  provider opens a feed with a burst from a few seconds back). Stays inside the
 *  remux's ~80s segment window. */
const SESSION_LEAD_MS = 30_000
/** Session age before a check starts: its first segments. */
const SESSION_WARMUP_MS = 4_000
/** Wait after a capture for the session to finish the segment covering it. */
const FLUSH_MS = 2_500
const SESSION_GAP_MS = 1_000
const STANDALONE_GAP_MS = 3_000
/** Frames kept per capture (two minutes). */
const MAX_FRAME_BYTES = FP_FRAME_BYTES * FP_FPS * 120

export interface FeedCheckIo {
  db: Database.Database
  upstreamUrlFor: (streamId: string) => string
  userAgent: string
  /** Start a capture that opens a provider connection; null when no slot is free. */
  spawnUpstream: (args: string[]) => ChildProcess | null
  /** Start a local ffmpeg (a session's segments; no provider connection). */
  spawnLocal: (args: string[]) => ChildProcess
  isDead: (streamId: number) => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export type FeedCheckOutcome =
  | { kind: 'carries'; epgId: string; matchedStreamId: number | null; score: number | null; cached: boolean }
  | { kind: 'unknown'; reason: string; score: number | null }
  | { kind: 'aborted'; reason: string }

export type CompareVerdict = 'same' | 'different' | 'unsure'

/** A fingerprint comparison as a verdict. No alignment at all is 'unsure'. */
export function classifyMatch(m: FingerprintMatch | null): CompareVerdict {
  if (!m) return 'unsure'
  if (m.score >= MATCH_SCORE) return 'same'
  if (m.score < NO_MATCH_SCORE) return 'different'
  return 'unsure'
}

export interface Capture {
  ok: boolean
  /** Killed by a signal: preempted by a viewer, or past the timeout. */
  killed: boolean
  frames: Uint8Array
}

/** Read a capture's stdout frames. ok=false when ffmpeg failed or was killed. */
export function readFrames(proc: ChildProcess, timeoutMs: number): Promise<Capture> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (ok: boolean, killed: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, killed, frames: new Uint8Array(Buffer.concat(chunks)) })
    }
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // Already exited.
      }
    }, timeoutMs)
    timer.unref?.()
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (size >= MAX_FRAME_BYTES) return
      chunks.push(chunk)
      size += chunk.length
    })
    proc.stderr?.resume()
    proc.once('error', () => finish(false, false))
    proc.once('close', (code, signal) => finish(code === 0, signal != null))
  })
}

/** The session's segments written since `fromMs`, in playback order. */
function sessionSegments(dir: string, fromMs: number): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of names.filter((n) => /^seg_\d{5}\.ts$/.test(n)).sort()) {
    const file = path.join(dir, name)
    try {
      if (fs.statSync(file).mtimeMs >= fromMs) out.push(file)
    } catch {
      // Rolled off the window between readdir and stat.
    }
  }
  return out
}

/** Record what a check learned about `streamId`. Aborted checks record nothing. */
function recordOutcome(db: Database.Database, streamId: number, listed: string | null, outcome: FeedCheckOutcome): void {
  if (outcome.kind === 'carries') {
    if (outcome.cached) return
    const matches = outcome.epgId === listed
    recordFeedCheck(db, {
      stream_id: streamId,
      verdict: matches ? 'match' : 'mislabeled',
      listed_epg_id: listed,
      actual_epg_id: matches ? null : outcome.epgId,
      matched_stream_id: outcome.matchedStreamId,
      score: outcome.score,
    })
  } else if (outcome.kind === 'unknown') {
    recordFeedCheck(db, {
      stream_id: streamId,
      verdict: 'inconclusive',
      listed_epg_id: listed,
      actual_epg_id: null,
      matched_stream_id: null,
      score: outcome.score,
    })
  }
}

/** The matched candidate carries the same picture as the subject, and its own
 *  listing says so: confirm it too (a second sweep check of it would only
 *  repeat this comparison). Leaves a fresh verdict alone. */
function recordCorroboration(db: Database.Database, outcome: FeedCheckOutcome, subject: number, now: number): void {
  if (outcome.kind !== 'carries' || outcome.cached || outcome.matchedStreamId == null) return
  const candidate = outcome.matchedStreamId
  if (listedEpgId(db, candidate) !== outcome.epgId) return
  const prior = getFeedCheck(db, candidate)
  if (prior && feedCheckIsFresh(prior, now)) return
  recordFeedCheck(db, {
    stream_id: candidate,
    verdict: 'match',
    listed_epg_id: outcome.epgId,
    actual_epg_id: null,
    matched_stream_id: subject,
    score: outcome.score,
  })
}

/** One comparison's footage, or why there is none: 'abort' ends the check
 *  without a verdict (preempted, no slot, session gone); 'skip' drops just this
 *  candidate (its own capture failed); 'subject' means the subject itself could
 *  not be captured. */
type Footage =
  | { subject: Uint8Array; candidate: Uint8Array }
  | { abort: string }
  | { skip: string }
  | { subject_failed: string }

/** Walk the candidates until one clearly matches the subject's picture. */
async function compareAgainst(
  io: FeedCheckIo,
  subject: number,
  candidates: FeedCandidate[],
  footage: (candidate: FeedCandidate) => Promise<Footage>,
  stillWanted: () => boolean,
  gapMs: number,
): Promise<FeedCheckOutcome> {
  let bestScore: number | null = null
  // A related channel's match alone is symmetric: the subject may carry that
  // channel, or that stream may carry the subject's. Only a stream of the
  // subject's own listing that clearly differs breaks the tie.
  let siblingDiffered = false
  const queue = [...candidates]
  for (let first = true; queue.length > 0; first = false) {
    const candidate = queue.shift()!
    if (!first) await io.sleep(gapMs)
    if (!stillWanted()) return { kind: 'aborted', reason: 'no longer wanted' }
    const got = await footage(candidate)
    if ('abort' in got) return { kind: 'aborted', reason: got.abort }
    if ('subject_failed' in got) return { kind: 'unknown', reason: got.subject_failed, score: bestScore }
    if ('skip' in got) {
      log.info('feed compare skipped', { subject, candidate: candidate.streamId, reason: got.skip })
      // A listed-channel stream is what makes any match decisive: try the next
      // one before the related channels.
      const next = queue.findIndex((c) => c.role === 'sibling')
      if (candidate.role === 'sibling' && next > 0) queue.unshift(...queue.splice(next, 1))
      continue
    }
    const m = compareFingerprints(got.subject, got.candidate)
    const verdict = classifyMatch(m)
    log.info('feed compare', {
      subject,
      candidate: candidate.streamId,
      candidateEpg: candidate.epgId,
      role: candidate.role,
      verdict,
      score: m ? Number(m.score.toFixed(3)) : null,
      offsetFrames: m?.offset ?? null,
      overlapFrames: m?.overlap ?? 0,
    })
    if (m) bestScore = Math.max(bestScore ?? -1, m.score)
    if (verdict === 'same') {
      if (candidate.role === 'family' && !siblingDiffered) {
        return { kind: 'unknown', reason: 'matches a related channel with no listed stream to compare', score: bestScore }
      }
      return { kind: 'carries', epgId: candidate.epgId, matchedStreamId: candidate.streamId, score: m!.score, cached: false }
    }
    if (verdict === 'unsure') return { kind: 'unknown', reason: 'picture inconclusive', score: bestScore }
    if (candidate.role === 'sibling') siblingDiffered = true
  }
  return { kind: 'unknown', reason: candidates.length ? 'no candidate matched' : 'no candidate streams', score: bestScore }
}

const NO_SIBLING: FeedCheckOutcome = { kind: 'unknown', reason: 'no other stream of its listing to compare', score: null }

/** Capture ~`seconds` of a stream through a spare upstream slot. */
async function captureUpstream(io: FeedCheckIo, streamId: number, seconds: number): Promise<Capture | 'no slot'> {
  const proc = io.spawnUpstream(liveCaptureArgs(io.upstreamUrlFor(String(streamId)), seconds, io.userAgent))
  if (!proc) return 'no slot'
  return readFrames(proc, CAPTURE_TIMEOUT_MS)
}

export interface LiveSessionRef {
  /** The channel the viewer tuned. */
  tunedStreamId: number
  /** The stream actually dialed (differs after a dead-feed failover or redirect). */
  dialedStreamId: number
  sessionId: string
  dir: string
  startedAt: number
}

export interface LiveCheckResult {
  outcome: FeedCheckOutcome
  /** The guide id the viewer picked when they tuned. */
  intendedEpg: string | null
  /** A stream of the intended channel to switch the viewer to, when the dialed
   *  stream proved to carry something else. */
  switchTo: number | null
}

/** Check the stream behind a live viewer's session (see the header). */
export async function checkLiveSession(
  io: FeedCheckIo,
  ref: LiveSessionRef,
  isActive: () => boolean,
): Promise<LiveCheckResult> {
  const { db } = io
  const intendedEpg = effectiveEpgId(db, ref.tunedStreamId)
  if (!intendedEpg) return { outcome: { kind: 'unknown', reason: 'no guide id', score: null }, intendedEpg, switchTo: null }
  const subject = ref.dialedStreamId
  const listed = listedEpgId(db, subject)
  const list = feedCheckCandidates(db, subject, intendedEpg, { isDead: io.isDead, exclude: [ref.tunedStreamId] })
  const switchTarget = (outcome: FeedCheckOutcome): number | null =>
    outcome.kind === 'carries' && outcome.epgId !== intendedEpg
      ? (list.find((c) => c.role === 'sibling')?.streamId ?? null)
      : null

  const prior = getFeedCheck(db, subject)
  if (prior && feedCheckIsFresh(prior, io.now())) {
    const carried = knownCarriedEpgId(prior, listed)
    const outcome: FeedCheckOutcome = carried
      ? { kind: 'carries', epgId: carried, matchedStreamId: prior.matched_stream_id, score: prior.score, cached: true }
      : { kind: 'unknown', reason: 'recently inconclusive', score: prior.score }
    return { outcome, intendedEpg, switchTo: switchTarget(outcome) }
  }
  if (!list.some((c) => c.role === 'sibling')) {
    recordOutcome(db, subject, listed, NO_SIBLING)
    return { outcome: NO_SIBLING, intendedEpg, switchTo: null }
  }

  while (io.now() - ref.startedAt < SESSION_WARMUP_MS) {
    if (!isActive()) return { outcome: { kind: 'aborted', reason: 'session ended' }, intendedEpg, switchTo: null }
    await io.sleep(1_000)
  }

  const footage = async (candidate: FeedCandidate): Promise<Footage> => {
    const started = io.now()
    const cand = await captureUpstream(io, candidate.streamId, SESSION_CAPTURE_SECS)
    if (cand === 'no slot') return { abort: 'no free upstream slot' }
    if (cand.killed) return { abort: 'candidate capture preempted' }
    if (!cand.ok) return { skip: 'candidate capture failed' }
    await io.sleep(FLUSH_MS)
    if (!isActive()) return { abort: 'session ended' }
    const files = sessionSegments(ref.dir, started - SESSION_LEAD_MS)
    if (files.length === 0) return { abort: 'no session footage' }
    const subj = await readFrames(io.spawnLocal(segmentCaptureArgs(files)), CAPTURE_TIMEOUT_MS)
    if (!subj.ok) return { abort: 'session footage unreadable' }
    return { subject: subj.frames, candidate: cand.frames }
  }
  const outcome = await compareAgainst(io, subject, list, footage, isActive, SESSION_GAP_MS)
  recordOutcome(db, subject, listed, outcome)
  recordCorroboration(db, outcome, subject, io.now())
  const switchTo = switchTarget(outcome)
  log.info('feed check', { subject, tuned: ref.tunedStreamId, listed, intendedEpg, outcome, switchTo })
  return { outcome, intendedEpg, switchTo }
}

/** Check a stream with no viewer: subject and candidate captured side by side. */
export async function checkFeedStandalone(io: FeedCheckIo, streamId: number, stillWanted: () => boolean = () => true): Promise<FeedCheckOutcome> {
  const { db } = io
  const intendedEpg = effectiveEpgId(db, streamId)
  if (!intendedEpg) return { kind: 'unknown', reason: 'no guide id', score: null }
  const listed = listedEpgId(db, streamId)
  const list = feedCheckCandidates(db, streamId, intendedEpg, { isDead: io.isDead })
  if (!list.some((c) => c.role === 'sibling')) {
    recordOutcome(db, streamId, listed, NO_SIBLING)
    return NO_SIBLING
  }
  const spawnCapture = (id: number): ChildProcess | null =>
    io.spawnUpstream(liveCaptureArgs(io.upstreamUrlFor(String(id)), STANDALONE_CAPTURE_SECS, io.userAgent))
  const footage = async (candidate: FeedCandidate): Promise<Footage> => {
    const subjectProc = spawnCapture(streamId)
    if (!subjectProc) return { abort: 'no free upstream slot' }
    const candidateProc = spawnCapture(candidate.streamId)
    if (!candidateProc) {
      subjectProc.kill('SIGKILL')
      return { abort: 'no second free upstream slot' }
    }
    const [subj, cand] = await Promise.all([
      readFrames(subjectProc, CAPTURE_TIMEOUT_MS),
      readFrames(candidateProc, CAPTURE_TIMEOUT_MS),
    ])
    if (subj.killed || cand.killed) return { abort: 'capture preempted' }
    if (!subj.ok) return { subject_failed: 'subject capture failed' }
    if (!cand.ok) return { skip: 'candidate capture failed' }
    return { subject: subj.frames, candidate: cand.frames }
  }
  const outcome = await compareAgainst(io, streamId, list, footage, stillWanted, STANDALONE_GAP_MS)
  recordOutcome(db, streamId, listed, outcome)
  recordCorroboration(db, outcome, streamId, io.now())
  log.info('feed check (standalone)', { subject: streamId, listed, intendedEpg, outcome })
  return outcome
}

// ── On-tune scheduling ────────────────────────────────────────────────────────

let running = false
const startedSessions = new Set<string>()

/**
 * Start a check for this live session unless one already ran for it. One check
 * runs at a time; while one runs this returns without marking the session, so
 * the next manifest poll tries again. `onWrongFeed` gets the stream to switch
 * the viewer to.
 */
export function scheduleLiveFeedCheck(
  io: FeedCheckIo,
  ref: LiveSessionRef,
  isActive: () => boolean,
  onWrongFeed: (switchTo: number) => void,
): void {
  if (running || startedSessions.has(ref.sessionId)) return
  running = true
  startedSessions.add(ref.sessionId)
  if (startedSessions.size > 500) startedSessions.delete(startedSessions.values().next().value!)
  void checkLiveSession(io, ref, isActive)
    .then((result) => {
      if (result.switchTo != null && isActive()) {
        log.warn('stream carries a different channel than the one tuned — switching the viewer', {
          tuned: ref.tunedStreamId,
          dialed: ref.dialedStreamId,
          intendedEpg: result.intendedEpg,
          carries: result.outcome.kind === 'carries' ? result.outcome.epgId : null,
          switchTo: result.switchTo,
        })
        onWrongFeed(result.switchTo)
      }
    })
    .catch((err) => log.warn('feed check failed', { sessionId: ref.sessionId, error: String(err) }))
    .finally(() => {
      running = false
    })
}

/** True while a check is running (the idle sweep stays out of its way). */
export function feedCheckRunning(): boolean {
  return running
}

/** Run `task` as the one check in flight, or return null when one already runs. */
export async function runExclusiveFeedCheck<T>(task: () => Promise<T>): Promise<T | null> {
  if (running) return null
  running = true
  try {
    return await task()
  } finally {
    running = false
  }
}

/** Test seam. */
export function _resetFeedCheckSchedulerForTests(): void {
  running = false
  startedSessions.clear()
}

/** Production io: real ffmpeg, the upstream cap's aux slots, the clock. */
export function feedCheckIo(
  db: Database.Database,
  upstreamUrlFor: (streamId: string) => string,
  deps: { spawnUpstream: (args: string[]) => ChildProcess | null; isDead: (streamId: string) => boolean; userAgent: string },
): FeedCheckIo {
  return {
    db,
    upstreamUrlFor,
    userAgent: deps.userAgent,
    spawnUpstream: deps.spawnUpstream,
    spawnLocal: (args) => spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] }),
    isDead: (id) => deps.isDead(String(id)),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  }
}
