// Scheduled, automated snapshots of the server-owned SQLite DBs (finding 14-4).
//
// Before this, the ONLY durability for server.db / iptv.db was the live
// bind-mounted data/ directory plus the DESTRUCTIVE-migration backup gate
// (migrator.ts), which fires only when a destructive migration runs. A
// non-migration data loss — disk failure, an accidental volume delete, a
// corrupted -wal on power loss — was therefore unrecoverable, and env.ts warns
// that losing server.db regenerates server_id and silently revokes every
// paired device token.
//
// This module takes consistent online snapshots using SQLite's `VACUUM INTO`
// (a transactionally-consistent copy that is safe to run on a live WAL DB)
// into a separate retention directory, prunes old snapshots, and stamps
// server_state.last_backup_at — which doubles as the freshness source the
// DESTRUCTIVE-migration gate checks, so a deploy carrying a destructive
// migration finds a recent automated backup.
//
// RESTORE RUNBOOK (documented + tested by the snapshot test):
//   1. Stop the server container.
//   2. Copy the chosen snapshot over the live DB:
//        cp <BACKUP_DIR>/server-<ts>.db   <SERVER_DB_PATH>
//        cp <BACKUP_DIR>/iptv-<ts>.db     <IPTV_DB_PATH>
//        cp <BACKUP_DIR>/media-<ts>.db    <MEDIA_DB_PATH>
//      and delete any stale -wal/-shm sidecars next to the live files.
//   3. Start the server. server_id is preserved (it lives in server.db), so
//      paired device tokens keep working.

import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { env } from '../env.js'
import { serverDb } from './serverDb.js'

/** Snapshot filename timestamp: ISO-ish, filesystem-safe (no ':'). */
function backupStamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-')
}

/**
 * Run `VACUUM INTO destPath` against an OPEN SQLite handle. VACUUM INTO
 * produces a transactionally-consistent copy and works on WAL DBs. Using the
 * already-open handle (rather than a second connection) avoids a "database is
 * locked" race against the live singleton that owns the DB.
 */
function vacuumIntoHandle(db: Database.Database, destPath: string): void {
  // VACUUM INTO requires a string-literal path; quote-escape single quotes.
  const escaped = destPath.replace(/'/g, "''")
  db.exec(`VACUUM INTO '${escaped}'`)
}

/**
 * Snapshot a DB at `srcPath` that is NOT held open by a live singleton (e.g.
 * iptv.db here, where we don't import the iptv singleton). Opens a short-lived
 * connection with a busy_timeout so a transient lock from another reader is
 * waited out rather than throwing immediately.
 */
function vacuumIntoPath(srcPath: string, destPath: string): void {
  const src = new Database(srcPath)
  try {
    src.pragma('busy_timeout = 5000')
    vacuumIntoHandle(src, destPath)
  } finally {
    src.close()
  }
}

/**
 * Open the freshly-written snapshot read-only and run PRAGMA integrity_check.
 * A VACUUM INTO copy of a subtly-corrupt source — or a snapshot truncated by a
 * full backup disk — is itself useless, but the copy still "succeeds". Verify
 * it NOW, while the prior good snapshots are still around (we throw before
 * pruning), instead of discovering the corruption at restore time. Throws on a
 * non-'ok' result or an unreadable snapshot so the caller fails the pass.
 */
function verifySnapshot(destPath: string): void {
  const snap = new Database(destPath, { readonly: true })
  try {
    const rows = snap.pragma('integrity_check') as Array<{ integrity_check: string }>
    const ok = rows.length === 1 && rows[0]?.integrity_check === 'ok'
    if (!ok) {
      const detail = rows.map((r) => r.integrity_check).join('; ').slice(0, 200)
      throw new Error(`integrity_check failed for ${path.basename(destPath)}: ${detail}`)
    }
  } finally {
    snap.close()
  }
}

/** Delete all but the newest `keep` snapshots matching `prefix-*.db`. */
function pruneSnapshots(dir: string, prefix: string, keep: number): void {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return
  }
  const snaps = entries
    .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.db'))
    .sort() // ISO timestamps sort lexicographically == chronologically
  const excess = snaps.length - keep
  for (let i = 0; i < excess; i++) {
    try {
      fs.rmSync(path.join(dir, snaps[i]), { force: true })
    } catch {
      // Best-effort prune; a leftover snapshot is harmless.
    }
  }
}

