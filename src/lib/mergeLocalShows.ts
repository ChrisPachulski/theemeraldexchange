import type { Series, SeriesSearchResult } from './api/sonarr'
import type { MediaShow } from './api/media'

/** A library row: a Sonarr-tracked Series, or a show that only the local
 *  scanner knows (on disk / in Plex but never added to Sonarr). The latter
 *  is shaped like a search result so the detail modal offers "Watch
 *  episodes here" and, for admins, "Add to library". */
export type LibraryRow = Series | SeriesSearchResult

const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w342'

function localShowAsSeries(show: MediaShow): SeriesSearchResult {
  return {
    tvdbId: show.tvdbId ?? 0,
    tmdbId: show.tmdbId ?? undefined,
    imdbId: show.imdbId ?? undefined,
    title: show.title,
    year: show.year ?? 0,
    overview: show.overview ?? undefined,
    remotePoster: show.posterPath ? `${TMDB_POSTER_BASE}${show.posterPath}` : undefined,
  }
}

/** Sonarr library plus local-only shows, matched by TVDB then TMDB id. */
export function mergeLocalShows(sonarr: Series[] | undefined, local: MediaShow[] | undefined): LibraryRow[] {
  if (!sonarr) return []
  if (!local) return sonarr
  const tvdb = new Set(sonarr.map((s) => s.tvdbId))
  const tmdb = new Set(sonarr.map((s) => s.tmdbId).filter((x): x is number => typeof x === 'number'))
  const extra = local
    .filter((l) => !(l.tvdbId !== null && tvdb.has(l.tvdbId)) && !(l.tmdbId !== null && tmdb.has(l.tmdbId)))
    .map(localShowAsSeries)
  return [...sonarr, ...extra]
}

