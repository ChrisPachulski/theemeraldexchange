// Offline eval harness for the AI recommendation section. NOT a unit
// test — runs only under `npm run eval:recs` via vitest.eval.config.ts.
// Drives the suggestions route across realistic fixtures with a
// programmable mock Anthropic so each iteration of the improvement
// loop can produce a measurable score per rubric dimension.
//
// Output: .planning/ai-recommendations-loop/eval-runs/<timestamp>.json
// plus a stdout table.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { Hono } from 'hono'
import {
  suggestions,
  _setTmdbApiKeyForTests,
  _resetRecentlyShownForTests,
  _resetLibraryCacheForTests,
  _resetTmdbInFlightForTests,
  _resetLibraryBlockCacheForTests,
} from './suggestions.js'
import { createSession } from '../session.js'
import { _setRejectionsPathForTests, addRejection } from '../services/rejections.js'
import { _setUserFeedbackPathForTests, setLike } from '../services/userFeedback.js'
import { _setUsageLogPathForTests } from '../services/usageLog.js'
import type { Env } from '../middleware/auth.js'

// --- shared mock state -----------------------------------------------

type LibraryEntry = { title: string; year: number; tmdbId: number; genres: string[] }
type Pick = { title: string; year?: number }

const lastCreateArgs: { value: unknown } = { value: null }
const claudePicksByCall: { value: Pick[][] } = { value: [] }
let claudeCallIndex = 0

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = {
      create: async (args: unknown) => {
        lastCreateArgs.value = args
        const picks = claudePicksByCall.value[claudeCallIndex] ?? []
        claudeCallIndex += 1
        return {
          content: [
            {
              type: 'tool_use',
              id: 'tu_' + claudeCallIndex,
              name: 'submit_recommendations',
              input: { picks },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 60 },
        }
      },
    }
    constructor(_opts: unknown) {}
  }
  return { default: FakeAnthropic }
})

// --- fixtures --------------------------------------------------------

const FIXTURES_ROOT = resolve(__dirname, '../../scripts/fixtures')

async function loadFixture<T>(name: string): Promise<T> {
  const raw = await fs.readFile(join(FIXTURES_ROOT, name), 'utf-8')
  return JSON.parse(raw) as T
}

