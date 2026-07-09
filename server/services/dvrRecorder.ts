// DVR recorder engine (M6 — DVR bucket, phase 2).
//
// Drives the phase-1 transition planner on a scheduler tick: starts due
// recordings (spawn ffmpeg copying the live channel to a file), stops finished
// ones, and marks missed ones. The ffmpeg spawn is behind the `Recorder`
// interface so `tick` — the timing/state logic — is unit-tested with a fake
// recorder; the real `FfmpegRecorder` follows the proven iptvRemux spawn
// pattern (SIGTERM→SIGKILL, cred-scrubbed logs) and is deploy-verified.

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { env } from '../env.js'
import { credsFromEnv } from './xtream.js'
import { scrubXtreamCreds } from './iptvRemux.js'
import { streamConcurrency, type ConcurrencyTracker } from './iptvConcurrency.js'
import {
  planTransitions,
  markStatus,
  getRecording,
  listRecordings,
  type DvrRecording,
} from './dvrRecordings.js'

// A DVR recording opens a real provider connection exactly like a live viewer,
// so it MUST count against the same IPTV_MAX_UPSTREAM_CONNECTIONS ceiling the
// grant path enforces — otherwise a scheduled recording silently dials a third
// connection the cap never sees, and the provider retaliates by feeding CORRUPT,
// undecodable video to BOTH live viewers AND the recording (env.ts documents this
// abuse block). We count the concurrency tracker's upstream-consuming sessions:
// live viewers, remux viewers, and recordings (all registered as kind 'live').
// vod/series open no provider connection, so they don't count.
function upstreamInUse(tracker: ConcurrencyTracker): number {
  return tracker.list().filter((s) => s.kind === 'live' || s.kind === 'remux').length
}

/** Pure: ffmpeg argv that copies a live .ts stream to a file, bounded by `-t`. */
export function buildRecordArgs(
  upstreamUrl: string,
  filePath: string,
  durationSecs: number,
): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    // Constrain ffmpeg to the protocols a real upstream stream needs (the
    // provider 301s https→http), blocking file:/pipe:/concat: steering.
    '-protocol_whitelist',
    'http,https,tcp,tls',
    '-i',
    upstreamUrl,
    // Hard duration bound; the scheduler also SIGTERMs at stop time as a backstop.
    '-t',
    String(Math.max(1, Math.floor(durationSecs))),
    '-c',
    'copy',
    '-f',
    'mpegts',
    filePath,
  ]
}

/** Live .ts upstream URL for an Xtream channel (same shape as the live proxy). */
export function liveUrl(streamId: number): string {
  const c = credsFromEnv()
  return `${c.host}/live/${encodeURIComponent(c.username)}/${encodeURIComponent(c.password)}/${streamId}.ts`
}

/** Injected so `tick`'s logic is testable without spawning ffmpeg. */
export interface Recorder {
  /**
   * Begin recording; returns the file path being written, or `null` when the
   * recording was DEFERRED because every upstream provider connection is in use
   * (recording loses to live viewers). A deferred recording is not started and
   * not marked failed — the next tick retries it while its window is still open.
   */
  start(rec: DvrRecording): string | null
  /** Stop an in-flight recording (the file is finalized by the recorder). */
  stop(recId: string): void
  /** Ids currently being recorded. */
  running(): Set<string>
  /** Refresh the upstream-slot heartbeat for in-flight recordings so a
   *  multi-hour capture isn't reaped by the 30s idle sweep. Optional: the
   *  fake recorder used in tick's logic tests doesn't hold real slots. */
  heartbeat?(): void
}

/**
 * One scheduler pass. Pure control flow over the injected recorder + the DB:
 * start due 'scheduled' rows, RESUME open 'recording' rows orphaned by a restart
 * (in toStart but skipped when the recorder is already running them), stop
 * 'recording' rows whose window closed, and mark fully-elapsed-unstarted rows
 * 'missed'. The real recorder's ffmpeg-exit handler is what finalizes
 * completed/failed; `tick` marking 'completed' on a deliberate stop is
 * idempotent with that (the exit handler only acts while the row is still
 * 'recording'). A resumed recording re-captures the REMAINING window into a
 * fresh file — the pre-restart partial is not stitched in (single-file design).
 */
