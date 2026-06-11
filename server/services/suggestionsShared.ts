// server/services/suggestionsShared.ts
//
// Types and pure helpers shared across the suggestions route and its
// services (TMDB client, prompt builder, pick validator). Stateless on
// purpose: modules that own caches import from here, never the other
// way around, so the suggestions dependency graph stays acyclic.

// Provenance — WHERE this card actually came from. Lets the UI render
// a personalized pick differently from a trending fill, and lets the
// household member tell at a glance whether the strip is doing its job
// or quietly degrading. Trust scaffolding (rubric dim 7).
//   'personalized' — Claude submitted it, validator accepted it
//   'discover'     — TMDB /discover library-genre fill (taste-aware fallback)
//   'trending'     — TMDB /trending fill (last resort)
export type SuggestionProvenance = 'personalized' | 'discover' | 'trending'

export type SuggestionItem = {
  id: number
  title: string
  posterPath: string | null
  overview?: string
  year?: number
  // Per-pick provenance + reason. Populated on every return path so
  // the UI can render an honest signal even when the response source
  // is a mix (e.g. `personalized_filled`). `reason` is a tight, ≤120-char
  // string when present — populated for personalized picks from
  // Claude's own short rationale; null for fills.
  provenance?: SuggestionProvenance
  reason?: string | null
  available_on?: string[]
}

export type ClaudePick = {
  title: string
  year?: number
  // Optional: a single tight clause Claude returns when it can ground
  // the pick in a library neighbor or like signal. Surfaced verbatim
  // as the per-card reason — voice constraint enforced by the tool
  // schema's description, NOT by post-trimming, because Claude tends
  // to comply better when the field is described as "short" up-front.
  reason?: string
}

// How many items each suggestions response aims to return.
export const TARGET_COUNT = 20

/** Concurrency-bounded map that preserves input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// Normalize a title for cross-source matching. Sonarr/Radarr's title
// and TMDB's title sometimes disagree on punctuation, articles, or
// suffixes. Lowercase, strip leading articles, drop non-alphanumeric.
export function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim()
}

// Base title — everything before the first subtitle separator
// (`:`, em-dash, en-dash, ` - `). Catches the very common case where
// Sonarr stores "A Knight of the Seven Kingdoms: The Hedge Knight"
// but TMDB / Claude refer to it as "A Knight of the Seven Kingdoms"
// (or vice versa). Empty when the title has no subtitle.
export function normalizeTitleBase(t: string): string {
  const cut = t.split(/[:—–]|\s-\s/)[0]
  if (!cut || cut === t) return ''
  const normalized = normalizeTitle(cut)
  // Short bases (≤4 chars) collide with too many unrelated titles:
  // "It: Chapter Two" → "it" blocked every "It" anything; "Up:
  // Special Edition" → "up" blocked every two-letter pick. Long
  // enough to be a meaningful franchise root, short enough to still
  // catch real subtitle dedupes like "starwars" or "missionimpossible".
  if (normalized.length < 5) return ''
  return normalized
}

// Build the matchable-title set from a list of entries. By default
// includes both the full normalized title and the base (pre-subtitle)
// form when the title has a subtitle — appropriate for the library
// (a different cut of an owned title is still a dupe).
//
// For the rejection set, pass {includeBase: false}. Rejecting one
// franchise entry ("Avatar: The Last Airbender") should NOT blanket-
// ban every other work sharing the franchise root ("Avatar: The Way
// of Water" is an unrelated film). The id-set check still catches
// exact-id rejections; only the title surface narrows here.
export function titleSetFrom(
  entries: Array<{ title: string }>,
  opts: { includeBase?: boolean } = {},
): Set<string> {
  const includeBase = opts.includeBase ?? true
  const out = new Set<string>()
  for (const e of entries) {
    if (!e.title) continue
    out.add(normalizeTitle(e.title))
    if (includeBase) {
      const base = normalizeTitleBase(e.title)
      if (base) out.add(base)
    }
  }
  return out
}

// Does a pick title match anything in the set? Checks the pick's
// full and base forms against the set.
export function titleMatches(pick: string, set: Set<string>): boolean {
  if (set.size === 0) return false
  if (set.has(normalizeTitle(pick))) return true
  const base = normalizeTitleBase(pick)
  if (base && set.has(base)) return true
  return false
}

// Fisher-Yates shuffle — mutates and returns the array. Used to
// randomize the candidate pool order per refresh so Claude sees a
// different numbered list each call even when the TMDB cache is warm.
// The pool is a per-request copy (filterHouseholdSafe returns a new
// array), so mutating it is safe.
export function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]!
    arr[j] = tmp!
  }
  return arr
}
