// Guide-category curation — a port of the Apple app's EmeraldKit
// `GuideCategories` + `GuideCategoryPrefs`.
//
// Real Xtream providers carry ~12–17k has-EPG channels across hundreds of
// categories; loading them all on every guide open buries the channels anyone
// actually watches (and is a heavy payload). The default guide set is
// **US channels + Sports** — the "Guide categories" picker lets the viewer add
// more, persisted as a CSV of category ids in localStorage.
//
// The default is pure name-matching against the loaded category list (the only
// category metadata the client has — an EPG grid row carries none). Swap
// `isDefaultGuideCategory` for a server-driven default if one ever ships.
import type { CategoryDto } from './api/iptv'

/** localStorage key holding the CSV of selected guide category ids. */
export const GUIDE_CATEGORY_KEY = 'guide.categoryIds'

/**
 * True when a category name reads as US-region or sports. "US" is matched as the
 * leading *token* so "US| News", "USA Sports", "US - Locals" hit while "MUSIC",
 * "PLUS", "AUSTRALIA" don't (those merely contain the letters "US").
 */
export function isDefaultGuideCategory(name: string): boolean {
  const upper = name.toUpperCase()
  if (upper.includes('SPORT')) return true
  // First alphabetic run, e.g. "US| News" → "US", "USA| Sports" → "USA".
  const firstToken = upper.match(/[A-Z]+/)?.[0] ?? ''
  return firstToken === 'US' || firstToken === 'USA'
}

/** Category ids to seed the guide with: every US-region category plus anything
 *  sports, in catalog order. */
export function defaultGuideSelection(categories: CategoryDto[]): number[] {
  return categories.filter((c) => isDefaultGuideCategory(c.name)).map((c) => c.category_id)
}

export function parseGuideCategoryCsv(csv: string): number[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    // Drop empty/non-numeric tokens (JS `Number('')` is 0, so guard before parsing).
    .filter((s) => s.length > 0)
    .map(Number)
    .filter((n) => Number.isInteger(n))
}

export function formatGuideCategoryCsv(ids: number[]): string {
  return ids.join(',')
}

/**
 * The category ids the guide should actually load given the stored pref and the
 * loaded category list. Stored ids are intersected with what still exists; an
 * unset/empty pref (or one that no longer matches any live category) falls back
 * to the US+sports default — so a fresh client gets the curated guide before the
 * viewer ever opens the picker, and emptying the selection reverts to default
 * rather than blanking the guide.
 */
export function effectiveGuideCategoryIds(csv: string, categories: CategoryDto[]): number[] {
  const live = new Set(categories.map((c) => c.category_id))
  const chosen = parseGuideCategoryCsv(csv).filter((id) => live.has(id))
  return chosen.length > 0 ? chosen : defaultGuideSelection(categories)
}

// ponytail: localStorage access wrapped so a disabled-storage browser (private
// mode quota, etc.) degrades to the default set instead of throwing.
export function readGuideCategoryCsv(): string {
  try {
    return localStorage.getItem(GUIDE_CATEGORY_KEY) ?? ''
  } catch {
    return ''
  }
}

export function writeGuideCategoryCsv(csv: string): void {
  try {
    localStorage.setItem(GUIDE_CATEGORY_KEY, csv)
  } catch {
    /* storage unavailable — selection just isn't persisted this session */
  }
}
