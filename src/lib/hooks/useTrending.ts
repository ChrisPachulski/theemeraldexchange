// TrendingItem is the row shape that TrendingRow renders. Kept here
// for back-compat with components that imported it. The fetching hooks
// have moved to useSuggested.ts — Discover surfaces now ask Claude for
// personalized picks, with TMDB trending as the backend's cold-start
// fallback.

// Where this card actually came from. Mirrors the server-side
// SuggestionProvenance — duplicated here so TrendingItem (consumed by
// the rendered strip) doesn't have to import from useSuggested.
export type TrendingItemProvenance = 'personalized' | 'discover' | 'trending'

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
  /** Per-pick provenance — set by /api/suggestions, absent for the
   * legacy /api/trending callers that still hit TMDB directly. */
  provenance?: TrendingItemProvenance
  /** Short ≤120-char grounding from Claude when the pick is personalized.
   * Null for fills (discover/trending). */
  reason?: string | null
  available_on?: string[]
}
