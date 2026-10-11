// Guide rows shared by the grid (EpgGuide) and the in-player mini guide: the
// fetch window both use (so they share one react-query cache entry) and the
// row filter, a port of the Apple app's EmeraldKit `GuideSearch.filter`.
import type { EpgGridDto, EpgProgrammeDto } from './api/iptv'

export const GUIDE_BUCKET_MS = 30 * 60_000
export const GUIDE_HOURS = 6 // 30 min of history + 5.5h forward
// Cap the channel set fetched for the grid. The curated default (US + sports) is
// well under this, but a single big category could be large; the grid is
// virtualized client-side, so a generous cap is plenty (mirrors the Apple app's
// CatalogStore.guideChannelLimit).
export const GUIDE_CHANNEL_LIMIT = 500

/** The guide's fetch window: from the half hour before the current half-hour
 *  bucket, six hours long. Bucketed so the query key stays stable for 30 min. */
export function guideWindow(nowMs: number) {
  const anchorMs = Math.floor(nowMs / GUIDE_BUCKET_MS) * GUIDE_BUCKET_MS
  const startMs = anchorMs - GUIDE_BUCKET_MS
  const endMs = startMs + GUIDE_HOURS * 3600_000
  return {
    anchorMs,
    startMs,
    endMs,
    fromIso: new Date(startMs).toISOString(),
    toIso: new Date(endMs).toISOString(),
  }
}

const ms = (iso: string): number => new Date(iso).getTime()

/** The programme airing on a channel at `nowMs`, if any. */
export function airingNow(row: EpgGridDto, nowMs: number): EpgProgrammeDto | null {
  return (
    row.programmes.find((p) => {
      const s = ms(p.start_utc)
      const e = ms(p.stop_utc)
      return Number.isFinite(s) && Number.isFinite(e) && s <= nowMs && e > nowMs
    }) ?? null
  )
}

/**
 * Favorites float to the top with provider order kept within each half; then,
 * for a non-empty query, a row is kept when its channel name, its number, or
 * any programme's title or description contains the query (case-insensitive),
 * so typing "NBA" narrows the grid to the channels carrying it.
 */
export function filterGuideRows(
  rows: EpgGridDto[],
  query: string,
  favorites: ReadonlySet<number>,
): EpgGridDto[] {
  const pinned =
    favorites.size === 0
      ? rows
      : [...rows.filter((r) => favorites.has(r.stream_id)), ...rows.filter((r) => !favorites.has(r.stream_id))]
  const q = query.trim().toLowerCase()
  if (!q) return pinned
  const has = (text: string | null) => !!text && text.toLowerCase().includes(q)
  return pinned.filter(
    (row) =>
      has(row.name) ||
      String(row.num).includes(q) ||
      row.programmes.some((p) => has(p.title) || has(p.description)),
  )
}