export interface BackupResult {
  dir: string
  files: string[]
  stampedAt: string
}

/**
 * Run one backup pass: snapshot server.db (always), iptv.db, and media.db (each
 * when its file exists), prune to the retention count, and stamp
 * server_state.last_backup_at.
 * Returns the snapshot paths and the stamp. Throws on snapshot failure so the
 * caller (cron wrapper) logs it — a silently-failing backup is worse than none.
 */
export function runScheduledBackup(now = new Date()): BackupResult {
  const dir = env.DB_BACKUP_DIR
  fs.mkdirSync(dir, { recursive: true })
  const stamp = backupStamp(now)
  const files: string[] = []

  // server.db — always present once the server has booted. Snapshot via the
  // LIVE handle (serverDb() owns the open WAL connection); opening a second
  // connection here would race a "database is locked" against it.
  const sdb = serverDb()
  const serverDest = path.join(dir, `server-${stamp}.db`)
  // VACUUM INTO refuses to overwrite an existing file; clear any prior
  // same-stamp snapshot (only possible on a sub-ms repeat) before writing.
  fs.rmSync(serverDest, { force: true })
  vacuumIntoHandle(sdb.raw, serverDest)
  verifySnapshot(serverDest)
  files.push(serverDest)
  pruneSnapshots(dir, 'server', env.DB_BACKUP_KEEP)

  // iptv.db — only snapshot if the live file exists (IPTV_DISABLED builds that
  // never opened it have no file to copy). We do NOT import the iptv singleton
  // here (keeps backups working on IPTV_DISABLED builds), so a short-lived
  // connection with a busy_timeout takes the snapshot.
  if (fs.existsSync(env.IPTV_DB_PATH)) {
    const iptvDest = path.join(dir, `iptv-${stamp}.db`)
    fs.rmSync(iptvDest, { force: true })
    vacuumIntoPath(env.IPTV_DB_PATH, iptvDest)
    verifySnapshot(iptvDest)
    files.push(iptvDest)
    pruneSnapshots(dir, 'iptv', env.DB_BACKUP_KEEP)
  }

  // media.db — the media-core DB, bind-mounted into the backend, is the ONLY
  // home of media_watch_state (Continue Watching, watched flags, resume
  // positions). Its live writer is the media-core container (a cross-PROCESS
  // snapshot), but VACUUM INTO over the shared WAL bind mount is still safe —
  // WAL permits concurrent readers and the busy_timeout waits out any lock. Skip
  // when the file is absent (an IPTV/media-less build never mounts it).
  if (fs.existsSync(env.MEDIA_DB_PATH)) {
    const mediaDest = path.join(dir, `media-${stamp}.db`)
    fs.rmSync(mediaDest, { force: true })
    vacuumIntoPath(env.MEDIA_DB_PATH, mediaDest)
    verifySnapshot(mediaDest)
    files.push(mediaDest)
    pruneSnapshots(dir, 'media', env.DB_BACKUP_KEEP)
  }

  // Stamp last_backup_at on server.db so the DESTRUCTIVE-migration gate sees a
  // fresh backup and a deploy carrying a destructive migration is unblocked.
  const stampedAt = now.toISOString()
  sdb.raw
    .prepare(
      `INSERT INTO server_state (key, value, ts)
       VALUES ('last_backup_at', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts`,
    )
    .run(stampedAt, stampedAt)

  return { dir, files, stampedAt }
}
