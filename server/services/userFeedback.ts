// Per-user feedback store. Each household member has their own likes
// (private positive signal to Claude) and dislikes (rolled into the
// household-wide rejection list so nobody re-sees a rejected title).
//
// Storage: JSON file at env.userFeedbackPath, shape
//   { [sub]: { movie: {liked: number[], disliked: number[]},
//              tv:    {liked: number[], disliked: number[]} } }
//
// Arrays (not Sets) so the file is human-readable / greppable on the
// NAS. Writes serialize through a single in-flight promise so two
// near-simultaneous mutations don't clobber each other. Mirrors the
// rejections.ts pattern.

import { promises as fs } from 'fs'
import { dirname } from 'path'
import { env } from '../env.js'

export type FeedbackKind = 'movie' | 'tv'
export type FeedbackSignal = 'like' | 'dislike'

type KindBucket = { liked: number[]; disliked: number[] }
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

function sanitizeIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((n): n is number => Number.isInteger(n) && (n as number) > 0)
}

function sanitizeBucket(raw: unknown): KindBucket {
  const r = (raw ?? {}) as Partial<KindBucket>
  return { liked: sanitizeIds(r.liked), disliked: sanitizeIds(r.disliked) }
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

export async function getUserFeedback(sub: string): Promise<UserBucket> {
  const file = await load()
  const bucket = file[sub]
  if (!bucket) return emptyBucket()
  return {
    movie: { liked: [...bucket.movie.liked], disliked: [...bucket.movie.disliked] },
    tv: { liked: [...bucket.tv.liked], disliked: [...bucket.tv.disliked] },
  }
}

// Internal helper — set or clear a signal for one item, mutually
// exclusive (setting 'like' clears any existing 'dislike' and vice
// versa). Returns the new state for the item.
async function mutate(
  sub: string,
  kind: FeedbackKind,
  tmdbId: number,
  next: FeedbackSignal | null,
): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    const file = await load()
    const bucket = ensure(file, sub)[kind]
    bucket.liked = bucket.liked.filter((id) => id !== tmdbId)
    bucket.disliked = bucket.disliked.filter((id) => id !== tmdbId)
    if (next === 'like') bucket.liked.push(tmdbId)
    if (next === 'dislike') bucket.disliked.push(tmdbId)
    await persist()
  })
  await writeQueue
}

export function setLike(sub: string, kind: FeedbackKind, tmdbId: number): Promise<void> {
  return mutate(sub, kind, tmdbId, 'like')
}

export function setDislike(sub: string, kind: FeedbackKind, tmdbId: number): Promise<void> {
  return mutate(sub, kind, tmdbId, 'dislike')
}

export function clearFeedback(sub: string, kind: FeedbackKind, tmdbId: number): Promise<void> {
  return mutate(sub, kind, tmdbId, null)
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
    if (bucket[kind].disliked.includes(tmdbId)) return true
  }
  return false
}