// Universe of plausible Claude picks the harness draws from when
// simulating a model response. Larger than TARGET_COUNT so refreshes
// can rotate without depleting. Mix of genres so the simulator can be
// pushed to vary.
const PICK_UNIVERSE = {
  movie: [
    { title: 'Michael Clayton', year: 2007 },
    { title: 'Margin Call', year: 2011 },
    { title: 'Tinker Tailor Soldier Spy', year: 2011 },
    { title: 'A Most Violent Year', year: 2014 },
    { title: 'Wind River', year: 2017 },
    { title: 'The Town', year: 2010 },
    { title: 'Mystic River', year: 2003 },
    { title: 'Collateral', year: 2004 },
    { title: 'Killing Them Softly', year: 2012 },
    { title: 'A Most Wanted Man', year: 2014 },
    { title: 'Hell or High Water', year: 2016 },
    { title: 'The Place Beyond the Pines', year: 2013 },
    { title: 'Three Billboards Outside Ebbing, Missouri', year: 2017 },
    { title: 'Spotlight', year: 2015 },
    { title: 'Argo', year: 2012 },
    { title: 'Foxcatcher', year: 2014 },
    { title: 'The Master', year: 2012 },
    { title: 'Phantom Thread', year: 2017 },
    { title: 'Burning', year: 2018 },
    { title: 'Memories of Murder', year: 2003 },
    { title: 'Oldboy', year: 2003 },
    { title: 'The Handmaiden', year: 2016 },
    { title: 'Parasite', year: 2019 },
    { title: 'Decision to Leave', year: 2022 },
    { title: 'Ex Machina', year: 2014 },
    { title: 'Annihilation', year: 2018 },
    { title: 'The Lighthouse', year: 2019 },
    { title: 'First Reformed', year: 2017 },
    { title: 'The Notebook', year: 2004 }, // intentionally on rejects
    { title: 'Inception', year: 2010 }, // intentionally in library
  ],
  tv: [
    { title: 'The Americans', year: 2013 },
    { title: 'Halt and Catch Fire', year: 2014 },
    { title: 'Rectify', year: 2013 },
    { title: 'Justified', year: 2010 },
    { title: 'Deadwood', year: 2004 },
    { title: 'Boardwalk Empire', year: 2010 },
    { title: 'Treme', year: 2010 },
    { title: 'Bloodline', year: 2015 },
    { title: 'Goliath', year: 2016 },
    { title: 'Patriot', year: 2015 },
    { title: 'Counterpart', year: 2017 },
    { title: 'Devs', year: 2020 },
    { title: 'Tales from the Loop', year: 2020 },
    { title: 'Slow Horses', year: 2022 },
    { title: 'The Night Of', year: 2016 },
    { title: 'Top of the Lake', year: 2013 },
    { title: 'Broadchurch', year: 2013 },
    { title: 'Line of Duty', year: 2012 },
    { title: 'Happy Valley', year: 2014 },
    { title: 'The Killing', year: 2011 },
    { title: 'Borgen', year: 2010 },
    { title: 'The Bureau', year: 2015 },
    { title: 'Babylon Berlin', year: 2017 },
    { title: 'Dark', year: 2017 },
    { title: 'The Leftovers', year: 2014 },
    { title: 'Watchmen', year: 2019 },
    { title: 'Station Eleven', year: 2021 },
    { title: 'The Outsider', year: 2020 },
    { title: 'Rick and Morty', year: 2013 }, // intentionally on rejects
    { title: 'Severance', year: 2022 }, // intentionally in library
  ],
}

// --- mock fetch ------------------------------------------------------

