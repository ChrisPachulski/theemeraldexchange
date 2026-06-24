import { stripArticle } from './title'

// Shared library filter + sort for the Movies/TV tabs. Both tabs text+status
// filter then sort by the same key set; only their domain-specific comparators
// (movie runtime/studio vs TV network) differ. Each tab passes the resolved
// comparator and keeps its own map, so the scaffold + the title/year keys live
// in one place instead of drifting between two near-identical copies.

export interface LibraryItem {
  title: string
  status?: string | null
}

// Article-stripped title sort (Plex behavior — "The Mandalorian" sorts under M).
type TitleYear = { title: string; year?: number | null }
export const byTitleAsc = (a: TitleYear, b: TitleYear): number =>
  stripArticle(a.title).localeCompare(stripArticle(b.title))
export const byTitleDesc = (a: TitleYear, b: TitleYear): number =>
  stripArticle(b.title).localeCompare(stripArticle(a.title))
export const byYearDesc = (a: TitleYear, b: TitleYear): number =>
  (b.year ?? 0) - (a.year ?? 0) || byTitleAsc(a, b)
export const byYearAsc = (a: TitleYear, b: TitleYear): number =>
  (a.year ?? 0) - (b.year ?? 0) || byTitleAsc(a, b)

export function filterAndSortLibrary<T extends LibraryItem>(
  data: T[] | undefined,
  opts: { query: string; status: string; comparator?: (a: T, b: T) => number },
): T[] {
  if (!data) return []
  const q = opts.query.trim().toLowerCase()
  const items = q
    ? data.filter((it) => it.title.toLowerCase().includes(q))
    : data.slice()
  const filtered =
    opts.status === 'all'
      ? items
      : items.filter((it) => (it.status ?? '').toLowerCase() === opts.status.toLowerCase())
  return opts.comparator ? filtered.sort(opts.comparator) : filtered
}
