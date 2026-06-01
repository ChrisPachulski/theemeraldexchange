// server/services/localAvailability.bench.test.ts
//
// Match-accuracy BENCHMARK harness for the local-availability title matcher.
//
// This is NOT a perf benchmark. It is a deterministic precision/recall gate
// over a curated, hand-labelled fixture set. Each candidate carries an
// expected `shouldMatchLocal` boolean; after running the REAL
// tagLocalAvailability, we compute precision and recall from those labels
// vs. whether 'local' landed in available_on.
//
// CONTRACT being locked down (see localAvailability.ts):
//   PRIMARY  — tmdb_id JOIN: matches regardless of title/year.
//   FALLBACK — normalizeTitle() + EXACT year, with hard guards:
//                * only items with typeof year === 'number'
//                * skip normalized titles < 5 chars
//                * additive available_on merge, never duplicate 'local',
//                  never mutate input.
//   normalizeTitle = lowercase -> strip leading (the|a|an + space) ->
//                    drop non-alphanumerics.
//
// PRECISION MUST STAY 1.0. The matcher is precision-over-recall by design:
// media.db titles are dirty, so a false positive (claiming the household
// owns something it does not) is strictly worse than a miss. Any change that
// admits a single false positive must fail this suite, not relax it. Recall
// is gated at the value the current fixtures actually achieve so a behavioral
// regression that drops a previously-matching case names the offending row.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

// --- Test doubles: identical pattern to tagLocalAvailability.test.ts. The
// function under test is the REAL matcher; only env + the db singleton are
// mocked. ---
const hoisted = vi.hoisted(() => ({
  useMediaCore: true,
  dbHandle: null as { raw: import('better-sqlite3').Database; close(): void } | null,
}))

vi.mock('../env.js', () => ({
  env: {
    get useMediaCore() {
      return hoisted.useMediaCore
    },
    MEDIA_DB_PATH: ':memory:',
  },
}))

vi.mock('../services/mediaLibraryDbSingleton.js', () => ({
  mediaLibraryDb: () => hoisted.dbHandle,
}))