// Returns a fetch shim that satisfies the suggestions route's upstream
// needs given a kind + library + a TMDB simulator. TMDB search returns
// a deterministic synthetic id per title so the route's id-based filter
// has real numbers to work with.
function makeFetchShim(kind: 'movie' | 'tv', library: LibraryEntry[]) {
  const libraryByTitleLower = new Map<string, LibraryEntry>(
    library.map((l) => [l.title.toLowerCase(), l]),
  )
  // Synthetic tmdb ids start above the library range to avoid accidental
  // collision; the route's id-based filter catches real conflicts.
  let nextSyntheticId = 1_000_000
  const titleToSyntheticId = new Map<string, number>()
  const syntheticIdFor = (title: string): number => {
    const key = title.toLowerCase()
    const existing = titleToSyntheticId.get(key)
    if (existing) return existing
    const id = nextSyntheticId++
    titleToSyntheticId.set(key, id)
    return id
  }
  return vi.fn(async (input: unknown) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url: string }).url
    // Sonarr / Radarr library
    if (url.includes('/api/v3/series') || url.includes('/api/v3/movie')) {
      return new Response(JSON.stringify(library), { status: 200 })
    }
    // TMDB search — match by title, hydrate library id if it exists.
    if (url.includes('themoviedb.org/3/search/')) {
      const u = new URL(url)
      const q = (u.searchParams.get('query') ?? '').toLowerCase()
      const libHit = libraryByTitleLower.get(q)
      if (libHit) {
        const row = {
          id: libHit.tmdbId,
          title: kind === 'movie' ? libHit.title : undefined,
          name: kind === 'tv' ? libHit.title : undefined,
          poster_path: null,
          first_air_date: kind === 'tv' ? `${libHit.year}-01-01` : undefined,
          release_date: kind === 'movie' ? `${libHit.year}-01-01` : undefined,
        }
        return new Response(JSON.stringify({ results: [row] }), { status: 200 })
      }
      const id = syntheticIdFor(q)
      const yearStr = u.searchParams.get('primary_release_year') ?? u.searchParams.get('first_air_date_year')
      const yr = yearStr ?? '2018'
      const row = {
        id,
        title: kind === 'movie' ? q : undefined,
        name: kind === 'tv' ? q : undefined,
        poster_path: null,
        first_air_date: kind === 'tv' ? `${yr}-01-01` : undefined,
        release_date: kind === 'movie' ? `${yr}-01-01` : undefined,
      }
      return new Response(JSON.stringify({ results: [row] }), { status: 200 })
    }
    // TMDB direct id lookup (backfill)
    if (url.match(/themoviedb\.org\/3\/(movie|tv)\/\d+/)) {
      return new Response(JSON.stringify({ title: 'Unknown', name: 'Unknown' }), { status: 200 })
    }
    // TMDB trending — when our PICK_UNIVERSE overlaps with trending,
    // a "personalization signal" failure surfaces because the picks
    // also happen to be popular. Inject ~6 real titles from the
    // universe into trending so personalization-signal scoring is no
    // longer free.
    if (url.includes('themoviedb.org/3/trending')) {
      const trendingOverlapTitles = (PICK_UNIVERSE[kind] as Pick[])
        .slice(0, 6)
        .map((p, i) => ({
          id: syntheticIdFor(p.title), // share the synthetic id with /search
          title: kind === 'movie' ? p.title : undefined,
          name: kind === 'tv' ? p.title : undefined,
          poster_path: null,
          release_date: kind === 'movie' ? `${p.year}-01-01` : undefined,
          first_air_date: kind === 'tv' ? `${p.year}-01-01` : undefined,
          overlap_index: i,
        }))
      const filler = Array.from({ length: 14 }, (_, i) => ({
        id: 9_000_000 + i,
        title: kind === 'movie' ? `Trending Movie ${i + 1}` : undefined,
        name: kind === 'tv' ? `Trending Show ${i + 1}` : undefined,
        poster_path: null,
        release_date: '2025-01-01',
        first_air_date: '2025-01-01',
      }))
      return new Response(JSON.stringify({ results: [...trendingOverlapTitles, ...filler] }), { status: 200 })
    }
    // TMDB discover
    if (url.includes('themoviedb.org/3/discover/')) {
      const rows = Array.from({ length: 20 }, (_, i) => ({
        id: 8_000_000 + i,
        title: kind === 'movie' ? `Discover Movie ${i + 1}` : undefined,
        name: kind === 'tv' ? `Discover Show ${i + 1}` : undefined,
        poster_path: null,
        release_date: '2024-01-01',
        first_air_date: '2024-01-01',
      }))
      return new Response(JSON.stringify({ results: rows }), { status: 200 })
    }
    // Default: empty result
    return new Response('[]', { status: 200 })
  })
}

// --- test app --------------------------------------------------------

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', suggestions)
  return app
}

async function userCookie() {
  const t = await createSession({ sub: '1', username: 'guest', role: 'user' })
  return `eex.session=${t}`
}

// --- scenario runner -------------------------------------------------

type RefreshResult = {
  status: number
  source: string
  itemIds: number[]
  itemTitles: string[]
  rawItems: Array<Record<string, unknown>>
  diag: Record<string, unknown> | null
  elapsedMs: number
}

async function runRefresh(kind: 'movie' | 'tv'): Promise<RefreshResult> {
  const start = performance.now()
  const r = await appUnderTest().request(`/${kind}`, {
    headers: {
      Cookie: await userCookie(),
      'X-Anthropic-Api-Key': 'sk-ant-test-fakekey',
    },
  })
  const elapsedMs = performance.now() - start
  const body = (await r.json().catch(() => ({}))) as {
    source?: string
    items?: Array<{ id: number; title: string }>
    _diag?: Record<string, unknown>
  }
  return {
    status: r.status,
    source: body.source ?? 'unknown',
    itemIds: (body.items ?? []).map((i) => i.id),
    itemTitles: (body.items ?? []).map((i) => i.title),
    rawItems: (body.items ?? []) as Array<Record<string, unknown>>,
    diag: body._diag ?? null,
    elapsedMs,
  }
}

