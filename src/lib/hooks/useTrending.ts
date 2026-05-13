// TrendingItem is the row shape that TrendingRow renders. Kept here
// for back-compat with components that imported it. The fetching hooks
// have moved to useSuggested.ts — Discover surfaces now ask Claude for
// personalized picks, with TMDB trending as the backend's cold-start
// fallback.

export type TrendingItem = {
  /** TMDB id — used to look up the title in Sonarr/Radarr via tmdb:N. */
  id: number
  /** TV uses `name`, movies use `title`. TMDB returns whichever applies. */
  title: string
  /** TMDB poster_path; relative to https://image.tmdb.org/t/p/wNNN. */
  posterPath: string | null
  overview?: string
  /** Year extracted from release_date / first_air_date. */
  year?: number
}
