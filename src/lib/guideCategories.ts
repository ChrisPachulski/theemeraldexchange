// Guide-category curation — a port of the Apple app's EmeraldKit
// `GuideCategories` + `GuideCategoryPrefs`.
//
// Real Xtream providers carry ~12–17k has-EPG channels across hundreds of
// categories; loading them all on every guide open buries the channels anyone
// actually watches (and is a heavy payload). The default guide set is
// **US channels + Sports** — the "Guide categories" picker lets the viewer add
// more, persisted in localStorage.
//
// The selection is stored by category NAME, not id: the provider renumbers its
// categories on every sync, so a stored id drifts onto an unrelated row (the
// Apple app saw a saved "US Sports" become "XXX"). The old id-keyed pref
// (`guide.categoryIds`) is never read again.
//
// The default is pure name-matching against the loaded category list (the only
// category metadata the client has — an EPG grid row carries none). Swap
// `isDefaultGuideCategory` for a server-driven default if one ever ships.
import type { CategoryDto } from './api/iptv'

/** localStorage key holding the newline-separated selected category names. */
export const GUIDE_CATEGORY_KEY = 'guide.categoryNames'

const ADULT_TOKENS = new Set(['XXX', 'ADULT', 'ADULTS', 'PORN', '18+', 'ONLYFANS'])

/**
 * True when a category name marks provider adult content. Xtream panels don't
 * flag these, so the name is the only signal. Matched on whole tokens, so a
 * word merely containing "xxx" is not caught.
 */
export function isAdultCategory(name: string): boolean {
  return name
    .toUpperCase()
    .split(/[^\p{L}\p{N}+]+/u)
    .some((token) => ADULT_TOKENS.has(token))
}

/**
 * True when a category name reads as US-region or sports. "US" is matched as the
 * leading *token* so "US| News", "USA Sports", "US - Locals" hit while "MUSIC",
 * "PLUS", "AUSTRALIA" don't (those merely contain the letters "US"). Adult
 * categories never qualify, whatever region prefix they carry.
 */
export function isDefaultGuideCategory(name: string): boolean {
  if (isAdultCategory(name)) return false
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

// Newline-separated: provider names contain commas and pipes, never newlines.
export function parseGuideCategoryNames(stored: string): string[] {
  return stored
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function formatGuideCategoryNames(names: string[]): string {
  return names.join('\n')
}

const normalizeName = (name: string): string => name.trim().toUpperCase()

/** Resolves stored names to the ids the catalog assigns them today, in catalog
 *  order, never including an adult category. Case-insensitive. */
export function guideCategoryIdsForNames(names: string[], categories: CategoryDto[]): number[] {
  const wanted = new Set(names.map(normalizeName))
  return categories
    .filter((c) => wanted.has(normalizeName(c.name)) && !isAdultCategory(c.name))
    .map((c) => c.category_id)
}

/**
 * The category ids the guide should actually load given the stored pref and the
 * loaded category list. Stored names resolve to whatever id they have today; an
 * unset/empty pref (or one naming nothing that still exists) falls back to the
 * US+sports default — so a fresh client gets the curated guide before the
 * viewer ever opens the picker, and emptying the selection reverts to default
 * rather than blanking the guide. Empty only when the provider has nothing
 * that qualifies; the guide then fails closed instead of loading everything.
 */
export function effectiveGuideCategoryIds(stored: string, categories: CategoryDto[]): number[] {
  const chosen = guideCategoryIdsForNames(parseGuideCategoryNames(stored), categories)
  return chosen.length > 0 ? chosen : defaultGuideSelection(categories)
}

// ponytail: localStorage access wrapped so a disabled-storage browser (private
// mode quota, etc.) degrades to the default set instead of throwing.
export function readGuideCategoryNames(): string {
  try {
    return localStorage.getItem(GUIDE_CATEGORY_KEY) ?? ''
  } catch {
    return ''
  }
}

export function writeGuideCategoryNames(stored: string): void {
  try {
    localStorage.setItem(GUIDE_CATEGORY_KEY, stored)
  } catch {
    /* storage unavailable — selection just isn't persisted this session */
  }
}