// Simulate a Claude response: pick from PICK_UNIVERSE, rotating by
// call index so consecutive calls vary, but with deterministic seed
// so re-runs are reproducible across iterations.
//
// Modes:
//   'normal'   — clean picks (sanity baseline)
//   'leaky'    — includes 2 library/reject conflicts per refresh
//   'realistic'— mimics what real Claude tends to do under stress:
//                ~25% library/reject overlap on call 1, ~10% on retry,
//                some year drift, some near-duplicate picks, and only
//                modest variety across refreshes (windows overlap 70%).
//                This is the adversary the loop is actually fighting.
function seedClaudePicks(
  kind: 'movie' | 'tv',
  refreshCount: number,
  mode: 'normal' | 'leaky' | 'realistic',
) {
  const universe = PICK_UNIVERSE[kind]
  claudePicksByCall.value = []
  for (let r = 0; r < refreshCount; r++) {
    const out: Pick[] = []
    // Slide a 30-item window through the universe per refresh.
    // Smaller stride = less variety; mimics how real Claude with a
    // cached prompt prefix tends to anchor across refreshes.
    const stride = mode === 'realistic' ? 3 : 7
    const base = (r * stride) % universe.length
    for (let i = 0; i < 30; i++) {
      out.push(universe[(base + i) % universe.length])
    }
    if (mode === 'leaky') {
      out[0] = kind === 'movie' ? { title: 'Inception', year: 2010 } : { title: 'Severance', year: 2022 }
      out[1] = kind === 'movie' ? { title: 'The Notebook', year: 2004 } : { title: 'Rick and Morty', year: 2013 }
    }
    if (mode === 'realistic') {
      // Inject realistic stressors: library/reject hits + a year drift
      // + a near-duplicate to test dedupe.
      const libHits = kind === 'movie'
        ? [{ title: 'Inception', year: 2010 }, { title: 'Heat', year: 1995 }, { title: 'Drive', year: 2011 }]
        : [{ title: 'Severance', year: 2022 }, { title: 'Better Call Saul', year: 2015 }, { title: 'Mindhunter', year: 2017 }]
      const rejHit = kind === 'movie'
        ? { title: 'The Notebook', year: 2004 }
        : { title: 'Loki', year: 2021 }
      // Place stressors at deterministic positions so the score is
      // reproducible. Position 0 = a library match (most adversarial,
      // forces the pre-validate by title to do its job); position 5 =
      // year-drifted pick (forces year-proximity guard); position 6 =
      // near-duplicate of position 5.
      out[0] = libHits[r % libHits.length]
      out[3] = rejHit
      // Year drift only matters on the movie path (TV path drops the
      // year-proximity guard intentionally).
      if (kind === 'movie') {
        out[5] = { title: 'The Town', year: 1995 } // real year is 2010 → 15y drift, should drop
      }
      // Near-duplicate: same title, same year as position 5 (post-year-fix)
      out[6] = out[5]
    }
    claudePicksByCall.value.push(out)
  }
  claudeCallIndex = 0
}

// --- scoring ---------------------------------------------------------

type Scores = {
  personalizedFill: number
  hygiene: number
  personalizationSignal: number
  refreshVariety: number
  latency: number
  honestDegradation: number
  trustScaffolding: number
}

function bucketScore(value: number, thresholds: number[]): number {
  // thresholds in descending order of badness — higher value = lower
  // score. Length 4 → score in 1..5.
  for (let i = 0; i < thresholds.length; i++) {
    if (value > thresholds[i]) return 5 - i - 1
  }
  return 5
}

function jaccard(a: number[], b: number[]): number {
  const sa = new Set(a)
  const sb = new Set(b)
  let inter = 0
  for (const x of sa) if (sb.has(x)) inter++
  const union = sa.size + sb.size - inter
  return union === 0 ? 0 : inter / union
}

