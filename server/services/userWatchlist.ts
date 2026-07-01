// Per-user watchlist store. Each household member keeps their own
// "want to watch" list, split by kind so a movie and a series can share
// the same numeric id without colliding.
//
// Storage: JSON file at env.userWatchlistPath, shape
//   { [sub]: { movie: WatchlistEntry[], tv: WatchlistEntry[] } }
// where WatchlistEntry = { id, title, poster_path?, added_at }. id is
// the tmdbId for movies and the tvdbId for series (the same id space the
// rest of the app keys media on). added_at is an ISO-8601 timestamp so
// the route can render newest-first without a separate ordering column.
//
// Writes serialize through a single in-flight promise so two
// near-simultaneous mutations don't clobber each other — the same
// pattern userFeedback/rejections use. Two refs to the chain: `op` is
// the raw operation returned to the caller (so route handlers see real
// persistence failures and can 500); `writeQueue` is the recovery
// branch with `.catch` attached so a single failure can't poison the
// next call's chain. The caller awaits `op`.
//
// Snapshot-then-swap: each mutation clones the touched user's bucket
// into a `next` snapshot, persists it, then assigns `cached = next`
// only after the write succeeds. A failed persist leaves no ghost entry
// behind for a later successful write to accidentally adopt.

import { promises as fs } from 'fs'
import { dirname } from 'path'
import { env } from '../env.js'

export type WatchlistKind = 'movie' | 'tv'

export type WatchlistEntry = {
  id: number
  title: string
  poster_path?: string
  added_at: string
}

type UserBucket = { movie: WatchlistEntry[]; tv: WatchlistEntry[] }
type WatchlistFile = Record<string, UserBucket>

// Titles and poster paths ride into JSON only — never into an LLM prompt
// — but strip C0 controls + DEL anyway so a torn line can't corrupt the
// on-disk structure, and cap length so a hostile client can't bloat the
// file. 512 mirrors the route-layer bound.
const MAX_STR_LEN = 512

function sanitizeStr(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\x00-\x1f\x7f]/g, ' ')
  return stripped.replace(/\s+/g, ' ').trim().slice(0, MAX_STR_LEN)
}

function emptyBucket(): UserBucket {
  return { movie: [], tv: [] }
}

// Coerce a persisted row into a valid WatchlistEntry, or null when the id
// is missing/invalid. Sanitizing on READ defends against hand-edited or
// legacy files. Cheap and idempotent.
function normalizeEntry(raw: unknown): WatchlistEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as { id?: unknown; title?: unknown; poster_path?: unknown; added_at?: unknown }
  if (typeof o.id !== 'number' || !Number.isSafeInteger(o.id) || o.id <= 0) return null
  const entry: WatchlistEntry = {
    id: o.id,
    title: sanitizeStr(o.title),
    added_at: typeof o.added_at === 'string' && o.added_at ? o.added_at : new Date(0).toISOString(),
  }
  const poster = sanitizeStr(o.poster_path)
  if (poster) entry.poster_path = poster
  return entry
}

function normalizeList(raw: unknown): WatchlistEntry[] {
  if (!Array.isArray(raw)) return []
  const out: WatchlistEntry[] = []
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

function sanitizeUser(raw: unknown): UserBucket {
  const r = (raw ?? {}) as Partial<{ movie: unknown; tv: unknown }>
  return { movie: normalizeList(r.movie), tv: normalizeList(r.tv) }
}

let filePath = env.userWatchlistPath
let cached: WatchlistFile | null = null
let writeQueue: Promise<void> = Promise.resolve()

export function _setUserWatchlistPathForTests(p: string): void {
  filePath = p
  cached = null
}

async function load(): Promise<WatchlistFile> {
  if (cached) return cached
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      cached = {}
      return cached
    }
    // Surface other IO failures (permission, EIO) so the route returns
    // 500 instead of overwriting with empty state.
    throw err
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: WatchlistFile = {}
    for (const [sub, bucket] of Object.entries(parsed)) {
      if (typeof sub === 'string' && sub.length > 0) out[sub] = sanitizeUser(bucket)
    }
    cached = out
  } catch (parseErr) {
    // Corrupted file (torn write, manual edit error). Fail closed rather
    // than silently wiping every member's watchlist.
    throw new Error(
      `[userWatchlist] cannot parse ${filePath} (corrupted?): ${(parseErr as Error).message}`,
      { cause: parseErr },
    )
  }
  return cached
}

async function persistSnapshot(file: WatchlistFile): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true })
  // Atomic write: stage to a temp sibling, then rename(2) onto the
  // target so a crash mid-write leaves the prior file intact.
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  try {
    await fs.writeFile(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8')
    await fs.rename(tmp, filePath)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

function cloneList(list: WatchlistEntry[]): WatchlistEntry[] {
  return list.map((e) => ({ ...e }))
}

function cloneUserBucket(b: UserBucket | undefined): UserBucket {
  if (!b) return emptyBucket()
  return { movie: cloneList(b.movie), tv: cloneList(b.tv) }
}

export async function getWatchlist(sub: string): Promise<UserBucket> {
  const file = await load()
  return cloneUserBucket(file[sub])
}

// Upsert one item. Idempotent: re-adding an existing id updates its title
// and poster_path in place but PRESERVES the original added_at, so the
// ordering stays stable and a repeated PUT with the same payload is a
// true no-op on the persisted shape.
export function upsertWatchlist(
  sub: string,
  kind: WatchlistKind,
  input: { id: number; title: string; poster_path?: string },
): Promise<void> {
  const title = sanitizeStr(input.title)
  const poster = input.poster_path !== undefined ? sanitizeStr(input.poster_path) : undefined
  const op = writeQueue.then(async () => {
    const file = await load()
    const updatedUser = cloneUserBucket(file[sub])
    const list = updatedUser[kind]
    const existing = list.find((e) => e.id === input.id)
    if (existing) {
      existing.title = title
      if (poster) existing.poster_path = poster
      else delete existing.poster_path
    } else {
      const entry: WatchlistEntry = { id: input.id, title, added_at: new Date().toISOString() }
      if (poster) entry.poster_path = poster
      list.push(entry)
    }
    const snapshot: WatchlistFile = { ...file, [sub]: updatedUser }
    await persistSnapshot(snapshot)
    cached = snapshot
  })
  writeQueue = op.catch((err) => {
    console.error('[userWatchlist] write failed:', err)
  })
  return op
}

export function removeWatchlist(sub: string, kind: WatchlistKind, id: number): Promise<void> {
  const op = writeQueue.then(async () => {
    const file = await load()
    const current = file[sub]
    if (!current || !current[kind].some((e) => e.id === id)) return // no-op
    const updatedUser = cloneUserBucket(current)
    updatedUser[kind] = updatedUser[kind].filter((e) => e.id !== id)
    const snapshot: WatchlistFile = { ...file, [sub]: updatedUser }
    await persistSnapshot(snapshot)
    cached = snapshot
  })
  writeQueue = op.catch((err) => {
    console.error('[userWatchlist] write failed:', err)
  })
  return op
}
