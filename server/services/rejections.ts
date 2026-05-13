// Persistent reject list — TMDB ids the household has explicitly
// dismissed from suggestions. Read on every suggestions call (both as
// a post-filter and as part of the Claude prompt), written when a
// household member clicks the ✕ on a suggestion card.
//
// Storage: one JSON file at env.rejectionsPath, structure:
//   { movie: number[], tv: number[] }
// We keep arrays (not Sets) so the file is human-readable / greppable
// on the NAS. In memory we hydrate to Set<number> for O(1) lookup.
//
// Writes are serialized through a single in-flight promise so two
// near-simultaneous dismisses can't clobber each other.

import { promises as fs } from 'fs'
import { dirname } from 'path'
import { env } from '../env.js'

export type RejectionsKind = 'movie' | 'tv'

type RejectionsFile = {
  movie: number[]
  tv: number[]
}

const EMPTY: RejectionsFile = { movie: [], tv: [] }

let filePath = env.rejectionsPath

export function _setRejectionsPathForTests(p: string): void {
  filePath = p
  cached = null
}

// In-memory cache + dirty flag. Hydrated on first read; written
// through on each mutation. Tests reset via _setRejectionsPathForTests.
let cached: RejectionsFile | null = null
let writeQueue: Promise<void> = Promise.resolve()

async function load(): Promise<RejectionsFile> {
  if (cached) return cached
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<RejectionsFile>
    cached = {
      movie: Array.isArray(parsed.movie) ? parsed.movie.filter((n): n is number => Number.isInteger(n) && n > 0) : [],
      tv: Array.isArray(parsed.tv) ? parsed.tv.filter((n): n is number => Number.isInteger(n) && n > 0) : [],
    }
  } catch {
    // Missing file or malformed JSON — start fresh.
    cached = { ...EMPTY, movie: [], tv: [] }
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
  return { movie: [...file.movie], tv: [...file.tv] }
}

export async function addRejection(kind: RejectionsKind, tmdbId: number): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    const file = await load()
    if (!file[kind].includes(tmdbId)) {
      file[kind].push(tmdbId)
      await persist()
    }
  })
  await writeQueue
}

export async function removeRejection(kind: RejectionsKind, tmdbId: number): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    const file = await load()
    const before = file[kind].length
    file[kind] = file[kind].filter((id) => id !== tmdbId)
    if (file[kind].length !== before) await persist()
  })
  await writeQueue
}
