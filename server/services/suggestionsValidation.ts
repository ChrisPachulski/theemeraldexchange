// server/services/suggestionsValidation.ts
//
// Validates Claude's picks against the household: title pre-checks
// (library/rejections) before any TMDB spend, a pool fast-path that
// skips /search entirely, then concurrency-bounded TMDB lookups with
// year-proximity / dedupe / id+title household re-checks. Returns the
// accepted items plus per-reason drop counters and the rejection
// feedback used to re-prompt Claude on the retry pass.

import {
  TARGET_COUNT,
  mapLimit,
  normalizeTitle,
  normalizeTitleBase,
  titleMatches,
  type ClaudePick,
  type SuggestionItem,
} from './suggestionsShared.js'
import { TMDB_LOOKUP_CONCURRENCY, tmdbLookup } from './suggestionsTmdb.js'

// Everything household-specific the validator needs, captured once per
// request by the route. Sets are shared by reference — the validator
// never mutates them.
export type PickValidationContext = {
  kind: 'movie' | 'tv'
  rejectedIds: Set<number>
  libraryTmdbIds: Set<number>
  rejectedTitles: Set<string>
  libraryTitles: Set<string>
  poolByTitle: Map<string, SuggestionItem[]>
}

export type PickValidationCounters = {
  lookupNulls: number
  droppedAsDedupe: number
  droppedAsRejected: number
  droppedAsLibrary: number
  droppedAsYearMismatch: number
  poolHits: number
}

export type PickValidationResult = {
  accepted: SuggestionItem[]
  rejectedForRetry: Array<{ title: string; reason: string }>
  counters: PickValidationCounters
}

export async function validatePicks(
  picks: ClaudePick[],
  ctx: PickValidationContext,
): Promise<PickValidationResult> {
  const { kind, rejectedIds, libraryTmdbIds, rejectedTitles, libraryTitles, poolByTitle } = ctx
  const accepted: SuggestionItem[] = []
  const rejectedForRetry: Array<{ title: string; reason: string }> = []
  const counters = { lookupNulls: 0, droppedAsDedupe: 0, droppedAsRejected: 0, droppedAsLibrary: 0, droppedAsYearMismatch: 0, poolHits: 0 }

  // Pre-validate by title BEFORE the TMDB lookup. If Claude's pick
  // title already matches a library or rejection title, we don't
  // need to burn a TMDB lookup just to reject it. This is the
  // single biggest TMDB load reduction — the call-2 rate-limit
  // failure mode that caused only 1–4 items to render.
  //
  // Also check the pool: if the pick title exactly matches a pool
  // item, we already have the TMDB id and metadata — skip the lookup.
  const survivors: Array<{ pick: ClaudePick; poolItem: SuggestionItem | null }> = []
  const seen = new Set<number>()
  for (const p of picks) {
    if (!p.title) continue
    if (titleMatches(p.title, rejectedTitles)) {
      counters.droppedAsRejected++
      rejectedForRetry.push({ title: p.title, reason: 'on the household NEVER SUGGEST list (matched by title)' })
      continue
    }
    if (titleMatches(p.title, libraryTitles)) {
      counters.droppedAsLibrary++
      rejectedForRetry.push({ title: p.title, reason: 'already in the household library (matched by title)' })
      continue
    }
    // Pool fast-path: if the pick title unambiguously matches a pool
    // item, accept it immediately without a TMDB /search round-trip.
    const poolMatches = poolByTitle.get(normalizeTitle(p.title)) ?? []
    const poolItem = p.year
      ? poolMatches.find((it) => it.year === p.year) ?? null
      : poolMatches.length === 1 ? poolMatches[0] : null
    if (poolItem) {
      if (seen.has(poolItem.id)) {
        counters.droppedAsDedupe++
        rejectedForRetry.push({ title: p.title, reason: 'duplicate of an earlier pick in this batch' })
        continue
      }
      counters.poolHits++
      seen.add(poolItem.id)
      const reason = typeof p.reason === 'string' && p.reason.trim().length > 0
        ? p.reason.trim().slice(0, 120)
        : null
      accepted.push({ ...poolItem, provenance: 'personalized', reason })
      if (accepted.length >= TARGET_COUNT) break
      continue
    }
    survivors.push({ pick: p, poolItem: null })
  }

  // Non-pool picks fall back to TMDB /search lookup.
  if (accepted.length < TARGET_COUNT) {
    const lookups = await mapLimit(survivors, TMDB_LOOKUP_CONCURRENCY, ({ pick }) =>
      tmdbLookup(kind, pick.title, pick.year).catch(() => null),
    )
    for (let i = 0; i < lookups.length; i++) {
      if (accepted.length >= TARGET_COUNT) break
      const r = lookups[i]
      const pick = survivors[i].pick
      const original = pick.title
      if (!r) {
        counters.lookupNulls++
        rejectedForRetry.push({ title: original, reason: 'TMDB lookup failed — title may be misspelled' })
        continue
      }
      // Year-proximity guard, movies only. TV has too many legitimate
      // year-mismatch cases (Claude giving the latest-season year vs
      // TMDB's series-premiere year; long-running shows; reboots that
      // share a name with originals) — the post-lookup library and
      // rejection re-checks already defend against genuinely-wrong
      // matches, and the in-lookup year-then-no-year retry handles
      // the disambiguation. For movies the guard still catches
      // remake confusion ("Heat" 1995 vs 1986).
      if (kind === 'movie' && pick.year && r.year && Math.abs(r.year - pick.year) > 5) {
        counters.droppedAsYearMismatch++
        rejectedForRetry.push({
          title: original,
          reason: `TMDB top match was "${r.title}" (${r.year}), but you asked for ${pick.year} — likely a different work; pick a closer title or use the exact year`,
        })
        continue
      }
      if (seen.has(r.id)) {
        counters.droppedAsDedupe++
        rejectedForRetry.push({ title: original, reason: 'duplicate of an earlier pick in this batch' })
        continue
      }
      if (rejectedIds.has(r.id) || titleMatches(r.title, rejectedTitles)) {
        counters.droppedAsRejected++
        rejectedForRetry.push({ title: original, reason: 'on the household NEVER SUGGEST list' })
        continue
      }
      if (libraryTmdbIds.has(r.id) || titleMatches(r.title, libraryTitles)) {
        counters.droppedAsLibrary++
        rejectedForRetry.push({ title: original, reason: 'already in the household library' })
        console.warn('[suggestions] library duplicate dropped:', {
          kind,
          pickId: r.id,
          pickTitle: r.title,
          normalized: { full: normalizeTitle(r.title), base: normalizeTitleBase(r.title) },
          matchedById: libraryTmdbIds.has(r.id),
          matchedByTitle: titleMatches(r.title, libraryTitles),
        })
        continue
      }
      seen.add(r.id)
      // Tag personalized provenance + carry Claude's reason through
      // validation. Trim to 120 chars defensively so a chatty model
      // can't blow up the response payload; the schema asks for ≤90.
      const reason = typeof pick.reason === 'string' && pick.reason.trim().length > 0
        ? pick.reason.trim().slice(0, 120)
        : null
      accepted.push({ ...r, provenance: 'personalized', reason })
    }
  }
  return { accepted, rejectedForRetry, counters }
}
