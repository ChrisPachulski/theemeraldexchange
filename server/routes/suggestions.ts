// Personalized library-aware suggestions for the Movies and TV
// Discover surfaces. On every refresh, this route:
//
//   1. Pulls the current library from Sonarr/Radarr.
//   2. Reads the persistent reject list.
//   3. Asks Claude (Haiku 4.5) for ranked recommendations grounded in
//      the household's actual taste, with rejections passed in-prompt
//      as "never suggest these."
//   4. Looks each title up in TMDB to enrich with id/poster/year.
//   5. Filters anything already in the library or on the reject list
//      (defense in depth — Claude is told but may slip).
//   6. Returns up to 20 items in TrendingItem shape so the existing
//      TrendingRow component is a drop-in consumer.
//
// Cold start: if the library has fewer than 3 items, falls back to
// TMDB's trending-this-week feed. Personalization is meaningless
// without a taste signal.
//
// Prompt caching: the system prompt + library + rejections are sent
// as one cached block (cache_control: ephemeral, 5-minute TTL). The
// per-request user message is short and varies — variety knob is
// temperature 0.8 plus prompt instruction to avoid identical lists.

// This file is deliberately thin: parse + auth the request, snapshot
// the household (library, rejections, feedback), build the household-
// safety filters, then dispatch to a path runner:
//
//   services/suggestionsRecommenderPath.ts — USE_LOCAL_RECOMMENDER=1
//   services/suggestionsClaudePath.ts      — legacy BYO-key pipeline
//
// Supporting services: suggestionsTmdb (TMDB client + caches),
// suggestionsPrompt (prompt building + Claude orchestration),
// suggestionsLibrary (Sonarr/Radarr snapshot cache),
// suggestionsRecentlyShown (rotation state), suggestionsValidation
// (pick validator), iptvAvailability + localAvailability (available_on
// taggers), suggestionsShared (types + pure helpers).

import { Hono } from 'hono'
import { requireAuth, type Env } from '../middleware/auth.js'
import { requireTrustedOrigin } from '../middleware/csrf.js'
import { getRejections } from '../services/rejections.js'
import { getUserFeedback } from '../services/userFeedback.js'
import { env } from '../env.js'
import {
  TARGET_COUNT,
  normalizeTitle,
  titleSetFrom,
  titleMatches,
  type SuggestionItem,
} from '../services/suggestionsShared.js'
import {
  LibraryUnavailableError,
  fetchLibraryCached,
  librarySnapshotAgeMs,
  type LibraryItem,
} from '../services/suggestionsLibrary.js'
import { tmdbKeyConfigured, tmdbTrending } from '../services/suggestionsTmdb.js'
import { computeGenreDistribution } from '../services/suggestionsPrompt.js'
import { tagIptvAvailability } from '../services/iptvAvailability.js'
import type { SuggestionRequestContext } from '../services/suggestionsContext.js'
import { runRecommenderSuggestionPath } from '../services/suggestionsRecommenderPath.js'
import { runClaudeSuggestionPath } from '../services/suggestionsClaudePath.js'

// Test escape hatches + helpers re-exported from their new service
// homes so existing imports keep working unchanged.
export { mapLimit } from '../services/suggestionsShared.js'
export type { SuggestionProvenance } from '../services/suggestionsShared.js'
export { _setTmdbApiKeyForTests, _resetTmdbInFlightForTests } from '../services/suggestionsTmdb.js'
export { _resetLibraryCacheForTests, _resetLibraryStaleFallbackForTests } from '../services/suggestionsLibrary.js'
export { _resetRecentlyShownForTests } from '../services/suggestionsRecentlyShown.js'

export const suggestions = new Hono<Env>()

suggestions.use('*', requireAuth)

// /:type below is a GET, but with USE_LOCAL_RECOMMENDER=1 it writes
// rec_log and recently_shown via the sidecar impression endpoint. The
// global CSRF gate skips GETs, so without an explicit Origin check
// here a hostile page could fire a credentialed GET (cookies are
// SameSite=None in prod) and poison a victim's recommendation
// rotation. requireTrustedOrigin opts back in to the same Origin
// allowlist the state-changing routes use.
suggestions.use('*', requireTrustedOrigin)

