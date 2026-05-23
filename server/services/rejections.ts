// Persistent reject list — TMDB ids the household has explicitly
// dismissed from suggestions. Read on every suggestions call (both as
// a post-filter and as part of the Claude prompt), written when a
// household member clicks the ✕ on a suggestion card.
//
// Storage: one JSON file at env.rejectionsPath, structure:
//   { movie: Array<{id, title}>, tv: Array<{id, title}> }
// Titles ride alongside ids so the suggestions route can show Claude
// "never suggest <Title (Year)>" — bare ids are unactionable signal
// for the model. Legacy files containing bare `number[]` arrays load
// without crash: numbers normalize to `{id, title: ''}` and upgrade
// in place on the next dot click.
//
// Writes are serialized through a single in-flight promise so two
// near-simultaneous dismisses can't clobber each other. Two refs to
// the chain: `op` is the raw operation returned to the caller (so
// route handlers see real persistence failures and can return 500);
// `writeQueue` is the recovery branch with `.catch` attached so a
// single failure can't poison the next call's chain. The caller
// `await`s `op` — if persist fails, the user-facing route surfaces
// the failure instead of lying with `{ ok: true }`.
//
// Snapshot-then-swap: each mutation clones `cached` into a `next`
// object, persists the snapshot, and only assigns `cached = next`
// after the write succeeds. A failed persist leaves no ghost
// entry behind for a later successful write to accidentally adopt.

import { promises as fs } from 'fs'
import { dirname } from 'path'
import { env } from '../env.js'

export type RejectionsKind = 'movie' | 'tv'
export type RejectionEntry = { id: number; title: string }

type RejectionsFile = {
  movie: RejectionEntry[]
  tv: RejectionEntry[]
}

let filePath = env.rejectionsPath

export function _setRejectionsPathForTests(p: string): void {
  filePath = p
  cached = null
}

let cached: RejectionsFile | null = null
let writeQueue: Promise<void> = Promise.resolve()

function normalizeEntry(raw: unknown): RejectionEntry | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
    return { id: raw, title: '' }
  }
  if (raw && typeof raw === 'object') {
    const o = raw as { id?: unknown; title?: unknown }
    if (typeof o.id === 'number' && Number.isInteger(o.id) && o.id > 0) {
      return { id: o.id, title: typeof o.title === 'string' ? o.title : '' }
    }
  }
  return null
}

function normalizeList(raw: unknown): RejectionEntry[] {
  if (!Array.isArray(raw)) return []
  const out: RejectionEntry[] = []
  const seen = new Set<number>()
  for (const r of raw) {
    const e = normalizeEntry(r)
    if (e && !seen.has(e.id)) {
      seen.add(e.id)
      out.push(e)
    }
  }
  return out
}

async function load(): Promise<RejectionsFile> {
  if (cached) return cached
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Legit first run — start empty. Any subsequent persistSnapshot
      // creates the file atomically.
      cached = { movie: [], tv: [] }
      return cached
    }
    // Permission denied, EIO, EISDIR — surface so the route returns 500
    // instead of silently overwriting the file with empty state.
    throw err
  }
  try {
    const parsed = JSON.parse(raw) as Partial<{ movie: unknown; tv: unknown }>
    cached = {
      movie: normalizeList(parsed.movie),
      tv: normalizeList(parsed.tv),
    }
  } catch (parseErr) {
    // File exists but doesn't parse — likely a torn write from a prior
    // crash. Fail closed: refuse to load so the next mutation can't
    // overwrite real data with the empty defaults. Operator must
    // inspect / restore the file.
    throw new Error(
      `[rejections] cannot parse ${filePath} (corrupted?): ${
        (parseErr as Error).message
      }`,
      { cause: parseErr },
    )
  }
  return cached
}

async function persistSnapshot(file: RejectionsFile): Promise<void> {
  const serialized = JSON.stringify(file, null, 2)
  await fs.mkdir(dirname(filePath), { recursive: true })
  // Atomic write: stage to a temp sibling and rename onto the target.
  // rename(2) is atomic within a filesystem, so readers either see the
  // old file (full) or the new file (full) — never a half-written one.
  // Prevents the previous failure mode where a crash mid-writeFile left
  // a truncated JSON that load() would then read as empty and the
  // next mutation would persist as truth.
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  try {
    await fs.writeFile(tmp, serialized + '\n', 'utf8')
    await fs.rename(tmp, filePath)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

function cloneFile(file: RejectionsFile): RejectionsFile {
  return {
    movie: file.movie.map((e) => ({ ...e })),
    tv: file.tv.map((e) => ({ ...e })),
  }
}

export async function getRejections(): Promise<RejectionsFile> {
  const file = await load()
  return {
    movie: file.movie.map((e) => ({ ...e })),
    tv: file.tv.map((e) => ({ ...e })),
  }
}

// Id-only view for the post-filter. The suggestions route only needs
// the id set to drop matches from Claude's response — keeping the
// filter cheap and decoupled from title presence.
export async function getRejectionIds(kind: RejectionsKind): Promise<Set<number>> {
  const file = await load()
  return new Set(file[kind].map((e) => e.id))
}

export function addRejection(
  kind: RejectionsKind,
  tmdbId: number,
  title: string,
): Promise<void> {
  const op = writeQueue.then(async () => {
    const file = await load()
    const existing = file[kind].find((e) => e.id === tmdbId)
    // No-op fast paths — no persist, no cache swap.
    if (existing && (!title || existing.title === title)) return
    const next = cloneFile(file)
    if (!existing) {
      next[kind].push({ id: tmdbId, title })
    } else {
      // Upgrade legacy / stale entries in place when a fresh title
      // arrives. Empty incoming title never overwrites a known one
      // (filtered by the fast-path above).
      const target = next[kind].find((e) => e.id === tmdbId)!
      target.title = title
    }
    await persistSnapshot(next)
    cached = next
  })
  // Recovery branch: keep the chain alive for the next caller even if
  // this op rejects. Do NOT return this — return `op` below so the
  // caller's `await` sees real failures.
  writeQueue = op.catch((err) => {
    console.error('[rejections] write failed:', err)
  })
  return op
}

export function removeRejection(kind: RejectionsKind, tmdbId: number): Promise<void> {
  const op = writeQueue.then(async () => {
    const file = await load()
    if (!file[kind].some((e) => e.id === tmdbId)) return // no-op
    const next = cloneFile(file)
    next[kind] = next[kind].filter((e) => e.id !== tmdbId)
    await persistSnapshot(next)
    cached = next
  })
  writeQueue = op.catch((err) => {
    console.error('[rejections] write failed:', err)
  })
  return op
}
