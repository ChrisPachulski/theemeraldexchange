// Shared release-browser view state (sort + language/season filter + regex).
//
// Module-scoped, per item-kind, so it survives DetailModal unmount/remount
// within a session without a store — AND is shared between the Advanced release
// browser (ArrAdvancedPanel) and the Add dialogs' Language control, so setting
// the language in one place is reflected in the other. Accessed via
// getReleaseView/setReleaseView so components never assign the module variable
// directly (react-hooks/immutability lint).
//
// `filter` defaults to 'english': the household wants English releases by
// default, so the language control opens on English and the release browser
// pre-filters to English (switch to "Any" to see every language).

export type ReleaseKind = 'movie' | 'tv'
export type SortKey = 'seeders' | 'quality' | 'size' | 'age'
export type SortState = { key: SortKey; dir: 'asc' | 'desc' }
export type ReleaseFilter = 'all' | 'season-pack' | 'not-season-pack' | 'english'
export type ReleaseView = { sort: SortState; filter: ReleaseFilter; regex: string }

const releaseViews: Record<ReleaseKind, ReleaseView> = {
  tv: { sort: { key: 'quality', dir: 'desc' }, filter: 'english', regex: '' },
  movie: { sort: { key: 'seeders', dir: 'desc' }, filter: 'english', regex: '' },
}

export function getReleaseView(kind: ReleaseKind): ReleaseView {
  return releaseViews[kind]
}

export function setReleaseView(kind: ReleaseKind, next: Partial<ReleaseView>): void {
  releaseViews[kind] = { ...releaseViews[kind], ...next }
}

// The two-way mapping between the Add dialog's Language <select> and the shared
// release filter. The dialog exposes only English vs Any (the language axis);
// it must not clobber a season-pack filter the user set in the browser, so
// "Any" maps to 'all' ONLY when the stored filter is the english language
// filter — otherwise it leaves a non-language filter (season-pack) intact.
export type AddLanguage = 'english' | 'any'

export function languageFromFilter(filter: ReleaseFilter): AddLanguage {
  return filter === 'english' ? 'english' : 'any'
}

export function filterForLanguage(language: AddLanguage, current: ReleaseFilter): ReleaseFilter {
  if (language === 'english') return 'english'
  // english -> any: clear the language filter; preserve a season-pack filter.
  return current === 'english' ? 'all' : current
}
