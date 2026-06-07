// Persistent grab-event log. Append-only JSONL on disk so the admin can
// see *why* a grab failed instead of having to SSH to the NAS and tail
// container stdout. Every silent-failure point in grabBestUnderCap /
// grabTvUnderCap writes one event here; the admin panel reads from the
// end of the file via a chunked tail-reader.
//
// Single-rotation at ROTATE_AT_BYTES — when the live file crosses the
// threshold on the next append, it's renamed to `.1` (overwriting any
// previous `.1`). At household traffic this gives months of retention
// per file. If we ever need richer queries, swap this module for SQLite
// without touching callers.
//
// Writes are serialized via a single in-flight promise so two
// near-simultaneous appends from different request handlers don't
// interleave bytes mid-line.

import { promises as fs } from 'fs'
import { dirname } from 'path'
import { env } from '../env.js'

export type GrabEventType =
  | 'grab_started'
  | 'search_failed'
  | 'no_releases'
  // Indexers returned releases but Radarr/Sonarr rejected every one for
  // reasons unrelated to our size cap (unparseable name, title mismatch,
  // unwanted quality). The cap never applied — treated like no_releases
  // (kept monitored), NOT rolled back like all_rejected_by_cap.
  | 'no_matching_releases'
  | 'all_rejected_by_cap'
  | 'all_rejected_by_profile'
  | 'planned_size_exceeds_free_space'
  | 'grab_succeeded'
  | 'grab_failed'

export type GrabEvent = {
  ts: string
  app: 'sonarr' | 'radarr'
  itemId: number
  // Subject (user) that triggered the grab, when known. Lets /by-item be
  // scoped to the caller instead of relying on the guessable itemId as a
  // weak capability, and attributes events for abuse investigation.
  // Optional so older rows (written before attribution) still parse.
  sub?: string
  type: GrabEventType
  title?: string
  capGb?: number
  status?: number
  scanned?: number
  eligible?: number
  plannedBytes?: number
  freeBytes?: number
  thresholdBytes?: number
  release?: {
    title: string
    sizeBytes: number
    qualityWeight: number
    seasonNumber?: number
  }
  error?: string
}

const ROTATE_AT_BYTES = 5 * 1024 * 1024
const CHUNK_SIZE = 64 * 1024

let logPath = env.grabLogPath

// Test seam — vitest can repoint the log at a tmpdir without going
// through process.env shenanigans.
export function _setGrabLogPathForTests(p: string): void {
  logPath = p
}

let writeQueue: Promise<void> = Promise.resolve()

export function appendGrabEvent(e: Omit<GrabEvent, 'ts'>): Promise<void> {
  const event: GrabEvent = { ts: new Date().toISOString(), ...e }
  const line = JSON.stringify(event) + '\n'
  const op = writeQueue.then(() => writeLine(line))
  writeQueue = op.catch((err) => {
    console.error('[grabLog] append failed:', err)
  })
  return op
}

async function writeLine(line: string): Promise<void> {
  await fs.mkdir(dirname(logPath), { recursive: true })
  let size = 0
  try {
    size = (await fs.stat(logPath)).size
  } catch {
    // missing — treat as size 0
  }
  if (size > ROTATE_AT_BYTES) {
    await fs.rename(logPath, logPath + '.1').catch(() => {
      // best-effort; if rotation fails we just keep appending
    })
  }
  await fs.appendFile(logPath, line, { encoding: 'utf8' })
}

// Read the last `limit` newline-terminated chunks from `path`, newest
// first. Returns raw string lines (parsing happens in parseEvents). On
// ENOENT returns []. Reads backward in 64 KB blocks so we don't load
// the whole file when callers want just the recent tail.
async function readTail(path: string, limit: number): Promise<string[]> {
  let fd
  try {
    fd = await fs.open(path, 'r')
  } catch {
    return []
  }
  try {
    const stat = await fd.stat()
    let pos = stat.size
    let leftover = ''
    const lines: string[] = []
    while (pos > 0 && lines.length < limit) {
      const readSize = Math.min(CHUNK_SIZE, pos)
      pos -= readSize
      const buf = Buffer.alloc(readSize)
      await fd.read(buf, 0, readSize, pos)
      // Earlier chunk's tail abuts the previous (later) chunk's head, so
      // the leftover-partial-line goes on the END of the new buffer.
      const combined = buf.toString('utf8') + leftover
      const pieces = combined.split('\n')
      // pieces[0] is potentially partial — it was the start of this
      // (earlier) chunk. Keep it as leftover for the next iteration.
      leftover = pieces[0]
      // Walk pieces[1..] right-to-left: those are complete lines, newest
      // last in the chunk. Skip empty strings (trailing newlines).
      for (let i = pieces.length - 1; i >= 1 && lines.length < limit; i--) {
        const piece = pieces[i]
        if (piece.length > 0) lines.push(piece)
      }
    }
    if (pos === 0 && leftover.length > 0 && lines.length < limit) {
      lines.push(leftover)
    }
    return lines.slice(0, limit)
  } finally {
    await fd.close()
  }
}

function parseEvents(lines: string[]): GrabEvent[] {
  const out: GrabEvent[] = []
  for (const l of lines) {
    try {
      out.push(JSON.parse(l) as GrabEvent)
    } catch {
      // malformed line — partial write, corruption, manual edit. Drop
      // silently rather than blowing up the admin panel for one bad row.
    }
  }
  return out
}

export async function readRecentGrabEvents(limit: number): Promise<GrabEvent[]> {
  // Wait for any in-flight writes so a just-appended event is visible.
  await writeQueue
  const primary = parseEvents(await readTail(logPath, limit))
  if (primary.length >= limit) return primary
  const rotated = parseEvents(await readTail(logPath + '.1', limit - primary.length))
  return [...primary, ...rotated]
}

export async function readEventsForItem(
  app: 'sonarr' | 'radarr',
  itemId: number,
  limit: number,
  // When provided, scope results to events the caller triggered so the
  // guessable itemId can no longer be enumerated to read other members'
  // grab history. Legacy events written before attribution (no `sub`)
  // remain visible so pre-existing household history isn't lost; once
  // attribution has run for a while this can be tightened to strict
  // equality.
  sub?: string,
): Promise<GrabEvent[]> {
  await writeQueue
  // Scan a wider window than `limit` since events for one item are a
  // small fraction of the total stream. 50× is a heuristic; in practice
  // an add produces 2-4 events and the panel polls within minutes.
  const SCAN_WINDOW = Math.max(500, limit * 50)
  const primary = parseEvents(await readTail(logPath, SCAN_WINDOW))
  const remaining = Math.max(0, SCAN_WINDOW - primary.length)
  const rotated = remaining > 0 ? parseEvents(await readTail(logPath + '.1', remaining)) : []
  return [...primary, ...rotated]
    .filter((e) => e.app === app && e.itemId === itemId)
    .filter((e) => sub === undefined || e.sub === undefined || e.sub === sub)
    .slice(0, limit)
}
