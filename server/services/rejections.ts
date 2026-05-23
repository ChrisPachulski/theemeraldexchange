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
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<{ movie: unknown; tv: unknown }>
    cached = {
      movie: normalizeList(parsed.movie),
      tv: normalizeList(parsed.tv),
    }
  } catch {
    cached = { movie: [], tv: [] }
  }
  return cached
}

async function persist(): Promise<void> {
  if (!cached) return
  const snapshot = JSON.stringify(cached, null, 2)
  await fs.mkdir(dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, snapshot + '\n', 'utf8')
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
    if (!existing) {
      file[kind].push({ id: tmdbId, title })
      await persist()
    } else if (title && existing.title !== title) {
      // Upgrade legacy / stale entries in place when a fresh title
      // arrives. Empty incoming title never overwrites a known one.
      existing.title = title
      await persist()
    }
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
    const before = file[kind].length
    file[kind] = file[kind].filter((e) => e.id !== tmdbId)
    if (file[kind].length !== before) await persist()
  })
  writeQueue = op.catch((err) => {
    console.error('[rejections] write failed:', err)
  })
  return op
}
