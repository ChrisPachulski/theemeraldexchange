// Fixture catalog for the media-core mock (server/mocks/mediaCoreMock.ts).
//
// DATA ONLY — no server logic here. The shapes mirror media-core's list
// responses exactly as the SPA consumes them in src/lib/api/media.ts
// (RawMovieRow / RawShowRow / RawEpisodeRow / RawWatchRow). media-core
// serializes serde snake_case with no rename, so every field below is
// snake_case to match the wire format the real service emits.
//
// Variety is deliberate: titles with and without tmdb/poster metadata,
// long titles, and year edge cases (null year, very old, near-future) so
// the SPA's empty/fallback UI states are all exercisable against the mock.

/** A movie row, byte-for-byte the shape of media-core's /movies items
 *  (RawMovieRow in src/lib/api/media.ts). */
export type MockMovieRow = {
  id: number
  tmdb_id: number | null
  imdb_id: string | null
  title: string
  year: number | null
  added_at: string
  file_id: number
  overview: string | null
  poster_path: string | null
}

/** A show row (RawShowRow in src/lib/api/media.ts). */
export type MockShowRow = {
  id: number
  tmdb_id: number | null
  tvdb_id: number | null
  title: string
  year: number | null
  added_at: string
  imdb_id: string | null
  overview: string | null
  poster_path: string | null
}

/** An episode row (RawEpisodeRow in src/lib/api/media.ts). */
export type MockEpisodeRow = {
  id: number
  show_id: number
  season: number
  episode: number
  title: string | null
  air_date: string | null
  file_id: number
}

/** A persisted watch-progress row (RawWatchRow in src/lib/api/media.ts).
 *  `completed` is emitted as 0/1 by media-core (sqlite int); the mock keeps
 *  the same numeric form so the SPA's `Boolean(r.completed)` normalizer is
 *  exercised honestly. */
export type MockWatchRow = {
  media_kind: 'movie' | 'episode'
  media_id: number
  position_secs: number
  duration_secs: number | null
  watched_at: string
  completed: number
}

// ── Movies ────────────────────────────────────────────────────────────
//
// 12 titles. Every fixture's playable bytes are the single sample.mp4
// (Step 3); `duration_secs` below is the metadata the grant reports back —
// it may differ from the real file length (the player pins duration from
// the grant, per the plan).

export const MOVIES: MockMovieRow[] = [
  {
    id: 1,
    tmdb_id: 27205,
    imdb_id: 'tt1375666',
    title: 'Inception',
    year: 2010,
    added_at: '2026-01-04T18:22:00Z',
    file_id: 1001,
    overview:
      'A thief who steals corporate secrets through dream-sharing is given the inverse task of planting an idea.',
    poster_path: '/poster-inception.jpg',
  },
  {
    id: 2,
    tmdb_id: 157336,
    imdb_id: 'tt0816692',
    title: 'Interstellar',
    year: 2014,
    added_at: '2026-01-05T09:10:00Z',
    file_id: 1002,
    overview: 'Explorers travel through a wormhole in search of a new home for humanity.',
    poster_path: '/poster-interstellar.jpg',
  },
  {
    // No tmdb / no poster metadata — exercises the MediaCard first-letter
    // fallback and posterFor() returning undefined.
    id: 3,
    tmdb_id: null,
    imdb_id: null,
    title: 'Untracked Indie Short',
    year: 2021,
    added_at: '2026-01-06T12:00:00Z',
    file_id: 1003,
    overview: null,
    poster_path: null,
  },
  {
    // Very long title — exercises truncation / wrapping in the UI.
    id: 4,
    tmdb_id: 12345,
    imdb_id: 'tt9999991',
    title:
      'The Extraordinarily Long and Unreasonably Verbose Title of a Film Nobody Could Possibly Fit on a Single Card Line',
    year: 2019,
    added_at: '2026-01-07T15:30:00Z',
    file_id: 1004,
    overview: 'A test of how the UI handles an absurdly long title string.',
    poster_path: '/poster-long.jpg',
  },
  {
    // Year edge case: a silent-era classic (very old year).
    id: 5,
    tmdb_id: 3059,
    imdb_id: 'tt0017136',
    title: 'Metropolis',
    year: 1927,
    added_at: '2026-01-08T08:45:00Z',
    file_id: 1005,
    overview:
      'In a futuristic city sharply divided between workers and planners, the son of the city mastermind falls for a working-class prophet.',
    poster_path: '/poster-metropolis.jpg',
  },
  {
    // Year edge case: null year (unknown release).
    id: 6,
    tmdb_id: null,
    imdb_id: null,
    title: 'Unknown Release Year Documentary',
    year: null,
    added_at: '2026-01-09T19:05:00Z',
    file_id: 1006,
    overview: 'A documentary whose release year was never resolved during scan.',
    poster_path: null,
  },
  {
    // Year edge case: near-future scheduled title.
    id: 7,
    tmdb_id: 88888,
    imdb_id: 'tt8888888',
    title: 'Tomorrow Premiere',
    year: 2030,
    added_at: '2026-01-10T11:11:00Z',
    file_id: 1007,
    overview: 'A title dated in the near future to exercise forward-year handling.',
    poster_path: '/poster-tomorrow.jpg',
  },
  {
    id: 8,
    tmdb_id: 603,
    imdb_id: 'tt0133093',
    title: 'The Matrix',
    year: 1999,
    added_at: '2026-01-11T22:00:00Z',
    file_id: 1008,
    overview:
      'A computer hacker learns the true nature of his reality and his role in the war against its controllers.',
    poster_path: '/poster-matrix.jpg',
  },
  {
    id: 9,
    tmdb_id: 680,
    imdb_id: 'tt0110912',
    title: 'Pulp Fiction',
    year: 1994,
    added_at: '2026-01-12T07:30:00Z',
    file_id: 1009,
    overview:
      'The lives of two mob hitmen, a boxer, a gangster and his wife intertwine in four tales of violence and redemption.',
    poster_path: '/poster-pulp.jpg',
  },
  {
    id: 10,
    tmdb_id: 13,
    imdb_id: 'tt0109830',
    title: 'Forrest Gump',
    year: 1994,
    added_at: '2026-01-13T16:40:00Z',
    file_id: 1010,
    overview:
      'The history of the United States from the 1950s to the 1970s unfolds from the perspective of an Alabama man.',
    poster_path: '/poster-gump.jpg',
  },
  {
    // tmdb present but poster absent — partial-metadata state.
    id: 11,
    tmdb_id: 550,
    imdb_id: 'tt0137523',
    title: 'Fight Club',
    year: 1999,
    added_at: '2026-01-14T13:20:00Z',
    file_id: 1011,
    overview:
      'An insomniac office worker and a soap maker form an underground fight club that evolves into something much more.',
    poster_path: null,
  },
  {
    id: 12,
    tmdb_id: 769,
    imdb_id: 'tt0099685',
    title: 'GoodFellas',
    year: 1990,
    added_at: '2026-01-15T20:55:00Z',
    file_id: 1012,
    overview:
      'The story of Henry Hill and his life in the mob, covering his relationship with his wife and his mob partners.',
    poster_path: '/poster-goodfellas.jpg',
  },
]

