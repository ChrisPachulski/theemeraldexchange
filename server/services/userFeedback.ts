// Per-user feedback store. Each household member has their own likes
// (private positive signal to Claude) and dislikes (rolled into the
// household-wide rejection list so nobody re-sees a rejected title).
//
// Storage: JSON file at env.userFeedbackPath, shape
//   { [sub]: { movie: {liked: Array<{id,title}>, disliked: Array<{id,title}>},
//              tv:    {liked: Array<{id,title}>, disliked: Array<{id,title}>} } }
//
// Titles ride alongside ids so the suggestions route can render a
// "you have explicitly liked <Title>" block for Claude — bare ids are
// unactionable signal. Legacy files containing bare `number[]` arrays
// load without crash: numbers normalize to `{id, title: ''}` and
// upgrade in place on the next dot click.
//
// Writes serialize through a single in-flight promise so two
// near-simultaneous mutations don't clobber each other. Two refs to
// the chain: `op` is the raw operation returned to the caller (so
// route handlers see real persistence failures and can return 500);
// `writeQueue` is the recovery branch with `.catch` attached so a
// single failure can't poison the next call's chain. The caller
// `await`s `op` — if persist fails, the user-facing route surfaces
// the failure instead of lying with `{ ok: true }`.
//
// Snapshot-then-swap: each mutation clones the touched user's bucket
// into a `next` snapshot, persists it, then assigns `cached = next`
// only after the write succeeds. A failed persist leaves no ghost
// entry behind for a later successful write to accidentally adopt.

import { promises as fs } from 'fs'
import { dirname } from 'path'
import { env } from '../env.js'

export type FeedbackKind = 'movie' | 'tv'
export type FeedbackSignal = 'like' | 'dislike'
export type FeedbackEntry = { id: number; title: string }

type KindBucket = { liked: FeedbackEntry[]; disliked: FeedbackEntry[] }
type UserBucket = { movie: KindBucket; tv: KindBucket }
type FeedbackFile = Record<string, UserBucket>

function emptyBucket(): UserBucket {
  return {
    movie: { liked: [], disliked: [] },
    tv: { liked: [], disliked: [] },
  }
}

let filePath = env.userFeedbackPath
let cached: FeedbackFile | null = null
let writeQueue: Promise<void> = Promise.resolve()

export function _setUserFeedbackPathForTests(p: string): void {
  filePath = p
  cached = null
}

function normalizeEntry(raw: unknown): FeedbackEntry | null {
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

function normalizeList(raw: unknown): FeedbackEntry[] {
  if (!Array.isArray(raw)) return []
  const out: FeedbackEntry[] = []
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

function sanitizeBucket(raw: unknown): KindBucket {
  const r = (raw ?? {}) as Partial<{ liked: unknown; disliked: unknown }>
  return { liked: normalizeList(r.liked), disliked: normalizeList(r.disliked) }
}

function sanitizeUser(raw: unknown): UserBucket {
  const r = (raw ?? {}) as Partial<UserBucket>
  return { movie: sanitizeBucket(r.movie), tv: sanitizeBucket(r.tv) }
}

async function load(): Promise<FeedbackFile> {
  if (cached) return cached
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Legit first run.
      cached = {}
      return cached
    }
    // Surface other IO failures (permission, EIO) so the route returns
    // 500 instead of overwriting with empty state.
    throw err
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: FeedbackFile = {}
    for (const [sub, bucket] of Object.entries(parsed)) {
      if (typeof sub === 'string' && sub.length > 0) out[sub] = sanitizeUser(bucket)
    }
    cached = out
  } catch (parseErr) {
    // Corrupted file (torn write, manual edit error). Fail closed
    // rather than silently wiping every household member's likes.
    throw new Error(
      `[userFeedback] cannot parse ${filePath} (corrupted?): ${
        (parseErr as Error).message
      }`,
      { cause: parseErr },
    )
  }
  return cached
}

