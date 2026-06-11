// server/services/suggestionsContext.ts
//
// Per-request context assembled exactly once by the suggestions route
// (after the library/rejections/feedback snapshot and household-filter
// construction) and handed to the path runners. Sets and filter
// closures are shared by reference; runners never mutate them.

import type { Session } from '../session.js'
import type { getRejections } from './rejections.js'
import type { getUserFeedback } from './userFeedback.js'
import type { LibraryItem } from './suggestionsLibrary.js'
import type { SuggestionItem } from './suggestionsShared.js'

// Shape of the route's Server-Timing collector (see makeTiming in
// routes/suggestions.ts) — runners add their own phase marks to it.
export type SuggestionsTiming = {
  mark: (name: string) => () => void
  header: () => string
}

export type SuggestionRequestContext = {
  kind: 'movie' | 'tv'
  session: Session
  library: LibraryItem[]
  kindRejections: Awaited<ReturnType<typeof getRejections>>['movie']
  // Already in flight from the route prologue; rejections on the
  // early-return paths are pre-handled there (no-op .catch attached).
  userFeedbackPromise: ReturnType<typeof getUserFeedback>
  rejectedIds: Set<number>
  libraryTmdbIds: Set<number>
  rejectedTitles: Set<string>
  libraryTitles: Set<string>
  filterHouseholdSafe: (items: SuggestionItem[]) => SuggestionItem[]
  filterRecommenderSafe: (items: SuggestionItem[]) => SuggestionItem[]
  diag: (extra?: Record<string, unknown>) => Record<string, unknown>
  libraryGenres: string[]
  timing: SuggestionsTiming
  setTimingHeader: () => void
}