// ── Shows ─────────────────────────────────────────────────────────────
//
// 3 shows, each with 6 episodes (below). Variety mirrors the movies:
// missing metadata, a long title, a null year.

export const SHOWS: MockShowRow[] = [
  {
    id: 101,
    tmdb_id: 1396,
    tvdb_id: 81189,
    title: 'Breaking Bad',
    year: 2008,
    added_at: '2026-02-01T10:00:00Z',
    imdb_id: 'tt0903747',
    overview:
      'A chemistry teacher diagnosed with cancer turns to manufacturing methamphetamine to secure his family’s future.',
    poster_path: '/poster-bb.jpg',
  },
  {
    // No tmdb/tvdb/poster — fallback state for shows.
    id: 102,
    tmdb_id: null,
    tvdb_id: null,
    title: 'Local Access Variety Hour',
    year: null,
    added_at: '2026-02-02T14:30:00Z',
    imdb_id: null,
    overview: null,
    poster_path: null,
  },
  {
    // Long title + future year.
    id: 103,
    tmdb_id: 94605,
    tvdb_id: 371028,
    title: 'An Exceedingly Long Series Title That Tests How Episode Lists Render Their Header',
    year: 2029,
    added_at: '2026-02-03T18:15:00Z',
    imdb_id: 'tt7777770',
    overview: 'A series with a deliberately long title and a future air year.',
    poster_path: '/poster-long-show.jpg',
  },
]

/** Build 6 episodes (S01E01..E06) for a show. The last episode carries a
 *  null title + null air_date to exercise the SPA's nullable episode
 *  fields. */
function episodesFor(showId: number, baseEpisodeId: number): MockEpisodeRow[] {
  const rows: MockEpisodeRow[] = []
  for (let ep = 1; ep <= 6; ep++) {
    const isLast = ep === 6
    rows.push({
      id: baseEpisodeId + ep,
      show_id: showId,
      season: 1,
      episode: ep,
      title: isLast ? null : `Episode ${ep}`,
      air_date: isLast ? null : `2026-03-${String(ep).padStart(2, '0')}`,
      file_id: baseEpisodeId + ep + 5000,
    })
  }
  return rows
}

export const EPISODES: MockEpisodeRow[] = [
  ...episodesFor(101, 2000),
  ...episodesFor(102, 2100),
  ...episodesFor(103, 2200),
]

// ── Watch-progress seed ───────────────────────────────────────────────
//
// Two partially-watched titles so the continue-watching UI has data on
// first load. The mock copies these into a mutable Map at startup; the
// originals here are never mutated.

export const SEED_WATCH_ROWS: MockWatchRow[] = [
  {
    media_kind: 'movie',
    media_id: 1, // Inception, ~40% through
    position_secs: 2880,
    duration_secs: 7200,
    watched_at: '2026-06-10T21:00:00Z',
    completed: 0,
  },
  {
    media_kind: 'episode',
    media_id: 2001, // Breaking Bad S01E01, ~25% through
    position_secs: 690,
    duration_secs: 2760,
    watched_at: '2026-06-11T19:30:00Z',
    completed: 0,
  },
]

/** Composite key for the in-memory watch store (matches the SPA's upsert
 *  identity: one row per (kind, id)). */
export function watchKey(kind: 'movie' | 'episode', id: number): string {
  return `${kind}:${id}`
}

/** The grant duration (seconds) the mock reports for a playable title. The
 *  player pins playback duration from the grant, so this drives the
 *  scrubber length regardless of the sample file's real runtime. Derived
 *  from the file_id so it's deterministic without a per-title table. */
export function durationForFile(fileId: number): number {
  return 1800 + (fileId % 7) * 600
}

/** Look up a playable title (movie or episode) by kind+id, returning its
 *  file_id, or null when the id is unknown (the grant maps null → 404). */
export function findPlayable(
  kind: string,
  id: number,
): { fileId: number; durationSecs: number } | null {
  if (kind === 'movie') {
    const m = MOVIES.find((row) => row.id === id)
    return m ? { fileId: m.file_id, durationSecs: durationForFile(m.file_id) } : null
  }
  if (kind === 'episode') {
    const e = EPISODES.find((row) => row.id === id)
    return e ? { fileId: e.file_id, durationSecs: durationForFile(e.file_id) } : null
  }
  return null
}
