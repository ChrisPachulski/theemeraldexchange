// /api/ratings — IMDb / Rotten Tomatoes (Tomatometer + Popcornmeter) /
// Metacritic scores keyed by IMDb id, cached in server.db (title_ratings).
//
// Sources, per title:
//   1. OMDb (OMDB_API_KEY) — IMDb rating, Metacritic, and occasionally an RT
//      critic score.
//   2. Wikidata SPARQL (batched) — IMDb id (P345) → Rotten Tomatoes id
//      (P1258, e.g. "tv/breaking_bad").
//   3. rottentomatoes.com page — criticsScore + audienceScore from the page's
//      embedded JSON. RT has no public API; OMDb only mirrors a minority of
//      TV series and never the audience score, which is why we go to the page.
//
// Every answer, including "not found", is cached for RATINGS_TTL_MS so a
// 300-title library costs each upstream once a week. A request returns what
// is cached right away plus whatever the fill worker completes within
// SYNC_WAIT_MS (enough for a modal or a search page); anything still missing
// is listed in `pending` and the client polls until it is empty.

import { Hono } from 'hono'
import { requireAuth, type Env } from '../middleware/auth.js'
import { env } from '../env.js'
import { serverDb } from '../services/serverDb.js'
import { fetchWithTimeout, WAN_TIMEOUT_MS } from '../services/upstream.js'

export const ratings = new Hono<Env>()
ratings.use('*', requireAuth)

export type TitleRatings = {
  imdb: number | null
  rt: number | null
  rtAudience: number | null
  metacritic: number | null
}

const OMDB_BASE = 'https://www.omdbapi.com/'
const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql'
const RT_BASE = 'https://www.rottentomatoes.com/'
// RT serves its full page (scores included) to a browser UA; Wikidata asks
// for an identifying UA in its etiquette policy.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const WIKIDATA_UA = 'EmeraldExchange/1.0 (self-hosted media library; ratings enrichment)'

export const RATINGS_TTL_MS = 7 * 24 * 60 * 60 * 1000
// One library page is well under this; anything larger is a client bug or abuse.
const MAX_IDS_PER_REQUEST = 60
// ponytail: fixed fan-out against RT/OMDb; 3 keeps a cold 300-title fill polite
// (~2 min) without tripping WAN timeouts.
const FILL_CONCURRENCY = 3
const SYNC_WAIT_MS = 6_000

const IMDB_ID = /^tt\d{5,10}$/
const RT_SLUG = /^(m|tv)\/[a-z0-9_-]+$/

// ── OMDb ─────────────────────────────────────────────────────────────────────

type OmdbBody = {
  Response?: 'True' | 'False'
  imdbRating?: string
  Metascore?: string
  Ratings?: Array<{ Source: string; Value: string }>
}

const num = (s: string | undefined | null): number | null => {
  const n = Number.parseFloat(s ?? '')
  return Number.isFinite(n) ? n : null
}

/** Pure projection of an OMDb payload onto our scores; 'N/A' → null. */
export function parseOmdb(body: OmdbBody): TitleRatings {
  const rtRaw = body.Ratings?.find((r) => r.Source === 'Rotten Tomatoes')?.Value
  return {
    imdb: num(body.imdbRating),
    rt: rtRaw ? num(rtRaw.replace('%', '')) : null,
    rtAudience: null,
    metacritic: num(body.Metascore),
  }
}

async function fetchOmdb(id: string): Promise<TitleRatings | null> {
  if (!env.omdbApiKey) return { imdb: null, rt: null, rtAudience: null, metacritic: null }
  const url = new URL(OMDB_BASE)
  url.searchParams.set('apikey', env.omdbApiKey)
  url.searchParams.set('i', id)
  try {
    const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, WAN_TIMEOUT_MS, 'omdb')
    if (!res.ok) return null
    return parseOmdb((await res.json()) as OmdbBody)
  } catch {
    return null
  }
}

// ── Wikidata: IMDb id → RT slug ──────────────────────────────────────────────

export async function lookupRtSlugs(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  const values = ids.map((id) => `"${id}"`).join(' ')
  const query = `SELECT ?imdb ?rt WHERE { VALUES ?imdb { ${values} } ?item wdt:P345 ?imdb . ?item wdt:P1258 ?rt }`
  const url = new URL(WIKIDATA_SPARQL)
  url.searchParams.set('format', 'json')
  url.searchParams.set('query', query)
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { Accept: 'application/json', 'User-Agent': WIKIDATA_UA } },
      WAN_TIMEOUT_MS,
      'wikidata',
    )
    if (!res.ok) return out
    const data = (await res.json()) as { results?: { bindings?: Array<{ imdb: { value: string }; rt: { value: string } }> } }
    for (const b of data.results?.bindings ?? []) {
      const slug = b.rt?.value
      if (slug && RT_SLUG.test(slug) && !out.has(b.imdb.value)) out.set(b.imdb.value, slug)
    }
  } catch {
    // Wikidata down → titles simply get no RT this cycle; TTL retries later.
  }
  return out
}

// ── Rotten Tomatoes page ─────────────────────────────────────────────────────