export function tick(
  db: Database.Database,
  recorder: Recorder,
  nowIso: string = new Date().toISOString(),
): void {
  const rows = listRecordings(db).filter(
    (r) => r.status === 'scheduled' || r.status === 'recording',
  )
  const plan = planTransitions(nowIso, rows)
  const running = recorder.running()

  for (const r of plan.toStart) {
    if (running.has(r.id)) continue
    try {
      const filePath = recorder.start(r)
      // null = deferred: no free upstream connection right now. Leave the row as
      // it is (scheduled/recording) so a later tick retries while the window is
      // still open; planTransitions marks it 'missed' once the window fully
      // elapses unstarted. Recording yields to live viewers rather than opening
      // an over-cap connection that would corrupt them.
      if (filePath === null) continue
      markStatus(db, r.id, 'recording', { file_path: filePath }, nowIso)
    } catch (err) {
      markStatus(
        db,
        r.id,
        'failed',
        { error: err instanceof Error ? err.message : String(err) },
        nowIso,
      )
    }
  }
  for (const r of plan.toStop) {
    recorder.stop(r.id)
    markStatus(db, r.id, 'completed', {}, nowIso)
  }
  for (const r of plan.toMiss) {
    markStatus(db, r.id, 'missed', {}, nowIso)
  }
  // Keep in-flight recordings' upstream slots alive between ticks (idle sweep is
  // 30s; the scheduler ticks well inside that) so the cap accounting stays honest
  // for the full multi-hour capture.
  recorder.heartbeat?.()
}

/** Concurrency-tracker session id a recording holds while dialing the provider. */
function recordSessionId(recId: string): string {
  return `record:${recId}`
}

/** Real recorder: spawns ffmpeg per recording, writes `<dir>/<id>.ts`. */
export class FfmpegRecorder implements Recorder {
  private children = new Map<string, ChildProcess>()

  constructor(
    private readonly dir: string,
    private readonly db: Database.Database,
    private readonly nowMs: () => number = Date.now,
    // Upstream-connection accounting. When present, a recording acquires a
    // concurrency-tracker slot (kind 'live', so it shows up in /api/iptv/sessions
    // and counts against the shared upstream cap) BEFORE ffmpeg dials the
    // provider, and is DEFERRED when the cap is already full so it loses to live
    // viewers instead of corrupting them. `startDvrScheduler` injects the real
    // singleton + env cap; left undefined the recorder skips gating (used by the
    // unit tests that exercise the ffmpeg lifecycle in isolation).
    private readonly tracker?: ConcurrencyTracker,
    private readonly upstreamCap: () => number = () => env.IPTV_MAX_UPSTREAM_CONNECTIONS,
  ) {}

  filePathFor(recId: string): string {
    return path.join(this.dir, `${recId}.ts`)
  }

