// server/services/suggestionsRecommenderPath.ts
//
// USE_LOCAL_RECOMMENDER=1 pipeline for the suggestions route. The
// route dispatches here after the household snapshot + filters are
// built; every branch returns a complete response.

import type { Context } from 'hono'
import type { Env } from '../middleware/auth.js'
import { scoreOnce, postShown, postImpressions, type RecommenderScoredItem } from './recommender.js'
import { recommenderCallerFromSession } from './recommenderCaller.js'
import { reportServerEvent } from './serverTelemetry.js'
import { TARGET_COUNT, type SuggestionItem } from './suggestionsShared.js'
import { tmdbKeyConfigured, tmdbTrending } from './suggestionsTmdb.js'
import { tagIptvAvailability } from './iptvAvailability.js'
import { tagLocalAvailability } from './localAvailability.js'
import type { SuggestionRequestContext } from './suggestionsContext.js'

// Local-recommender fast path. When USE_LOCAL_RECOMMENDER=1, the
// Python sidecar in the same compose stack does retrieval + ranking
// for FREE — no Claude tokens, no BYO key, no household-cost concern.
// It takes precedence over the server-side cold-start short-circuit
// (explicit force=trending is already handled above):
//
//   - An explicit Trending request is served above; absent that, the
//     free local model is the right default — pure trending would be
//     the WRONG default when personalized output is available at zero
//     cost.
//
//   - Cold-start: the sidecar's own cold_start_trending recipe
//     handles small libraries internally (see recommender/app/main.py)
//     and produces a comparable shape. Running BOTH cold-start checks
//     would either short-circuit before the recommender could try,
//     or leak the inconsistency between the two libraries (server
//     reads Sonarr/Radarr live; sidecar reads its own DB).
//
// BYO-key Claude branch below still fires when USE_LOCAL_RECOMMENDER
// is OFF — legacy path for deployments without the sidecar.