function scorePersonalizedFill(results: RefreshResult[]): number {
  const personalizedFull = results.filter(
    (r) => r.source === 'personalized' && r.itemIds.length >= 16,
  ).length
  const rate = personalizedFull / results.length
  // 0..0.2 → 1, 0.2..0.4 → 2, 0.4..0.6 → 3, 0.6..0.8 → 4, 0.8+ → 5
  return rate >= 0.8 ? 5 : rate >= 0.6 ? 4 : rate >= 0.4 ? 3 : rate >= 0.2 ? 2 : 1
}

function scoreHygiene(
  results: RefreshResult[],
  library: LibraryEntry[],
  rejects: Array<{ id: number }>,
): number {
  const libraryIds = new Set(library.map((l) => l.tmdbId))
  const rejectIds = new Set(rejects.map((r) => r.id))
  let leaks = 0
  for (const r of results) {
    for (const id of r.itemIds) {
      if (libraryIds.has(id) || rejectIds.has(id)) leaks++
    }
  }
  return bucketScore(leaks, [5, 3, 1, 0])
}

function scorePersonalizationSignal(results: RefreshResult[]): number {
  // Lower fraction of items that ALSO appear in the trending top 6 OR
  // come from the trending/discover fallback ranges. The trending shim
  // now overlaps the pick universe by 6 titles so the scoring is no
  // longer free — a system that just returns whatever Claude said
  // first will score worse than one that prefers non-popular adjacents.
  let total = 0
  let trendingOrDiscover = 0
  for (const r of results) {
    for (const id of r.itemIds) {
      total++
      // Discover fallback range
      if (id >= 8_000_000 && id < 8_000_100) trendingOrDiscover++
      // Trending filler range
      else if (id >= 9_000_000 && id < 9_000_100) trendingOrDiscover++
      // Synthetic ids in [1_000_000, 1_000_006) are the trending-overlap
      // subset — picks here are both Claude-suggested AND trending.
      else if (id >= 1_000_000 && id < 1_000_006) trendingOrDiscover++
    }
  }
  if (total === 0) return 1
  const ratio = trendingOrDiscover / total
  return ratio < 0.1 ? 5 : ratio < 0.25 ? 4 : ratio < 0.4 ? 3 : ratio < 0.6 ? 2 : 1
}

function scoreRefreshVariety(results: RefreshResult[]): number {
  if (results.length < 2) return 1
  let total = 0
  let count = 0
  for (let i = 1; i < results.length; i++) {
    total += jaccard(results[i - 1].itemIds, results[i].itemIds)
    count++
  }
  const avgJaccard = total / count
  // <0.3 → 5, 0.3..0.45 → 4, 0.45..0.6 → 3, 0.6..0.8 → 2, >0.8 → 1
  return avgJaccard < 0.3 ? 5 : avgJaccard < 0.45 ? 4 : avgJaccard < 0.6 ? 3 : avgJaccard < 0.8 ? 2 : 1
}

function scoreLatency(results: RefreshResult[]): number {
  if (results.length === 0) return 1
  const sorted = results.map((r) => r.elapsedMs).sort((a, b) => a - b)
  const p50 = sorted[Math.floor(sorted.length / 2)]
  // Mocked latency only; real numbers come from live mode (TODO future iter).
  // <50 → 5, <100 → 4, <200 → 3, <500 → 2, else 1.
  return p50 < 50 ? 5 : p50 < 100 ? 4 : p50 < 200 ? 3 : p50 < 500 ? 2 : 1
}

function scoreHonestDegradation(results: RefreshResult[]): number {
  // Every result must carry a `source` field; every non-`personalized`
  // source must carry _diag with at least one explanatory key. This
  // measures the contract surface; later iterations can add to it.
  let total = 0
  let honest = 0
  for (const r of results) {
    total++
    if (!r.source || r.source === 'unknown') continue
    if (r.source === 'personalized') {
      honest++
      continue
    }
    const diag = r.diag ?? {}
    const hasExplain =
      'reason' in diag ||
      'fillSource' in diag ||
      'claudeError' in diag ||
      'lastCounters' in diag
    if (hasExplain) honest++
  }
  const rate = total === 0 ? 0 : honest / total
  return rate >= 0.95 ? 5 : rate >= 0.8 ? 4 : rate >= 0.6 ? 3 : rate >= 0.4 ? 2 : 1
}

