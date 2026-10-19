import { stripArticle } from './title'
import { matchesWords } from './wordMatch'

// Shared library filter + sort for the Movies/TV tabs. Both tabs text+status
// filter then sort by the same key set; only their domain-specific comparators
// (movie runtime/studio vs TV network) differ. Each tab passes the resolved
// comparator and keeps its own map, so the scaffold + the title/year keys live
// in one place instead of drifting between two near-identical copies.

export interface LibraryItem {
  title: string
  status?: string | null
  genres?: string[]
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

// *arr `added` is ISO-8601, so the string order is the time order.
type Added = TitleYear & { added?: string | null }
export const byAddedDesc = (a: Added, b: Added): number =>
  (b.added ?? '').localeCompare(a.added ?? '') || byTitleAsc(a, b)

/** Highest rating first, unrated last (Apple LibraryScreens sort). */
export const byRatingDesc =
  <T extends TitleYear>(rating: (t: T) => number) =>
  (a: T, b: T): number =>
    rating(b) - rating(a) || byTitleAsc(a, b)

/** Radarr sort score: IMDb, else TMDB, else Rotten Tomatoes (Apple Arr.swift). */
export const movieRating = (m: {
  ratings?: { imdb?: { value?: number }; tmdb?: { value?: number }; rottenTomatoes?: { value?: number } }
}): number => m.ratings?.imdb?.value || m.ratings?.tmdb?.value || m.ratings?.rottenTomatoes?.value || 0

/** Sonarr carries a single (TVDB) score. */
export const seriesRating = (s: { ratings?: { value?: number } }): number => s.ratings?.value ?? 0

export function filterAndSortLibrary<T extends LibraryItem>(
  data: T[] | undefined,
  opts: { query: string; status: string; genre?: string; comparator?: (a: T, b: T) => number },
): T[] {
  if (!data) return []
  const items = opts.query.trim()
    ? data.filter((it) => matchesWords(it.title, opts.query))
    : data.slice()
  const byStatus =
    opts.status === 'all'
      ? items
      : items.filter((it) => (it.status ?? '').toLowerCase() === opts.status.toLowerCase())
  const genre = opts.genre && opts.genre !== 'all' ? opts.genre.toLowerCase() : null
  const filtered = genre
    ? byStatus.filter((it) => it.genres?.some((g) => g.toLowerCase() === genre))
    : byStatus
  return opts.comparator ? filtered.sort(opts.comparator) : filtered
}

/** Every genre the (already rating-capped) library carries, A-Z. */
export function distinctGenres(items: ReadonlyArray<{ genres?: string[] }> | undefined): string[] {
  return [...new Set((items ?? []).flatMap((it) => it.genres ?? []))].sort((a, b) => a.localeCompare(b))
}

// ── Browse shelves (Apple Spotlight.swift LibraryShelves) ───────────────

export const SHELF_CAP = 12

/** The most common genres, most titles first (ties A-Z), each carried by at
 *  least `minCount` titles so a shelf never shows one lonely poster. */
export function topGenres(lists: ReadonlyArray<string[] | undefined>, limit: number, minCount = 4): string[] {
  const counts = new Map<string, number>()
  for (const list of lists) for (const g of new Set(list ?? [])) counts.set(g, (counts.get(g) ?? 0) + 1)
  return [...counts]
    .filter(([, n]) => n >= minCount)
    .sort(([ga, a], [gb, b]) => b - a || ga.localeCompare(gb))
    .slice(0, limit)
    .map(([g]) => g)
}

/** The latest release (digital, physical or theatrical) on or before `today`
 *  (yyyy-mm-dd), as yyyy-mm-dd; null when nothing is out yet. */
export function releaseDay(dates: ReadonlyArray<string | null | undefined>, today: string): string | null {
  let best: string | null = null
  for (const d of dates) {
    const day = d?.slice(0, 10)
    if (day && day.length === 10 && day <= today && (best === null || day > best)) best = day
  }
  return best
}

export type Shelf<T> = { key: string; label: string; items: T[] }

/** Recently released (when `released` is given), Recently added, then Top
 *  <noun> in each of the 3 most common genres, best rated first. `available`
 *  is the rating-capped library narrowed to titles with something to play. */
export function browseShelves<T extends Added & { genres?: string[] }>(
  available: T[],
  opts: { noun: string; rating: (t: T) => number; released?: (t: T) => string | null },
): Shelf<T>[] {
  const shelves: Shelf<T>[] = []
  const { released } = opts
  if (released) {
    const items = available
      .flatMap((t) => {
        const day = released(t)
        return day ? [{ t, day }] : []
      })
      .sort((a, b) => b.day.localeCompare(a.day))
      .slice(0, SHELF_CAP)
      .map(({ t }) => t)
    if (items.length) shelves.push({ key: 'released', label: 'Recently released', items })
  }
  const recent = available.slice().sort(byAddedDesc).slice(0, SHELF_CAP)
  if (recent.length) shelves.push({ key: 'recent', label: 'Recently added', items: recent })
  for (const genre of topGenres(available.map((t) => t.genres), 3)) {
    const items = available
      .filter((t) => t.genres?.includes(genre))
      .sort(byRatingDesc(opts.rating))
      .slice(0, SHELF_CAP)
    shelves.push({ key: `genre-${genre}`, label: `Top ${opts.noun} in ${genre}`, items })
  }
  return shelves
}
