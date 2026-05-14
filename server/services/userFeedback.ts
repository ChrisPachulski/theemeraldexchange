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
// near-simultaneous mutations don't clobber each other.

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
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: FeedbackFile = {}
    for (const [sub, bucket] of Object.entries(parsed)) {
      if (typeof sub === 'string' && sub.length > 0) out[sub] = sanitizeUser(bucket)
    }
    cached = out
  } catch {
    cached = {}
  }
  return cached
}

async function persist(): Promise<void> {
  if (!cached) return
  await fs.mkdir(dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(cached, null, 2) + '\n', 'utf8')
}

function ensure(file: FeedbackFile, sub: string): UserBucket {
  if (!file[sub]) file[sub] = emptyBucket()
  return file[sub]
}

function cloneList(list: FeedbackEntry[]): FeedbackEntry[] {
  return list.map((e) => ({ ...e }))
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
async function mutate(
  sub: string,
  kind: FeedbackKind,
  tmdbId: number,
  title: string,
  next: FeedbackSignal | null,
): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    const file = await load()
    const bucket = ensure(file, sub)[kind]
    const existing =
      bucket.liked.find((e) => e.id === tmdbId) ??
      bucket.disliked.find((e) => e.id === tmdbId)
    const carryTitle = title || existing?.title || ''
    bucket.liked = bucket.liked.filter((e) => e.id !== tmdbId)
    bucket.disliked = bucket.disliked.filter((e) => e.id !== tmdbId)
    if (next === 'like') bucket.liked.push({ id: tmdbId, title: carryTitle })
    if (next === 'dislike') bucket.disliked.push({ id: tmdbId, title: carryTitle })
    await persist()
  })
  await writeQueue
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