/** Pull Tomatometer + Popcornmeter out of an RT title page's embedded JSON. */
export function parseRtPage(html: string): { rt: number | null; rtAudience: number | null } {
  const pick = (key: string) => {
    const m = html.match(new RegExp(`"${key}":\\{[^}]*?"score":"(\\d*)"`))
    return m ? num(m[1]) : null
  }
  return { rt: pick('criticsScore'), rtAudience: pick('audienceScore') }
}

async function fetchRt(slug: string): Promise<{ rt: number | null; rtAudience: number | null } | null> {
  try {
    const res = await fetchWithTimeout(
      new URL(slug, RT_BASE),
      { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' } },
      WAN_TIMEOUT_MS,
      'rottentomatoes',
    )
    if (res.status === 404) return { rt: null, rtAudience: null }
    if (!res.ok) return null
    return parseRtPage(await res.text())
  } catch {
    return null
  }
}

// ── Cache ────────────────────────────────────────────────────────────────────

type Row = {
  imdb_id: string
  imdb: number | null
  rt: number | null
  rt_audience: number | null
  metacritic: number | null
  rt_slug: string | null
  fetched_at: number
}

function readCached(ids: string[], now: number): Map<string, TitleRatings> {
  const stmt = serverDb().raw.prepare(`SELECT * FROM title_ratings WHERE imdb_id = ?`)
  const out = new Map<string, TitleRatings>()
  for (const id of ids) {
    const row = stmt.get(id) as Row | undefined
    if (row && now - row.fetched_at < RATINGS_TTL_MS) {
      out.set(id, { imdb: row.imdb, rt: row.rt, rtAudience: row.rt_audience, metacritic: row.metacritic })
    }
  }
  return out
}

function writeCached(id: string, r: TitleRatings, slug: string | null, now: number): void {
  serverDb()
    .raw.prepare(
      `INSERT INTO title_ratings (imdb_id, imdb, rt, rt_audience, metacritic, rt_slug, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(imdb_id) DO UPDATE SET
         imdb = excluded.imdb, rt = excluded.rt, rt_audience = excluded.rt_audience,
         metacritic = excluded.metacritic, rt_slug = excluded.rt_slug, fetched_at = excluded.fetched_at`,
    )
    .run(id, r.imdb, r.rt, r.rtAudience, r.metacritic, slug, now)
}

// ── Fill worker ──────────────────────────────────────────────────────────────
// One in-process queue; ids are resolved in arrival order, FILL_CONCURRENCY at
// a time. Callers await `fillOne(id)` which resolves once that id is written
// (or its upstreams failed — then nothing is cached and the next request
// retries it).

const inflight = new Map<string, Promise<void>>()
const queue: Array<() => Promise<void>> = []
let running = 0

function pump(): void {
  while (running < FILL_CONCURRENCY && queue.length > 0) {
    const job = queue.shift()!
    running++
    void job().finally(() => {
      running--
      pump()
    })
  }
}

async function fillOne(id: string, slug: string | undefined, now: number): Promise<void> {
  const [omdb, rtPage] = await Promise.all([fetchOmdb(id), slug ? fetchRt(slug) : Promise.resolve({ rt: null, rtAudience: null })])
  // A transport failure on either source leaves the row uncached so it is
  // retried; a definitive "unknown" (OMDb Response:False, RT 404) is cached.
  if (!omdb || !rtPage) return
  writeCached(
    id,
    { imdb: omdb.imdb, rt: rtPage.rt ?? omdb.rt, rtAudience: rtPage.rtAudience, metacritic: omdb.metacritic },
    slug ?? null,
    now,
  )
}

function enqueue(ids: string[], now: number): Promise<void>[] {
  const fresh = ids.filter((id) => !inflight.has(id))
  if (fresh.length === 0) return ids.map((id) => inflight.get(id)!)
  // One Wikidata round-trip for the whole batch, shared by every job in it.
  const slugs = lookupRtSlugs(fresh)
  for (const id of fresh) {
    const p = new Promise<void>((resolve) => {
      queue.push(async () => {
        try {
          await fillOne(id, (await slugs).get(id), now)
        } finally {
          inflight.delete(id)
          resolve()
        }
      })
    })
    inflight.set(id, p)
  }
  pump()
  return ids.map((id) => inflight.get(id)!)
}

// unref: the timer must not keep the process (or a vitest worker) alive after
// the fill jobs have already won the race.
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref())

// GET /api/ratings?ids=tt0903747,tt1520211
// → { ratings: { "tt0903747": { imdb: 9.5, rt: 96, rtAudience: 97, metacritic: 87 }, ... },
//     pending: ["tt1520211"] }   // still filling; poll again while non-empty
ratings.get('/', async (c) => {
  const ids = [...new Set((c.req.query('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean))]
  if (ids.length === 0 || ids.length > MAX_IDS_PER_REQUEST || !ids.every((id) => IMDB_ID.test(id))) {
    return c.json({ error: 'invalid_ids' }, 400)
  }
  const now = Date.now()
  let result = readCached(ids, now)
  const missing = ids.filter((id) => !result.has(id))
  if (missing.length > 0) {
    const jobs = enqueue(missing, now)
    await Promise.race([Promise.all(jobs), sleep(SYNC_WAIT_MS)])
    result = readCached(ids, now)
  }
  const pending = ids.filter((id) => !result.has(id) && inflight.has(id))
  return c.json({ ratings: Object.fromEntries(result), pending })
})