function scoreTrustScaffolding(results: RefreshResult[]): number {
  // Trust scaffolding = the user can tell WHY a pick is there. Probes
  // the response item schema for `provenance` (which source produced
  // this card) and `reason` (one-line "because you liked X"). Diag is
  // separate — that's about the WHOLE response, not the per-pick story.
  let withBoth = 0
  let withProv = 0
  let withReason = 0
  let total = 0
  for (const r of results) {
    const rawItems = (r.rawItems ?? []) as Array<{ provenance?: string; reason?: string }>
    for (const it of rawItems) {
      total++
      const hasProv = typeof it.provenance === 'string' && it.provenance.length > 0
      const hasReason = typeof it.reason === 'string' && it.reason.length > 0
      if (hasProv) withProv++
      if (hasReason) withReason++
      if (hasProv && hasReason) withBoth++
    }
  }
  if (total === 0) return 1
  const provRate = withProv / total
  const reasonRate = withReason / total
  const bothRate = withBoth / total
  // 5: ≥90% of items have BOTH; 4: ≥75% of items have provenance and
  // ≥40% have reason; 3: provenance covers ≥75%; 2: provenance any %;
  // 1: neither field present anywhere.
  if (bothRate >= 0.9) return 5
  if (provRate >= 0.75 && reasonRate >= 0.4) return 4
  if (provRate >= 0.75) return 3
  if (provRate > 0) return 2
  return 1
}

function aggregate(results: RefreshResult[], library: LibraryEntry[], rejects: Array<{ id: number }>): Scores {
  return {
    personalizedFill: scorePersonalizedFill(results),
    hygiene: scoreHygiene(results, library, rejects),
    personalizationSignal: scorePersonalizationSignal(results),
    refreshVariety: scoreRefreshVariety(results),
    latency: scoreLatency(results),
    honestDegradation: scoreHonestDegradation(results),
    trustScaffolding: scoreTrustScaffolding(results),
  }
}

// --- scenarios -------------------------------------------------------

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'eval-recs-'))
  _setRejectionsPathForTests(join(tmpRoot, 'rejections.json'))
  _setUserFeedbackPathForTests(join(tmpRoot, 'feedback.json'))
  _setUsageLogPathForTests(join(tmpRoot, 'usage.jsonl'))
  lastCreateArgs.value = null
  claudePicksByCall.value = []
  claudeCallIndex = 0
  _setTmdbApiKeyForTests('test-key')
  _resetRecentlyShownForTests()
  _resetLibraryCacheForTests()
  _resetTmdbInFlightForTests()
  _resetLibraryBlockCacheForTests()
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
  vi.unstubAllGlobals()
  _setTmdbApiKeyForTests(null)
})

const REPORT: { scenario: string; kind: string; scores: Scores; sampleSources: string[] }[] = []

async function seedRejects(kind: 'movie' | 'tv', rejects: Array<{ id: number; title: string }>) {
  for (const r of rejects) await addRejection(kind, r.id, r.title)
}

async function seedLikes(kind: 'movie' | 'tv', likes: Array<{ id: number; title: string }>) {
  for (const l of likes) await setLike('1', kind, l.id, l.title)
}

