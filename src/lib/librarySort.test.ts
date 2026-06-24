import { describe, it, expect } from 'vitest'
import {
  filterAndSortLibrary,
  byTitleAsc,
  byTitleDesc,
  byYearAsc,
  byYearDesc,
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