  start(rec: DvrRecording): string | null {
    // Refuse to dial the provider when every upstream connection is already in
    // use: defer (tick leaves the row for a later pass) rather than opening an
    // over-cap connection the provider punishes by corrupting every live viewer.
    if (this.tracker) {
      const cap = this.upstreamCap()
      if (cap > 0 && upstreamInUse(this.tracker) >= cap) {
        console.warn(
          `[dvr ${rec.id}] upstream busy (${upstreamInUse(this.tracker)}/${cap}) — deferring recording`,
        )
        return null
      }
    }
    fs.mkdirSync(this.dir, { recursive: true })
    const filePath = this.filePathFor(rec.id)
    const durationSecs = Math.max(1, (Date.parse(rec.stop_utc) - this.nowMs()) / 1000)
    const args = buildRecordArgs(liveUrl(rec.channel_stream_id), filePath, durationSecs)
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })

    // Register the recording as a live upstream connection so it's visible in
    // /api/iptv/sessions and counted by upstreamInUse for the next dial. Synthetic
    // sub (`dvr:<id>`) so it never dedupes against a real viewer of the same
    // channel. Released on ffmpeg exit below.
    this.tracker?.tryAcquire({
      sub: `dvr:${rec.id}`,
      sessionId: recordSessionId(rec.id),
      kind: 'live',
      resourceId: String(rec.channel_stream_id),
      title: rec.channel_name,
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      // ffmpeg echoes the input URL (with creds) on error — always scrub.
      const line = scrubXtreamCreds(chunk.toString())
      if (/error|failed|invalid/i.test(line)) {
        console.warn(`[dvr ${rec.id}] ffmpeg: ${line.trim()}`)
      }
    })
    proc.on('error', (err) => {
      // spawn can fail asynchronously (ENOENT: ffmpeg not on PATH, EMFILE: fd
      // exhaustion, EACCES). Without this listener the 'error' event is unhandled
      // and crashes the whole backend. Mirror iptvRemux's guard: scrub creds, drop
      // the child, release the upstream slot acquired above (tryAcquire ran before
      // ffmpeg confirmed launch, so a spawn error would otherwise strand the slot
      // and permanently shrink the cap), and fail the row if it's still recording.
      console.warn(`[dvr ${rec.id}] ffmpeg spawn error: ${scrubXtreamCreds(err.message)}`)
      this.children.delete(rec.id)
      this.tracker?.release(recordSessionId(rec.id))
      const row = getRecording(this.db, rec.id)
      if (row?.status === 'recording') {
        markStatus(this.db, rec.id, 'failed', { error: `ffmpeg spawn error: ${scrubXtreamCreds(err.message)}` })
      }
    })
    proc.on('exit', (code, signal) => {
      this.children.delete(rec.id)
      // Free the upstream slot the instant ffmpeg releases the provider socket so
      // the next dial (a viewer or another recording) sees a truthful count.
      this.tracker?.release(recordSessionId(rec.id))
      // Finalize only if the row is still 'recording' — a deliberate tick-stop
      // already marked it completed, so we don't double-handle.
      const row = getRecording(this.db, rec.id)
      // A DELETE of an in-flight recording flips the row to 'cancelled' and
      // SIGTERMs us: the partial file is junk, so remove it now that ffmpeg has
      // released the descriptor (removing it mid-write would race the still-open
      // handle). This is where a cancel's disk is actually reclaimed.
      if (row?.status === 'cancelled') {
        this.removeFileQuietly(rec.id)
        return
      }
      if (row?.status !== 'recording') return
      // A SIGTERM while the window is STILL OPEN is an external interruption
      // (graceful shutdown / deploy / OOM), NOT a finished recording. Marking it
      // 'completed' here would finalize a partial file as a full recording and
      // the scheduler could never resume it — silent data loss labeled success.
      // Leave the row 'recording' so the next tick re-spawns ffmpeg for the
      // remaining window (planTransitions routes an open 'recording' row with no
      // live child back into toStart).
      if (signal === 'SIGTERM' && Date.parse(row.stop_utc) > this.nowMs()) {
        return
      }
      if (signal === 'SIGTERM' || code === 0) {
        markStatus(this.db, rec.id, 'completed', {})
      } else {
        markStatus(this.db, rec.id, 'failed', { error: `ffmpeg exited code=${code} signal=${signal ?? ''}` })
      }
    })
    this.children.set(rec.id, proc)
    return filePath
  }

  /** Best-effort removal of a recording's on-disk file (cancel cleanup). */
  private removeFileQuietly(recId: string): void {
    try {
      fs.rmSync(this.filePathFor(recId), { force: true })
    } catch {
      // Best-effort: a stranded .ts is a leak, not a reason to crash the handler.
    }
  }

  stop(recId: string): void {
    const proc = this.children.get(recId)
    if (!proc) return
    proc.kill('SIGTERM')
    const killTimer = setTimeout(() => {
      // proc.killed only means a signal was SUCCESSFULLY SENT, not that the
      // child exited — so it is true the instant SIGTERM is delivered and the
      // SIGKILL backstop could never fire on a wedged ffmpeg. A child that has
      // actually exited has a non-null exitCode (clean) or signalCode (killed);
      // escalate to SIGKILL only while BOTH are still null (truly running).
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
    }, 5_000)
    killTimer.unref?.()
  }

  running(): Set<string> {
    return new Set(this.children.keys())
  }

  /** Refresh the upstream-slot heartbeat for every in-flight recording so a
   *  multi-hour capture's slot isn't reaped by the tracker's 30s idle sweep. */
  heartbeat(): void {
    if (!this.tracker) return
    for (const id of this.children.keys()) this.tracker.heartbeat(recordSessionId(id))
  }

  /** SIGTERM every in-flight recording (graceful shutdown). */
  stopAll(): void {
    for (const id of this.children.keys()) this.stop(id)
  }
}

export interface DvrScheduler {
  stop(): void
  recorder: FfmpegRecorder
}

/** Start the DVR scheduler: an initial pass + a periodic tick. */
export function startDvrScheduler(
  db: Database.Database,
  dir: string,
  intervalMs = 20_000,
): DvrScheduler {
  // Inject the shared concurrency tracker + upstream cap so recordings are
  // accounted against IPTV_MAX_UPSTREAM_CONNECTIONS alongside live viewers.
  const recorder = new FfmpegRecorder(dir, db, Date.now, streamConcurrency())
  const run = (): void => {
    try {
      tick(db, recorder)
    } catch (err) {
      console.error('[dvr] scheduler tick failed:', err)
    }
  }
  run()
  const handle = setInterval(run, intervalMs)
  handle.unref?.()
  return {
    recorder,
    stop(): void {
      clearInterval(handle)
      recorder.stopAll()
    },
  }
}