// Build an in-memory media.db with the media-core movies/shows schema —
// verbatim from tagLocalAvailability.test.ts.
function makeDb(opts: {
  movies?: Array<{ tmdb_id: number | null; title: string; year: number | null }>
  shows?: Array<{ tmdb_id: number | null; title: string; year: number | null }>
}): { raw: import('better-sqlite3').Database; close(): void } {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE movies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tmdb_id INTEGER UNIQUE,
      title TEXT NOT NULL,
      year INTEGER,
      added_at TEXT NOT NULL DEFAULT 'now',
      file_id INTEGER
    );
    CREATE TABLE shows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tmdb_id INTEGER UNIQUE,
      title TEXT NOT NULL,
      year INTEGER,
      added_at TEXT NOT NULL DEFAULT 'now'
    );
  `)
  const insM = raw.prepare(
    "INSERT INTO movies (tmdb_id, title, year, added_at) VALUES (?, ?, ?, 'now')",
  )
  for (const m of opts.movies ?? []) insM.run(m.tmdb_id, m.title, m.year)
  const insS = raw.prepare(
    "INSERT INTO shows (tmdb_id, title, year, added_at) VALUES (?, ?, ?, 'now')",
  )
  for (const s of opts.shows ?? []) insS.run(s.tmdb_id, s.title, s.year)
  return { raw, close: () => raw.close() }
}

let tagLocalAvailability: typeof import('../services/localAvailability.js').tagLocalAvailability

beforeEach(async () => {
  hoisted.useMediaCore = true
  hoisted.dbHandle = null
  vi.resetModules()
  ;({ tagLocalAvailability } = await import('../services/localAvailability.js'))
})

// --- Labelled candidate type for the benchmark ---
interface Candidate {
  // human-readable class for failure messages
  klass: string
  id: number
  title: string
  year?: number
  available_on?: string[]
  shouldMatchLocal: boolean
}

const cand = (c: Candidate): Candidate => c

// ===========================================================================
// MOVIE fixtures
// ===========================================================================
//
// The library deliberately carries some dirty/null-tmdb rows so the fallback
// path is exercised, plus clean tmdb rows for the primary path.
const MOVIE_LIBRARY = {
  movies: [
    // primary-id rows (title intentionally junk to prove id wins)
    { tmdb_id: 603, title: 'zzz reversed junk title', year: 2099 },
    // fallback rows (tmdb_id null -> only title+year can match)
    { tmdb_id: null, title: 'The Matrix', year: 1999 },
    { tmdb_id: null, title: 'WALL·E', year: 2008 },
    { tmdb_id: null, title: 'Spider-Man', year: 2002 },
    { tmdb_id: null, title: 'The Lord of the Rings', year: 2001 },
    { tmdb_id: null, title: 'Up', year: 2009 }, // normalizes to <5 chars
    { tmdb_id: null, title: 'Blade Runner', year: 1982 }, // for off-by-one + remake-year
  ] as Array<{ tmdb_id: number | null; title: string; year: number | null }>,
}

const MOVIE_CANDIDATES: Candidate[] = [
  // --- PRIMARY id hit: matches regardless of title/year mismatch ---
  cand({
    klass: 'primary-id-hit (title+year mismatch, id wins)',
    id: 603,
    title: 'Completely Different Name',
    year: 1234,
    shouldMatchLocal: true,
  }),

  // --- FALLBACK: article-strip makes "Matrix" == "The Matrix" ---
  cand({
    klass: 'fallback-article-strip (Matrix == The Matrix)',
    id: 700001,
    title: 'Matrix',
    year: 1999,
    shouldMatchLocal: true,
  }),

  // --- Punctuation / case / unicode variance that MUST still match ---
  cand({
    klass: 'variance-unicode (WALL·E == WALLE)',
    id: 700002,
    title: 'WALLE',
    year: 2008,
    shouldMatchLocal: true,
  }),
  cand({
    klass: 'variance-hyphen+case (Spider-Man == spiderman)',
    id: 700003,
    title: 'spiderman',
    year: 2002,
    shouldMatchLocal: true,
  }),
  cand({
    klass: 'variance-article+spacing (The Lord of the Rings == lord of the rings)',
    id: 700004,
    title: 'lord of the rings',
    year: 2001,
    shouldMatchLocal: true,
  }),

  // --- CONFIDENCE-FILTER negatives: MUST NOT match ---
  cand({
    klass: 'neg-year-off-by-one (Blade Runner 1983 vs lib 1982)',
    id: 700005,
    title: 'Blade Runner',
    year: 1983,
    shouldMatchLocal: false,
  }),
  cand({
    klass: 'neg-remake-year (Blade Runner 2049 not the 1982 row)',
    id: 700006,
    title: 'Blade Runner',
    year: 2049,
    shouldMatchLocal: false,
  }),
  cand({
    klass: 'neg-missing-year (undefined year -> skipped by typeof guard)',
    id: 700007,
    title: 'The Matrix',
    year: undefined,
    shouldMatchLocal: false,
  }),
  cand({
    klass: 'neg-short-norm-title ("Up" -> 2 chars < 5, skipped)',
    id: 700008,
    title: 'Up',
    year: 2009,
    shouldMatchLocal: false,
  }),
  cand({
    klass: 'neg-true-nonmatch (not in library at all)',
    id: 700009,
    title: 'Some Film Nobody Owns',
    year: 2015,
    shouldMatchLocal: false,
  }),
]

// ===========================================================================
// TV fixtures
// ===========================================================================
const SHOW_LIBRARY = {
  shows: [
    { tmdb_id: 1396, title: 'reversed junk show title', year: 2099 }, // primary id
    { tmdb_id: null, title: 'The Expanse', year: 2015 }, // fallback article-strip
    { tmdb_id: null, title: 'Breaking Bad', year: 2008 }, // fallback exact
  ] as Array<{ tmdb_id: number | null; title: string; year: number | null }>,
}

const SHOW_CANDIDATES: Candidate[] = [
  cand({
    klass: 'tv-primary-id-hit',
    id: 1396,
    title: 'Different Show Title',
    year: 1000,
    shouldMatchLocal: true,
  }),
  cand({
    klass: 'tv-fallback-article-strip (Expanse == The Expanse)',
    id: 800001,
    title: 'Expanse',
    year: 2015,
    shouldMatchLocal: true,
  }),
  cand({
    klass: 'tv-fallback-exact (Breaking Bad)',
    id: 800002,
    title: 'breaking bad',
    year: 2008,
    shouldMatchLocal: true,
  }),
  cand({
    klass: 'tv-neg-year-mismatch (Breaking Bad wrong year)',
    id: 800003,
    title: 'Breaking Bad',
    year: 2009,
    shouldMatchLocal: false,
  }),
  cand({
    klass: 'tv-neg-true-nonmatch',
    id: 800004,
    title: 'A Show That Does Not Exist',
    year: 2020,
    shouldMatchLocal: false,
  }),
]

// Strip the benchmark-only `klass`/`shouldMatchLocal` fields before feeding
// the matcher — it sees only the production-shaped item.
function toItem(c: Candidate) {
  return { id: c.id, title: c.title, year: c.year, available_on: c.available_on }
}

function precisionRecall(
  candidates: Candidate[],
  out: Array<{ available_on?: string[] }>,
) {
  let tp = 0
  let fp = 0
  let fn = 0
  candidates.forEach((c, i) => {
    const matched = (out[i].available_on ?? []).includes('local')
    if (matched && c.shouldMatchLocal) tp++
    else if (matched && !c.shouldMatchLocal) fp++
    else if (!matched && c.shouldMatchLocal) fn++
  })
  return {
    tp,
    fp,
    fn,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
  }
}

describe('localAvailability match-accuracy benchmark', () => {
  // ----------------------------------------------------------------------
  // MOVIE precision/recall gate
  // ----------------------------------------------------------------------
  describe('movies — precision/recall over labelled fixtures', () => {
    it('achieves precision 1.0 and recall at the fixture-measured threshold', () => {
      hoisted.dbHandle = makeDb(MOVIE_LIBRARY)
      const out = tagLocalAvailability(MOVIE_CANDIDATES.map(toItem), 'movie')
      const m = precisionRecall(MOVIE_CANDIDATES, out)

      // PRECISION MUST STAY 1.0 — zero false positives, always. This is the
      // load-bearing invariant of the precision-over-recall design.
      expect(m.fp).toBe(0)
      expect(m.precision).toBe(1)

      // Recall threshold = value the current fixtures actually achieve. All
      // 5 positives (1 id + 4 fallback) are matchable with the current
      // matcher, so the fixtures hit recall 1.0. Pinned here as a true
      // regression gate: if a future change drops a previously-matching
      // case, recall falls below 1.0 and this fails.
      expect(m.recall).toBeGreaterThanOrEqual(1.0)
    })

    // Table-driven per-item outcomes so a regression names the offending case.
    it.each(MOVIE_CANDIDATES.map((c) => [c.klass, c] as const))(
      'movie case: %s',
      (_klass, c) => {
        hoisted.dbHandle = makeDb(MOVIE_LIBRARY)
        const out = tagLocalAvailability([toItem(c)], 'movie')
        const matched = (out[0].available_on ?? []).includes('local')
        expect(matched).toBe(c.shouldMatchLocal)
      },
    )
  })

  // ----------------------------------------------------------------------
  // TV precision/recall gate
  // ----------------------------------------------------------------------
  describe('shows — precision/recall over labelled fixtures', () => {
    it('achieves precision 1.0 and recall at the fixture-measured threshold', () => {
      hoisted.dbHandle = makeDb(SHOW_LIBRARY)
      const out = tagLocalAvailability(SHOW_CANDIDATES.map(toItem), 'tv')
      const m = precisionRecall(SHOW_CANDIDATES, out)

      expect(m.fp).toBe(0)
      expect(m.precision).toBe(1)
      // 3 positives (1 id + 2 fallback) all matchable -> recall 1.0.
      expect(m.recall).toBeGreaterThanOrEqual(1.0)
    })

    it.each(SHOW_CANDIDATES.map((c) => [c.klass, c] as const))(
      'show case: %s',
      (_klass, c) => {
        hoisted.dbHandle = makeDb(SHOW_LIBRARY)
        const out = tagLocalAvailability([toItem(c)], 'tv')
        const matched = (out[0].available_on ?? []).includes('local')
        expect(matched).toBe(c.shouldMatchLocal)
      },
    )
  })

  // ----------------------------------------------------------------------
  // Additive merge + no-mutation contract (pre-snapshot deep-clone compare)
  // ----------------------------------------------------------------------
  describe('additive merge preserves prior availability without mutation', () => {
    it("merges 'local' into ['iptv'] -> ['iptv','local'] with no dup and no input mutation", () => {
      hoisted.dbHandle = makeDb({
        movies: [{ tmdb_id: 603, title: 'irrelevant', year: 1999 }],
      })
      const input = [
        { id: 603, title: 'The Matrix', year: 1999, available_on: ['iptv'] },
      ]
      // Deep clone BEFORE running, to prove the input is untouched after.
      const snapshot = JSON.parse(JSON.stringify(input))

      const out = tagLocalAvailability(input, 'movie')

      // additive merge, no duplication, order preserved (existing first)
      expect(out[0].available_on).toEqual(['iptv', 'local'])
      expect(out[0].available_on?.filter((s) => s === 'local')).toHaveLength(1)

      // input array and its objects are unchanged vs the pre-run snapshot
      expect(input).toEqual(snapshot)
      expect(out).not.toBe(input)
      expect(out[0]).not.toBe(input[0])
    })

    it("never duplicates 'local' when the item already carries it", () => {
      hoisted.dbHandle = makeDb({
        movies: [{ tmdb_id: 603, title: 'irrelevant', year: 1999 }],
      })
      const input = [
        { id: 603, title: 'The Matrix', year: 1999, available_on: ['local'] },
      ]
      const snapshot = JSON.parse(JSON.stringify(input))
      const out = tagLocalAvailability(input, 'movie')
      expect(out[0].available_on).toEqual(['local'])
      expect(input).toEqual(snapshot)
    })
  })

  // ----------------------------------------------------------------------
  // Year as a HARD confidence gate (not a tiebreak). Two library rows with
  // the SAME normalized title and ADJACENT years; a candidate must match
  // ONLY the row whose year is exact.
  // ----------------------------------------------------------------------
  describe('year is a hard confidence gate, not a tiebreak', () => {
    const TWIN_LIBRARY = {
      movies: [
        // identical normalized title ("blade runner"), adjacent years
        { tmdb_id: null, title: 'Blade Runner', year: 1982 },
        { tmdb_id: null, title: 'Blade Runner', year: 1983 },
      ] as Array<{ tmdb_id: number | null; title: string; year: number | null }>,
    }

    it('matches the exact-year row (1982)', () => {
      hoisted.dbHandle = makeDb(TWIN_LIBRARY)
      const out = tagLocalAvailability(
        [{ id: 900001, title: 'Blade Runner', year: 1982 }] as Array<{
          id: number
          title: string
          year: number
          available_on?: string[]
        }>,
        'movie',
      )
      expect(out[0].available_on).toContain('local')
    })

    it('matches the OTHER exact-year row (1983) — both years are real keys', () => {
      hoisted.dbHandle = makeDb(TWIN_LIBRARY)
      const out = tagLocalAvailability(
        [{ id: 900002, title: 'Blade Runner', year: 1983 }] as Array<{
          id: number
          title: string
          year: number
          available_on?: string[]
        }>,
        'movie',
      )
      expect(out[0].available_on).toContain('local')
    })

    it('does NOT match a year absent from both rows (1984) — no nearest-year tiebreak', () => {
      hoisted.dbHandle = makeDb(TWIN_LIBRARY)
      const out = tagLocalAvailability(
        [{ id: 900003, title: 'Blade Runner', year: 1984 }] as Array<{
          id: number
          title: string
          year: number
          available_on?: string[]
        }>,
        'movie',
      )
      expect(out[0].available_on ?? []).not.toContain('local')
    })
  })
})
