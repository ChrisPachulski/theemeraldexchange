// Feed checks: learn which channel a live stream really carries by comparing its
// picture with other streams' (see iptvFeedFingerprint for why the picture is
// the only ground truth), then correct the guide and the viewer's tune.
//
// On tune (checkLiveSession): once a viewer's remux session has some footage,
// capture ~25s of one candidate stream through a spare upstream slot and compare
// it with the session's own segments, so a comparison costs ONE extra provider
// connection. Candidates (iptvFeedChecks.feedCheckCandidates): another stream of
// the listed channel first, then related channels (Showtime 2 for Showtime), then
// a second listed-channel stream. The first clear match decides which guide id
// the stream carries. A stream carrying another channel is recorded 'mislabeled'
// (the guide then lists that channel's programmes on it) and, when the viewer
// picked it for its listing, the caller redirects them to a stream of the
// listing they picked.
//
// Standalone (checkFeedStandalone, for the idle sweep and the CLI): no viewer
// session, so subject and candidate are captured side by side (two slots).
//
// Captures never outrank a viewer: they go through spawnAuxUpstream, which only
// starts in a free slot, and any viewer or recording that needs the slot kills
// them (preemptAuxUpstreams). A killed or failed capture aborts the check and
// records nothing, so a later tune simply tries again.

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

const CAPTURE_SECS = 25
const CAPTURE_TIMEOUT_MS = 60_000
/** Session footage older than the capture start that may line up with it (the
 *  provider opens a feed with a burst from a few seconds back). Stays inside the
 *  remux's ~80s segment window. */
const SESSION_LEAD_MS = 30_000
/** Session age before a check starts, so it has footage to compare. */
const SESSION_WARMUP_MS = 20_000
/** Wait after a capture for the session to finish the segment covering it. */
const FLUSH_MS = 4_000
const BETWEEN_CAPTURES_MS = 3_000
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

/** Read a capture's stdout frames. ok=false when ffmpeg failed or was killed
 *  (preempted by a viewer, or past the timeout). */
export function readFrames(proc: ChildProcess, timeoutMs: number): Promise<{ ok: boolean; frames: Uint8Array }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, frames: new Uint8Array(Buffer.concat(chunks)) })
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
    proc.once('error', () => finish(false))
    proc.once('close', (code) => finish(code === 0))
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

type SubjectFrames = (candidate: FeedCandidate) => Promise<{ subject: Uint8Array; candidate: Uint8Array } | string>

/** Walk the candidates until one clearly matches the subject's picture. */
async function compareAgainst(
  io: FeedCheckIo,
  subject: number,
  candidates: FeedCandidate[],
  frames: SubjectFrames,
  stillWanted: () => boolean,
): Promise<FeedCheckOutcome> {
  let bestScore: number | null = null
  // A related channel's match alone is symmetric: the subject may carry that
  // channel, or that stream may carry the subject's. Only a stream of the
  // subject's own listing that clearly differs breaks the tie.
  let siblingDiffered = false
  for (const [i, candidate] of candidates.entries()) {
    if (i > 0) await io.sleep(BETWEEN_CAPTURES_MS)
    if (!stillWanted()) return { kind: 'aborted', reason: 'session ended' }
    const got = await frames(candidate)
    if (typeof got === 'string') return { kind: 'aborted', reason: got }
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
  const candidates = (): FeedCandidate[] =>
    feedCheckCandidates(db, subject, intendedEpg, { isDead: io.isDead, exclude: [ref.tunedStreamId] })
  const switchTarget = (outcome: FeedCheckOutcome, list: FeedCandidate[]): number | null =>
    outcome.kind === 'carries' && outcome.epgId !== intendedEpg
      ? (list.find((c) => c.role === 'sibling')?.streamId ?? null)
      : null

  const prior = getFeedCheck(db, subject)
  if (prior && feedCheckIsFresh(prior, io.now())) {
    const carried = knownCarriedEpgId(prior, listed)
    const outcome: FeedCheckOutcome = carried
      ? { kind: 'carries', epgId: carried, matchedStreamId: prior.matched_stream_id, score: prior.score, cached: true }
      : { kind: 'unknown', reason: 'recently inconclusive', score: prior.score }
    return { outcome, intendedEpg, switchTo: switchTarget(outcome, outcome.kind === 'carries' ? candidates() : []) }
  }

  while (io.now() - ref.startedAt < SESSION_WARMUP_MS) {
    if (!isActive()) return { outcome: { kind: 'aborted', reason: 'session ended' }, intendedEpg, switchTo: null }
    await io.sleep(2_000)
  }

  const list = candidates()
  const frames: SubjectFrames = async (candidate) => {
    const started = io.now()
    const proc = io.spawnUpstream(liveCaptureArgs(io.upstreamUrlFor(String(candidate.streamId)), CAPTURE_SECS, io.userAgent))
    if (!proc) return 'no free upstream slot'
    const cand = await readFrames(proc, CAPTURE_TIMEOUT_MS)
    if (!cand.ok) return 'candidate capture failed or was preempted'
    await io.sleep(FLUSH_MS)
    if (!isActive()) return 'session ended'
    const files = sessionSegments(ref.dir, started - SESSION_LEAD_MS)
    if (files.length === 0) return 'no session footage'
    const subj = await readFrames(io.spawnLocal(segmentCaptureArgs(files)), CAPTURE_TIMEOUT_MS)
    if (!subj.ok) return 'session footage unreadable'
    return { subject: subj.frames, candidate: cand.frames }
  }
  const outcome = await compareAgainst(io, subject, list, frames, isActive)
  recordOutcome(db, subject, listed, outcome)
  const switchTo = switchTarget(outcome, list)
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
  const capture = (id: number): ChildProcess | null =>
    io.spawnUpstream(liveCaptureArgs(io.upstreamUrlFor(String(id)), CAPTURE_SECS, io.userAgent))
  const frames: SubjectFrames = async (candidate) => {
    const subjectProc = capture(streamId)
    if (!subjectProc) return 'no free upstream slot'
    const candidateProc = capture(candidate.streamId)
    if (!candidateProc) {
      subjectProc.kill('SIGKILL')
      return 'no second free upstream slot'
    }
    const [subj, cand] = await Promise.all([
      readFrames(subjectProc, CAPTURE_TIMEOUT_MS),
      readFrames(candidateProc, CAPTURE_TIMEOUT_MS),
    ])
    if (!subj.ok || !cand.ok) return 'capture failed or was preempted'
    return { subject: subj.frames, candidate: cand.frames }
  }
  const outcome = await compareAgainst(io, streamId, list, frames, stillWanted)
  recordOutcome(db, streamId, listed, outcome)
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