// Tiny timing collector — emits a Server-Timing response header so
// the browser devtools Network tab shows the per-phase breakdown.
// Names follow the Server-Timing spec (RFC 8673) so DevTools renders
// them as a stacked bar.
function makeTiming(): {
  mark: (name: string) => () => void
  header: () => string
} {
  const entries: Array<{ name: string; ms: number }> = []
  return {
    mark(name) {
      const start = performance.now()
      return () => entries.push({ name, ms: performance.now() - start })
    },
    header() {
      return entries.map((e) => `${e.name};dur=${e.ms.toFixed(1)}`).join(', ')
    },
  }
}

suggestions.get('/:type', async (c) => {
  const type = c.req.param('type')
  if (type !== 'movie' && type !== 'tv') {
    return c.json({ error: 'invalid_type' }, 400)
  }

  const timing = makeTiming()
  const setTimingHeader = () => {
    const h = timing.header()
    if (h) c.header('Server-Timing', h)
  }

  // ?force=trending — client opts out of the Claude call to avoid
  // burning tokens (e.g., the household-level AI toggle is off).
  // Same downstream shape as the cold-start path so the SPA renders
  // identically.
  const force = c.req.query('force')

  // Fully parallel prologue. The session is set by the auth middleware
  // before this handler runs, so feedback can race library/rejections.
  // Cost is bounded — feedback is a JSON read with module cache; even
  // when the request short-circuits to cold-start or trending, the
  // unawaited fetch settles harmlessly off the hot path.
  const session = c.get('session')
  // Don't swallow errors here. getUserFeedback already returns an empty
  // bucket cleanly on ENOENT (first run / unknown sub). Any other
  // failure — IO error, or the fail-closed parse-corruption path added
  // in round 12 — should surface as a 500 instead of silently
  // serving generic suggestions while real likes/dislikes are
  // unreachable.
  //
  // Several branches below early-return (force=trending, cold-start,
  // missing BYO key) WITHOUT awaiting this promise. Attach a no-op
  // handler so a rejection on those paths doesn't trigger Node's
  // unhandledRejection (which crashes the process under default
  // settings). Branches that actually consume the value still await
  // the original promise and re-throw — attaching a separate .catch
  // chain doesn't suppress that re-throw, it only marks the rejection
  // as "handled" for the unhandled-rejection bookkeeping.
  const userFeedbackPromise = getUserFeedback(session.sub)
  userFeedbackPromise.catch(() => {
    // intentional: handler exists so unhandledRejection won't fire on
    // early-return paths; consumption-side await still re-throws.
  })
  const endPrologue = timing.mark('prologue')
  let library: LibraryItem[]
  let rejections: Awaited<ReturnType<typeof getRejections>>
  try {
    ;[library, rejections] = await Promise.all([
      fetchLibraryCached(type),
      getRejections(),
    ])
  } catch (err) {
    endPrologue()
    setTimingHeader()
    // Without a real library, "show trending" silently leaks
    // already-owned titles back into the strip — the cold-start path
    // treats an empty library as "user has nothing." Surface the
    // failure instead so the SPA can show "library unavailable" and
    // retry on the next refresh.
    if (err instanceof LibraryUnavailableError) {
      return c.json(
        { error: 'library_unavailable', kind: type },
        502,
      )
    }
    throw err
  }
  endPrologue()

  const kindRejections = type === 'movie' ? rejections.movie : rejections.tv
  const rejected = new Set(kindRejections.map((r) => r.id))
  const libraryTmdbIds = new Set(
    library.map((l) => l.tmdbId).filter((id): id is number => typeof id === 'number'),
  )
  // Secondary library guard: Sonarr/Radarr entries without a tmdbId
  // wouldn't match the id set, and titles often disagree across
  // sources on subtitles ("X: The Y" vs "X"). titleSetFrom() includes
  // both the full normalized title and the pre-subtitle base form.
  const libraryTitles = titleSetFrom(library)
  // Full-title-only library set (no base form) for the recommender path —
  // see filterRecommenderSafe for why base-form franchise roots over-block.
  const libraryTitlesFull = titleSetFrom(library, { includeBase: false })
  // Rejections are exact-title only (no base form) — a "no" on
  // "Avatar: The Last Airbender" shouldn't blanket-ban every other
  // work in the Avatar franchise.
  const rejectedTitles = titleSetFrom(kindRejections, { includeBase: false })

  // Single household-aware filter used by EVERY return path —
  // personalized picks, cold-start trending, force=trending, claude-
  // error fallback, and the auto-fallback when picks all dropped.
  // Without this, trending-source paths used id-only filtering and
  // any library entry lacking a tmdbId slipped through as a
  // duplicate (e.g. A Knight of the Seven Kingdoms).
  function filterHouseholdSafe(items: SuggestionItem[]): SuggestionItem[] {
    return items.filter(
      (i) =>
        !rejected.has(i.id) &&
        !libraryTmdbIds.has(i.id) &&
        !titleMatches(i.title, rejectedTitles) &&
        !titleMatches(i.title, libraryTitles),
    )
  }

  // Recommender-path safety filter. The local recommender already excludes the
  // household's library, rejections, and dislikes BY ID (it receives all three
  // in the /score payload) plus its own library title-key dedup, and every item
  // it returns carries a real tmdb_id. So the id-less-leak protection that
  // filterHouseholdSafe adds for the trending/Claude paths is unnecessary here —
  // and its base-form title matching is actively harmful: `normalizeTitleBase`
  // collapses "Batman: Bad Blood" / "Terminator: Dark Fate" / "Transformers:
  // The Movie" to the franchise root ("batman"/"terminator"/"transformers"), so
  // owning ONE entry of a franchise blocked EVERY other distinct film in it.
  // Movies are franchise-dense, so this silently nuked ~13 of 20 picks (strip
  // collapsed to ~7); TV, which rarely uses "Franchise: Subtitle" naming, barely
  // noticed. Match by id and FULL normalized title only — exact-title duplicates
  // of an owned/rejected film are still suppressed (honoring the permanent veto
  // even across TMDB-duplicate ids), but distinct franchise entries survive.
  function filterRecommenderSafe(items: SuggestionItem[]): SuggestionItem[] {
    return items.filter((i) => {
      const full = normalizeTitle(i.title)
      return (
        !rejected.has(i.id) &&
        !libraryTmdbIds.has(i.id) &&
        !rejectedTitles.has(full) &&
        !libraryTitlesFull.has(full)
      )
    })
  }

  // Include top genre distribution in every diag response so the
  // personalization signal is observable: callers can compare what
  // Claude was instructed to mirror against what actually rendered.
  const libraryGenres = computeGenreDistribution(library, 5)
  const snapshotAgeMs = librarySnapshotAgeMs(type)
  const diag = (extra: Record<string, unknown> = {}) => ({
    libraryCount: library.length,
    rejectionCount: kindRejections.length,
    libraryGenres: libraryGenres.length > 0 ? libraryGenres : undefined,
    librarySnapshotAgeHours:
      snapshotAgeMs === undefined ? undefined : Number((snapshotAgeMs / 3_600_000).toFixed(2)),
    ...extra,
  })

  // Explicit "Trending" choice from the SPA's Recommended ⇄ Trending
  // toggle. Honor it in EVERY mode — including local-recommender mode,
  // which otherwise always personalizes and left no way to view trending
  // once the on-NAS model shipped. The SPA now sends ?force=trending ONLY
  // on an explicit user choice (no longer as the no-key escape hatch), so
  // this can't fire by accident and flip personalized households to
  // trending. Needs a TMDB key to source the feed; without one we fall
  // through to the recommender / cold-start paths below.
  if (force === 'trending' && tmdbKeyConfigured()) {
    const endTrending = timing.mark('trending')
    const trending = filterHouseholdSafe(await tmdbTrending(type)).map((it) => ({
      ...it,
      provenance: 'trending' as const,
      reason: null,
    }))
    endTrending()
    setTimingHeader()
    return c.json({
      source: 'trending',
      items: tagIptvAvailability(trending.slice(0, TARGET_COUNT)),
      _diag: diag(),
    })
  }

  // Everything the path runners need, captured once. Sets and filter
  // closures are shared by reference; the runners never mutate them.
  const ctx: SuggestionRequestContext = {
    kind: type,
    session,
    library,
    kindRejections,
    userFeedbackPromise,
    rejectedIds: rejected,
    libraryTmdbIds,
    rejectedTitles,
    libraryTitles,
    filterHouseholdSafe,
    filterRecommenderSafe,
    diag,
    libraryGenres,
    timing,
    setTimingHeader,
  }

  // Local-recommender fast path (USE_LOCAL_RECOMMENDER=1): the Python
  // sidecar does retrieval + ranking for free — no Claude tokens. The
  // legacy BYO-key Claude pipeline (with its own cold-start/key gates)
  // only fires when the sidecar is off; precedence rationale lives in
  // services/suggestionsRecommenderPath.ts.
  if (env.useLocalRecommender) {
    return runRecommenderSuggestionPath(c, ctx)
  }
  return runClaudeSuggestionPath(c, ctx)
})