export async function runRecommenderSuggestionPath(
  c: Context<Env>,
  ctx: SuggestionRequestContext,
): Promise<Response> {
  const {
    kind: type,
    session,
    library,
    kindRejections,
    userFeedbackPromise,
    filterHouseholdSafe,
    filterRecommenderSafe,
    diag,
    timing,
    setTimingHeader,
  } = ctx
  const caller = recommenderCallerFromSession(session)
  const userFeedback = await userFeedbackPromise
  const likedRaw = type === 'movie' ? userFeedback.movie.liked : userFeedback.tv.liked
  const dislikedRaw =
    type === 'movie' ? userFeedback.movie.disliked : userFeedback.tv.disliked

  const recItems: RecommenderScoredItem[] = []
  const endRec = timing.mark('recommender')
  let modelVersion = 'unknown'
  let recipe = 'unknown'
  let recDiag: Record<string, unknown> = {}
  // Distinguish "sidecar healthy but returned nothing usable" from
  // "sidecar threw". Both collapse to safe.length === 0 below, but
  // only the former should mirror the trending fallback back to the
  // sidecar via postShown — posting /events/shown to a sidecar that
  // just failed /score is doomed to fail too, and the bounded timeout
  // produces a second log line per refresh during an outage.
  let recSucceeded = false
  try {
    const resp = await scoreOnce({
      sub: session.sub,
      kind: type,
      n: TARGET_COUNT,
      exclude_recently_shown: true,
      library: library
        .map((it) => ({
          // Only send tmdb_id when it's a REAL positive id. Sonarr series
          // routinely carry tmdbId:0 (they key on tvdbId), and the
          // recommender schema is tmdb_id>0-or-omitted — sending 0 returns a
          // 422 that fails the WHOLE batch, silently degrading every TV
          // refresh to plain trending. A title-only LibraryItem is valid, so
          // omit the id instead of sending a 0.
          ...(typeof it.tmdbId === 'number' && it.tmdbId > 0 ? { tmdb_id: it.tmdbId } : {}),
          title: it.title,
          source: type === 'movie' ? ('radarr' as const) : ('sonarr' as const),
        }))
        .filter((it) => it.tmdb_id !== undefined || it.title),
      // feedback + rejections are tmdb_id>0 in the recommender schema too, so
      // one stray non-positive id would 422 the request — drop them.
      feedback: [
        ...likedRaw.map((e) => ({ tmdb_id: e.id, signal: 'like' as const })),
        ...dislikedRaw.map((e) => ({ tmdb_id: e.id, signal: 'dislike' as const })),
      ].filter((f) => f.tmdb_id > 0),
      household_rejections: kindRejections.map((r) => r.id).filter((id) => id > 0),
    }, caller)
    recItems.push(...resp.items)
    modelVersion = resp.model_version
    recipe = resp.recipe
    recDiag = resp.diag
    recSucceeded = true
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    console.warn('[suggestions] recommender call failed, falling back to trending:', detail)
    // The fallback keeps the request working, but a recommender that is down
    // silently degrades EVERY user to trending — surface it (warning level so
    // Glitchtip groups occurrences) instead of hiding it in stdout.
    void reportServerEvent({
      level: 'warning',
      message: 'recommender scoreOnce failed; served trending fallback',
      context: { error: detail },
    })
  }
  endRec()

  const mapped: SuggestionItem[] = recItems.map((it) => ({
    id: it.tmdb_id,
    title: it.title ?? '?',
    posterPath: it.poster_path,
    overview: it.overview ?? undefined,
    year: it.year ?? undefined,
    provenance: it.provenance,
    reason: it.reason,
  }))
  const safe = filterRecommenderSafe(mapped)

  if (safe.length === 0) {
    // Recommender returned nothing usable (down, empty catalog, or all
    // filtered). Degrade to TMDB trending so the strip is never empty.
    if (!tmdbKeyConfigured()) {
      setTimingHeader()
      return c.json({
        source: 'recommender',
        items: [],
        _diag: diag({
          path: 'recommender_empty_no_tmdb_fallback',
          modelVersion,
          recipe,
          rec: recDiag,
        }),
      })
    }
    const trending = filterHouseholdSafe(await tmdbTrending(type)).map((it) => ({
      ...it,
      provenance: 'trending' as const,
      reason: null,
    }))
    const shown = trending.slice(0, TARGET_COUNT)
    // Tell the sidecar these fallback items were shown so the next
    // refresh's exclude_recently_shown filter sees them. Without
    // this, a sidecar that's healthy but returns empty/all-filtered
    // for this household replays the same trending cards every poll.
    // Mirrors the partial-fill postShown below; fire-and-forget,
    // bounded by services/recommender.ts timeout. Skip on
    // recSucceeded=false — posting to /events/shown when /score just
    // failed costs a second 3s timeout + log line per refresh
    // during an outage, with zero benefit (the sidecar isn't
    // going to record anything either way).
    if (shown.length > 0 && recSucceeded) {
      void postShown(session.sub, type, shown.map((it) => it.id), caller)
    }
    setTimingHeader()
    return c.json({
      source: 'trending',
      items: tagIptvAvailability(shown),
      _diag: diag({
        path: 'recommender_fallback_trending',
        modelVersion,
        recipe,
        rec: recDiag,
      }),
    })
  }

  // Real picks only — NO trending tail-padding. When the recommender
  // returns fewer than TARGET_COUNT, show the short strip of genuine
  // personalized picks as-is rather than padding the tail with TMDB
  // trending. The old padding re-fetched the same top-N weekly trending
  // every refresh (deduped only against the current picks, never against
  // what was already shown), so the far-right fill cards looked frozen —
  // identical on every poll for any household whose taste cluster doesn't
  // yield N viable neighbours. A genuinely empty result is still handled
  // above (safe.length === 0 → trending fallback), so the strip is never
  // blank; only the padding of a NON-empty personalized list is dropped.
  // `fillCount` stays in the diag (always 0 now) for back-compat.
  const items = safe.slice(0, TARGET_COUNT)
  const fillCount = 0
  const recById = new Map(recItems.map((it) => [it.tmdb_id, it]))
  const renderedRecImpressions = items
    .map((it, rank) => ({ item: recById.get(it.id), rank }))
    .filter((entry): entry is { item: RecommenderScoredItem; rank: number } => entry.item !== undefined)
    .map(({ item, rank }) => ({
      tmdb_id: item.tmdb_id,
      rank,
      score: item.score,
      provenance: item.provenance,
      model_version: modelVersion,
    }))
  if (renderedRecImpressions.length > 0) {
    void postImpressions(session.sub, type, renderedRecImpressions, caller)
  }

  setTimingHeader()
  return c.json({
    source: 'recommender',
    items: tagLocalAvailability(tagIptvAvailability(items), type),
    _diag: diag({
      modelVersion,
      recipe,
      rec: recDiag,
      costCents: 0,
      // Visible in diag so a household seeing a lot of trending fill
      // can tell us "recommender returned N, trending filled M" —
      // helps diagnose taste-cluster saturation vs catalog gaps.
      recommenderReturned: safe.length,
      fillCount,
    }),
  })
}