async function persistSnapshot(file: FeedbackFile): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true })
  // Atomic write: stage to a temp sibling, then rename(2) onto the
  // target. A crash between the writeFile and the rename leaves the
  // prior file intact — readers never see a half-written JSON that
  // would parse as garbage and trigger the "fail closed on corruption"
  // path on next boot.
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  try {
    await fs.writeFile(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8')
    await fs.rename(tmp, filePath)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

function cloneList(list: FeedbackEntry[]): FeedbackEntry[] {
  return list.map((e) => ({ ...e }))
}

function cloneUserBucket(b: UserBucket | undefined): UserBucket {
  if (!b) return emptyBucket()
  return {
    movie: { liked: cloneList(b.movie.liked), disliked: cloneList(b.movie.disliked) },
    tv: { liked: cloneList(b.tv.liked), disliked: cloneList(b.tv.disliked) },
  }
}

export async function getUserFeedback(sub: string): Promise<UserBucket> {
  const file = await load()
  const bucket = file[sub]
  if (!bucket) return emptyBucket()
  return {
    movie: { liked: cloneList(bucket.movie.liked), disliked: cloneList(bucket.movie.disliked) },
    tv: { liked: cloneList(bucket.tv.liked), disliked: cloneList(bucket.tv.disliked) },
  }
}

// Internal helper — set or clear a signal for one item, mutually
// exclusive (setting 'like' clears any existing 'dislike' and vice
// versa). Empty incoming title never overwrites a known one — preserves
// legacy entry titles while still upgrading bare-id rows.
function mutate(
  sub: string,
  kind: FeedbackKind,
  tmdbId: number,
  title: string,
  next: FeedbackSignal | null,
): Promise<void> {
  const op = writeQueue.then(async () => {
    const file = await load()
    const updatedUser = cloneUserBucket(file[sub])
    const bucket = updatedUser[kind]
    const existing =
      bucket.liked.find((e) => e.id === tmdbId) ??
      bucket.disliked.find((e) => e.id === tmdbId)
    const carryTitle = title || existing?.title || ''
    bucket.liked = bucket.liked.filter((e) => e.id !== tmdbId)
    bucket.disliked = bucket.disliked.filter((e) => e.id !== tmdbId)
    if (next === 'like') bucket.liked.push({ id: tmdbId, title: carryTitle })
    if (next === 'dislike') bucket.disliked.push({ id: tmdbId, title: carryTitle })
    // Shallow spread of `file` preserves other users by reference —
    // safe because mutate() never touches anything outside
    // `updatedUser`.
    const snapshot: FeedbackFile = { ...file, [sub]: updatedUser }
    await persistSnapshot(snapshot)
    cached = snapshot
  })
  // Recovery branch: keep the chain alive for the next caller even if
  // this op rejects. Do NOT return this — return `op` below so the
  // caller's `await` sees real failures.
  writeQueue = op.catch((err) => {
    console.error('[userFeedback] write failed:', err)
  })
  return op
}

export function setLike(
  sub: string,
  kind: FeedbackKind,
  tmdbId: number,
  title: string,
): Promise<void> {
  return mutate(sub, kind, tmdbId, title, 'like')
}

export function setDislike(
  sub: string,
  kind: FeedbackKind,
  tmdbId: number,
  title: string,
): Promise<void> {
  return mutate(sub, kind, tmdbId, title, 'dislike')
}

export function clearFeedback(sub: string, kind: FeedbackKind, tmdbId: number): Promise<void> {
  return mutate(sub, kind, tmdbId, '', null)
}

// Title-only backfill. Updates the title on an EXISTING `liked` row;
// never adds a missing row and never touches the `disliked` list.
// Used by suggestions.ts to fill in TMDB titles on legacy (bare-id)
// likes without racing /api/feedback — if the user cleared or flipped
// the signal while TMDB was resolving, the row is gone (or now in
// `disliked`), and setLike would happily re-add the like, undoing the
// caller's action. This helper short-circuits to a no-op instead.
export function updateLikedTitleIfPresent(
  sub: string,
  kind: FeedbackKind,
  tmdbId: number,
  title: string,
): Promise<void> {
  const op = writeQueue.then(async () => {
    if (!title) return
    const file = await load()
    const bucket = file[sub]?.[kind]
    const existing = bucket?.liked.find((e) => e.id === tmdbId)
    if (!existing) return // cleared or flipped by a concurrent op
    if (existing.title === title) return // already current
    const updatedUser = cloneUserBucket(file[sub])
    const target = updatedUser[kind].liked.find((e) => e.id === tmdbId)!
    target.title = title
    const snapshot: FeedbackFile = { ...file, [sub]: updatedUser }
    await persistSnapshot(snapshot)
    cached = snapshot
  })
  writeQueue = op.catch((err) => {
    console.error('[userFeedback] title-only update failed:', err)
  })
  return op
}

// True when at least one *other* user (sub !== caller) has this title
// disliked. Used by the route layer to decide whether removing a
// dislike from the caller should also remove the title from the
// household rejection list — only safe to remove from rejections when
// no one else is still dissenting.
export async function anotherUserDislikes(
  callerSub: string,
  kind: FeedbackKind,
  tmdbId: number,
): Promise<boolean> {
  const file = await load()
  for (const [sub, bucket] of Object.entries(file)) {
    if (sub === callerSub) continue
    if (bucket[kind].disliked.some((e) => e.id === tmdbId)) return true
  }
  return false
}
