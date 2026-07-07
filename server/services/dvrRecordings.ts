// DVR recordings (M6 — DVR bucket, phase 1).
//
// Data model + scheduling/CRUD + the PURE transition planner. The recorder
// engine (phase 2) drives `planTransitions` on a scheduler tick and applies the
// result via `markStatus` (spawn/stop ffmpeg against the live channel). Kept
// DB-handle-injectable (functions take the raw better-sqlite3 db) so the logic
// is testable against a temp DB, not the iptvDb() singleton.

import type Database from 'better-sqlite3'
import { generateUlid } from './iptvStreamToken.js'

export type RecordingStatus =
  | 'scheduled'
  | 'recording'
  | 'completed'
  | 'failed'
  | 'missed'
  | 'cancelled'

export interface DvrRecording {
  id: string
  channel_stream_id: number
  channel_name: string
  title: string
  start_utc: string
  stop_utc: string
  status: RecordingStatus
  file_path: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export interface NewRecordingInput {
  channel_stream_id: number
  channel_name: string
  title: string
  start_utc: string
  stop_utc: string
}

/**
 * Pure validation for a new recording. Returns a stable error code, or null if
 * the input is valid. A recording whose window has already fully ended can't be
 * recorded, so it is rejected here rather than scheduled into the past.
 */
export function validateNewRecording(input: NewRecordingInput, nowIso: string): string | null {
  if (!Number.isInteger(input.channel_stream_id) || input.channel_stream_id <= 0) {
    return 'invalid_channel'
  }
  if (!input.channel_name || !input.channel_name.trim()) return 'missing_channel_name'
  if (!input.title || !input.title.trim()) return 'missing_title'
  const start = Date.parse(input.start_utc)
  const stop = Date.parse(input.stop_utc)
  const now = Date.parse(nowIso)
  if (Number.isNaN(start) || Number.isNaN(stop)) return 'invalid_time'
  if (stop <= start) return 'stop_before_start'
  if (stop <= now) return 'already_ended'
  return null
}

export interface TransitionPlan {
  /**
   * Rows whose window is open now (start <= now < stop) and want ffmpeg running:
   * `scheduled` rows that are due to begin, AND `recording` rows that are open
   * but no longer have a live child (a backend restart/OOM mid-window orphans
   * the row — its in-memory child is gone). The tick de-dupes the latter against
   * the recorder's live set so a genuinely-running recording is never re-spawned.
   */
  toStart: DvrRecording[]
  /** recording rows whose window has closed (stop <= now) — stop ffmpeg, complete. */
  toStop: DvrRecording[]
  /** scheduled rows whose window fully elapsed unstarted (stop <= now) — mark missed. */
  toMiss: DvrRecording[]
}

/**
 * Pure: given the current time and all rows, decide which recordings to start,
 * stop, or mark missed. The recorder engine (phase 2) is the only thing that
 * applies these — this function performs no I/O so the timing rules are tested
 * directly.
 */
export function planTransitions(nowIso: string, rows: DvrRecording[]): TransitionPlan {
  const now = Date.parse(nowIso)
  const plan: TransitionPlan = { toStart: [], toStop: [], toMiss: [] }
  for (const r of rows) {
    const start = Date.parse(r.start_utc)
    const stop = Date.parse(r.stop_utc)
    if (r.status === 'scheduled') {
      if (stop <= now) plan.toMiss.push(r)
      else if (start <= now) plan.toStart.push(r)
    } else if (r.status === 'recording') {
      // Window still open but the row says 'recording': either a live child is
      // capturing it (the tick skips it via recorder.running()) or the backend
      // restarted mid-window and orphaned it — in which case it belongs in
      // toStart so capture RESUMES instead of the remaining window being lost.
      if (stop <= now) plan.toStop.push(r)
      else plan.toStart.push(r)
    }
  }
  return plan
}

// ── DB ops (raw better-sqlite3 handle injected for testability) ──────────────

export function scheduleRecording(
  db: Database.Database,
  input: NewRecordingInput,
  nowIso: string = new Date().toISOString(),
): DvrRecording {
  const id = generateUlid()
  db.prepare(
    `INSERT INTO dvr_recordings
       (id, channel_stream_id, channel_name, title, start_utc, stop_utc, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
  ).run(
    id,
    input.channel_stream_id,
    input.channel_name,
    input.title,
    input.start_utc,
    input.stop_utc,
    nowIso,
    nowIso,
  )
  // getRecording cannot be null right after a successful insert.
  return getRecording(db, id) as DvrRecording
}

export function listRecordings(db: Database.Database): DvrRecording[] {
  return db
    .prepare(`SELECT * FROM dvr_recordings ORDER BY start_utc DESC`)
    .all() as DvrRecording[]
}

export function getRecording(db: Database.Database, id: string): DvrRecording | null {
  return (db.prepare(`SELECT * FROM dvr_recordings WHERE id = ?`).get(id) as DvrRecording) ?? null
}

/**
 * Cancel a not-yet-terminal recording, or delete a terminal one. Returns the
 * outcome, or null if the id is unknown. The caller is responsible for stopping
 * any in-flight ffmpeg (phase 2) and removing the file on disk.
 */
export function cancelRecording(
  db: Database.Database,
  id: string,
  nowIso: string = new Date().toISOString(),
): 'cancelled' | 'deleted' | null {
  const row = getRecording(db, id)
  if (!row) return null
  if (row.status === 'scheduled' || row.status === 'recording') {
    db.prepare(`UPDATE dvr_recordings SET status='cancelled', updated_at=? WHERE id=?`).run(nowIso, id)
    return 'cancelled'
  }
  db.prepare(`DELETE FROM dvr_recordings WHERE id=?`).run(id)
  return 'deleted'
}

/** Apply a status transition (used by the phase-2 recorder + tests). */
export function markStatus(
  db: Database.Database,
  id: string,
  status: RecordingStatus,
  fields: { file_path?: string | null; error?: string | null } = {},
  nowIso: string = new Date().toISOString(),
): void {
  db.prepare(
    `UPDATE dvr_recordings
       SET status = ?, file_path = COALESCE(?, file_path), error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(status, fields.file_path ?? null, fields.error ?? null, nowIso, id)
}
