// /api/ratings — IMDb / Rotten Tomatoes / Metacritic scores from OMDb, keyed
// by IMDb id, batched and cached in server.db (title_ratings, migration 0009).
//
// Sonarr only carries one TVDB score per series and Radarr's rottenTomatoes
// field is usually empty, so the library cards ask here for a whole page of
// ids at once. Every OMDb answer — including "not found" — is cached for
// RATINGS_TTL_MS so a 300-title library costs at most one OMDb call per title
// per week against the free tier's 1000/day.

import { Hono } from 'hono'
import { requireAuth, type Env } from '../middleware/auth.js'
import { env } from '../env.js'
import { serverDb } from '../services/serverDb.js'
import { fetchWithTimeout, WAN_TIMEOUT_MS } from '../services/upstream.js'

export const ratings = new Hono<Env>()
ratings.use('*', requireAuth)

export type TitleRatings = { imdb: number | null; rt: number | null; metacritic: number | null }

const OMDB_BASE = 'https://www.omdbapi.com/'
export const RATINGS_TTL_MS = 7 * 24 * 60 * 60 * 1000
// One library page is well under this; anything larger is a client bug or abuse.
const MAX_IDS_PER_REQUEST = 60
// ponytail: fixed fan-out; OMDb has no documented concurrency limit but 4 keeps
// a cold 300-title load from tripping WAN timeouts.
const OMDB_CONCURRENCY = 4

const IMDB_ID = /^tt\d{5,10}$/

type OmdbBody = {
  Response?: 'True' | 'False'
  imdbRating?: string
  Metascore?: string
  Ratings?: Array<{ Source: string; Value: string }>
}

/** Pure projection of an OMDb payload onto our three scores; 'N/A' → null. */
export function parseOmdb(body: OmdbBody): TitleRatings {
  const num = (s: string | undefined) => {
    const n = Number.parseFloat(s ?? '')
    return Number.isFinite(n) ? n : null
  }
  const rtRaw = body.Ratings?.find((r) => r.Source === 'Rotten Tomatoes')?.Value
  return {
    imdb: num(body.imdbRating),
    rt: rtRaw ? num(rtRaw.replace('%', '')) : null,
    metacritic: num(body.Metascore),
  }
}

type Row = { imdb_id: string; imdb: number | null; rt: number | null; metacritic: number | null; fetched_at: number }

function readCached(ids: string[], now: number): Map<string, TitleRatings> {
  const db = serverDb().raw
  const stmt = db.prepare(`SELECT imdb_id, imdb, rt, metacritic, fetched_at FROM title_ratings WHERE imdb_id = ?`)
  const out = new Map<string, TitleRatings>()
  for (const id of ids) {
    const row = stmt.get(id) as Row | undefined
    if (row && now - row.fetched_at < RATINGS_TTL_MS) {
      out.set(id, { imdb: row.imdb, rt: row.rt, metacritic: row.metacritic })
    }
  }
  return out
}

function writeCached(id: string, r: TitleRatings, now: number): void {
  serverDb()
    .raw.prepare(
      `INSERT INTO title_ratings (imdb_id, imdb, rt, metacritic, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(imdb_id) DO UPDATE SET
         imdb = excluded.imdb, rt = excluded.rt,
         metacritic = excluded.metacritic, fetched_at = excluded.fetched_at`,
    )
    .run(id, r.imdb, r.rt, r.metacritic, now)
}

async function fetchOmdb(id: string): Promise<TitleRatings | null> {
  const url = new URL(OMDB_BASE)
  url.searchParams.set('apikey', env.omdbApiKey ?? '')
  url.searchParams.set('i', id)
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, WAN_TIMEOUT_MS, 'omdb')
  if (!res.ok) return null
  const body = (await res.json()) as OmdbBody
  // "Response: False" (unknown id) is a real answer worth caching as all-null;
  // a transport/quota failure above is not, so it stays uncached and retries.
  return parseOmdb(body)
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// GET /api/ratings?ids=tt0903747,tt1520211
// → { "tt0903747": { imdb: 9.5, rt: 96, metacritic: 87 }, ... }
// Ids OMDb can't resolve map to all-null scores; ids that failed in transit
// are simply absent so the client can retry them on the next page load.
ratings.get('/', async (c) => {
  if (!env.omdbApiKey) return c.json({ error: 'omdb_not_configured' }, 503)
  const ids = [...new Set((c.req.query('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean))]
  if (ids.length === 0 || ids.length > MAX_IDS_PER_REQUEST || !ids.every((id) => IMDB_ID.test(id))) {
    return c.json({ error: 'invalid_ids' }, 400)
  }
  const now = Date.now()
  const result = readCached(ids, now)
  const missing = ids.filter((id) => !result.has(id))
  const fetched = await mapLimit(missing, OMDB_CONCURRENCY, fetchOmdb)
  missing.forEach((id, i) => {
    const r = fetched[i]
    if (!r) return
    writeCached(id, r, now)
    result.set(id, r)
  })
  return c.json(Object.fromEntries(result))
})