describe('AI recommendation section — eval scenarios', () => {
  it('movie · realistic household · 5 refresh window', async () => {
    const library = await loadFixture<LibraryEntry[]>('library-movies.json')
    const rejects = await loadFixture<{ movie: Array<{ id: number; title: string }> }>('rejections.json')
    const likes = await loadFixture<{ movie: Array<{ id: number; title: string }> }>('likes.json')
    await seedRejects('movie', rejects.movie)
    await seedLikes('movie', likes.movie)
    vi.stubGlobal('fetch', makeFetchShim('movie', library))
    seedClaudePicks('movie', 5, 'realistic')
    const results: RefreshResult[] = []
    for (let i = 0; i < 5; i++) {
      _resetLibraryCacheForTests() // ensure each refresh hits the shim
      results.push(await runRefresh('movie'))
    }
    const scores = aggregate(results, library, rejects.movie)
    REPORT.push({ scenario: 'realistic-5x', kind: 'movie', scores, sampleSources: results.map((r) => r.source) })
    expect(results.every((r) => r.status === 200)).toBe(true)
  })

  it('tv · realistic household · 5 refresh window', async () => {
    const library = await loadFixture<LibraryEntry[]>('library-tv.json')
    const rejects = await loadFixture<{ tv: Array<{ id: number; title: string }> }>('rejections.json')
    const likes = await loadFixture<{ tv: Array<{ id: number; title: string }> }>('likes.json')
    await seedRejects('tv', rejects.tv)
    await seedLikes('tv', likes.tv)
    vi.stubGlobal('fetch', makeFetchShim('tv', library))
    seedClaudePicks('tv', 5, 'realistic')
    const results: RefreshResult[] = []
    for (let i = 0; i < 5; i++) {
      _resetLibraryCacheForTests()
      results.push(await runRefresh('tv'))
    }
    const scores = aggregate(results, library, rejects.tv)
    REPORT.push({ scenario: 'realistic-5x', kind: 'tv', scores, sampleSources: results.map((r) => r.source) })
    expect(results.every((r) => r.status === 200)).toBe(true)
  })

  it('movie · leaky claude · hygiene stress', async () => {
    const library = await loadFixture<LibraryEntry[]>('library-movies.json')
    const rejects = await loadFixture<{ movie: Array<{ id: number; title: string }> }>('rejections.json')
    await seedRejects('movie', rejects.movie)
    vi.stubGlobal('fetch', makeFetchShim('movie', library))
    seedClaudePicks('movie', 3, 'leaky')
    const results: RefreshResult[] = []
    for (let i = 0; i < 3; i++) {
      _resetLibraryCacheForTests()
      results.push(await runRefresh('movie'))
    }
    const scores = aggregate(results, library, rejects.movie)
    REPORT.push({ scenario: 'leaky-3x', kind: 'movie', scores, sampleSources: results.map((r) => r.source) })
    expect(results.every((r) => r.status === 200)).toBe(true)
  })

  it('writes consolidated report to .planning/ai-recommendations-loop/eval-runs/', async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const outDir = resolve(__dirname, '../../.planning/ai-recommendations-loop/eval-runs')
    await fs.mkdir(outDir, { recursive: true })
    const outPath = join(outDir, `${stamp}.json`)
    // Aggregate per dimension across scenarios (simple mean, rounded)
    const dims: (keyof Scores)[] = [
      'personalizedFill',
      'hygiene',
      'personalizationSignal',
      'refreshVariety',
      'latency',
      'honestDegradation',
      'trustScaffolding',
    ]
    const overall: Partial<Record<keyof Scores, number>> = {}
    for (const d of dims) {
      const vals = REPORT.map((r) => r.scores[d])
      overall[d] = vals.length === 0 ? 0 : Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 100) / 100
    }
    const payload = { timestamp: stamp, scenarios: REPORT, overall }
    await fs.writeFile(outPath, JSON.stringify(payload, null, 2))
    // Human-readable stdout for the loop's iteration log.
    /* eslint-disable no-console */
    console.log('\n=== AI Recommendation Section — Eval Report ===')
    console.log('Path:', outPath)
    console.log('Per-scenario:')
    for (const row of REPORT) {
      console.log(`  ${row.kind}/${row.scenario}:`, JSON.stringify(row.scores), 'sources=', row.sampleSources.join(','))
    }
    console.log('Overall (mean across scenarios):', JSON.stringify(overall))
    /* eslint-enable no-console */
    expect(REPORT.length).toBeGreaterThan(0)
  })
})
