import { describe, it, expect } from 'vitest'
import {
  filterAndSortLibrary,
  byTitleAsc,
  byTitleDesc,
  byYearAsc,
  byYearDesc,
  byAddedDesc,
  byRatingDesc,
  movieRating,
  distinctGenres,
  topGenres,
  releaseDay,
  browseShelves,
} from './librarySort'

type Row = { title: string; year?: number | null; status?: string | null }

const lib: Row[] = [
  { title: 'The Matrix', year: 1999, status: 'released' },
  { title: 'Akira', year: 1988, status: 'released' },
  { title: 'Dune', year: 2021, status: 'announced' },
]

describe('filterAndSortLibrary', () => {
  it('returns [] for undefined data and never mutates the input', () => {
    expect(filterAndSortLibrary(undefined, { query: '', status: 'all' })).toEqual([])
    const copy = [...lib]
    filterAndSortLibrary(lib, { query: '', status: 'all', comparator: byTitleAsc })
    expect(lib).toEqual(copy)
  })

  it('text-filters case-insensitively on title', () => {
    const out = filterAndSortLibrary(lib, { query: 'matr', status: 'all' })
    expect(out.map((r) => r.title)).toEqual(['The Matrix'])
  })

  it('status-filters case-insensitively, with all = no filter', () => {
    expect(filterAndSortLibrary(lib, { query: '', status: 'announced' }).map((r) => r.title)).toEqual(['Dune'])
    expect(filterAndSortLibrary(lib, { query: '', status: 'all' })).toHaveLength(3)
  })

  it('applies the comparator when given, else preserves order', () => {
    const sorted = filterAndSortLibrary(lib, { query: '', status: 'all', comparator: byTitleAsc })
    // article-stripped: "The Matrix" sorts under M → Akira, Dune, Matrix
    expect(sorted.map((r) => r.title)).toEqual(['Akira', 'Dune', 'The Matrix'])
    expect(filterAndSortLibrary(lib, { query: '', status: 'all' }).map((r) => r.title)).toEqual([
      'The Matrix',
      'Akira',
      'Dune',
    ])
  })
})

describe('shared comparators', () => {
  it('byTitleAsc/Desc strip leading articles', () => {
    expect(byTitleAsc({ title: 'The Matrix' }, { title: 'Akira' })).toBeGreaterThan(0)
    expect(byTitleDesc({ title: 'The Matrix' }, { title: 'Akira' })).toBeLessThan(0)
  })

  it('byYearDesc/Asc order by year then fall back to title', () => {
    expect(byYearDesc({ title: 'A', year: 2000 }, { title: 'B', year: 1990 })).toBeLessThan(0)
    expect(byYearAsc({ title: 'A', year: 1990 }, { title: 'B', year: 2000 })).toBeLessThan(0)
    // same year → article-stripped title tiebreak
    expect(byYearDesc({ title: 'The Z', year: 2000 }, { title: 'A', year: 2000 })).toBeGreaterThan(0)
  })
})

describe('genre filter, added and rating sorts', () => {
  const shows = [
    { title: 'B', genres: ['Drama'], added: '2026-01-02T00:00:00Z', ratings: { value: 7 } },
    { title: 'A', genres: ['Comedy', 'drama'], added: '2026-03-01T00:00:00Z', ratings: { value: 9 } },
    { title: 'C', genres: ['Comedy'], added: '2026-02-01T00:00:00Z' },
  ]

  it('filters by genre case-insensitively, with all = no filter', () => {
    expect(filterAndSortLibrary(shows, { query: '', status: 'all', genre: 'Drama' }).map((r) => r.title)).toEqual(['B', 'A'])
    expect(filterAndSortLibrary(shows, { query: '', status: 'all', genre: 'all' })).toHaveLength(3)
  })

  it('sorts newest added first and best rated first, unrated last', () => {
    expect(shows.slice().sort(byAddedDesc).map((r) => r.title)).toEqual(['A', 'C', 'B'])
    expect(shows.slice().sort(byRatingDesc((s) => s.ratings?.value ?? 0)).map((r) => r.title)).toEqual(['A', 'B', 'C'])
  })

  it('movieRating falls back IMDb -> TMDB -> RT', () => {
    expect(movieRating({ ratings: { imdb: { value: 7.1 }, tmdb: { value: 8 } } })).toBe(7.1)
    expect(movieRating({ ratings: { tmdb: { value: 8 }, rottenTomatoes: { value: 90 } } })).toBe(8)
    expect(movieRating({ ratings: { rottenTomatoes: { value: 90 } } })).toBe(90)
    expect(movieRating({})).toBe(0)
  })

  it('distinctGenres is the A-Z union', () => {
    expect(distinctGenres(shows)).toEqual(['Comedy', 'drama', 'Drama'])
  })
})

describe('browse shelves', () => {
  it('topGenres needs minCount titles, most titles first, ties A-Z', () => {
    const lists = [['A', 'B'], ['A', 'B', 'B'], ['A', 'C'], ['B'], undefined]
    expect(topGenres(lists, 3, 2)).toEqual(['A', 'B'])
    expect(topGenres(lists, 1, 1)).toEqual(['A'])
  })

  it('releaseDay is the latest date on or before today', () => {
    expect(releaseDay(['2026-05-01T00:00:00Z', '2026-01-01', null, '2027-01-01'], '2026-10-10')).toBe('2026-05-01')
    expect(releaseDay(['2027-01-01', undefined], '2026-10-10')).toBeNull()
  })

  it('orders released, recent, then top-in-genre shelves', () => {
    const items = ['W', 'X', 'Y', 'Z'].map((title, i) => ({
      title,
      added: `2026-0${i + 1}-01`,
      genres: ['Drama'],
      score: i,
      out: title === 'Z' ? null : `2025-0${4 - i}-01`,
    }))
    const shelves = browseShelves(items, { noun: 'movies', rating: (t) => t.score, released: (t) => t.out })
    expect(shelves.map((s) => [s.label, s.items.map((t) => t.title).join('')])).toEqual([
      ['Recently released', 'WXY'],
      ['Recently added', 'ZYXW'],
      ['Top movies in Drama', 'ZYXW'],
    ])
    expect(browseShelves(items, { noun: 'shows', rating: () => 0 }).map((s) => s.key)).toEqual(['recent', 'genre-Drama'])
  })
})

describe('filterAndSortLibrary search', () => {
  it('finds a hyphenated title from a spaced query (the scooby doo report)', () => {
    const lib = [{ title: 'Scooby-Doo, Where Are You!' }, { title: "What's New, Scooby-Doo?" }, { title: 'Scrubs' }]
    expect(filterAndSortLibrary(lib, { query: 'scooby doo', status: 'all' }).map((r) => r.title)).toEqual([
      'Scooby-Doo, Where Are You!',
      "What's New, Scooby-Doo?",
    ])
  })
})
