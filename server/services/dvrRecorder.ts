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
import { credsFromEnv } from './xtream.js'
import { scrubXtreamCreds } from './iptvRemux.js'
import {
  planTransitions,
  markStatus,
  getRecording,
  listRecordings,
  type DvrRecording,
} from './dvrRecordings.js'

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
  /** Begin recording; returns the file path being written. */
  start(rec: DvrRecording): string
  /** Stop an in-flight recording (the file is finalized by the recorder). */
  stop(recId: string): void
  /** Ids currently being recorded. */
  running(): Set<string>
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
}

/** Real recorder: spawns ffmpeg per recording, writes `<dir>/<id>.ts`. */
export class FfmpegRecorder implements Recorder {
  private children = new Map<string, ChildProcess>()

  constructor(
    private readonly dir: string,
    private readonly db: Database.Database,
    private readonly nowMs: () => number = Date.now,
  ) {}

  filePathFor(recId: string): string {
    return path.join(this.dir, `${recId}.ts`)
  }

  start(rec: DvrRecording): string {
    fs.mkdirSync(this.dir, { recursive: true })
    const filePath = this.filePathFor(rec.id)
    const durationSecs = Math.max(1, (Date.parse(rec.stop_utc) - this.nowMs()) / 1000)
    const args = buildRecordArgs(liveUrl(rec.channel_stream_id), filePath, durationSecs)
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })

    proc.stderr?.on('data', (chunk: Buffer) => {
      // ffmpeg echoes the input URL (with creds) on error — always scrub.
      const line = scrubXtreamCreds(chunk.toString())
      if (/error|failed|invalid/i.test(line)) {
        console.warn(`[dvr ${rec.id}] ffmpeg: ${line.trim()}`)
      }
    })
    proc.on('exit', (code, signal) => {
      this.children.delete(rec.id)
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
  const recorder = new FfmpegRecorder(dir, db)
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
