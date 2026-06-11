// server/services/suggestionsClaudePath.ts
//
// Legacy BYO-key Claude pipeline for the suggestions route — only
// reachable when USE_LOCAL_RECOMMENDER is OFF. Owns the cold-start /
// missing-key short-circuits, the candidate-pool prep, the initial +
// retry Claude calls with pick validation between them, and the
// discover/trending fill that keeps the strip full. Every branch
// returns a complete response.

import Anthropic from '@anthropic-ai/sdk'
import type { Context } from 'hono'
import type { Env } from '../middleware/auth.js'
import { appendUsageEvent, computeCostCents } from './usageLog.js'
import {
  TARGET_COUNT,
  normalizeTitle,
  shuffleInPlace,
  type SuggestionItem,
} from './suggestionsShared.js'
import {
  backfillLikedTitles,
  backfillRejectionTitles,
  fetchCandidatePool,
  genreNamesToTmdbIds,
  tmdbDiscoverByGenres,
  tmdbKeyConfigured,
  tmdbTrending,
  topGenreNames,
} from './suggestionsTmdb.js'
import {
  CLAUDE_OVERFETCH,
  MODEL,
  buildCandidatePoolBlock,
  buildLibraryBlock,
  buildPriorityTasteBlock,
  buildUserLikesBlock,
  callClaudeInitial,
  callClaudeRetry,
  mergeUsage,
  refreshSalt,
  type ClaudeResponse,
  type UsageBlock,
} from './suggestionsPrompt.js'
import {
  RECENTLY_SHOWN_CAP,
  buildRecentlyShownBlock,
  getRecentlyShown,
  recordShown,
} from './suggestionsRecentlyShown.js'
import { validatePicks, type PickValidationContext } from './suggestionsValidation.js'
import { tagIptvAvailability } from './iptvAvailability.js'
import { getUserApiKey } from './userApiKeys.js'
import type { SuggestionRequestContext } from './suggestionsContext.js'

// Minimum library size for a meaningful taste signal. Below this, the
// genre distribution is statistically noise (3 shows can be all Drama
// for genre-unrelated reasons). At 10, the household has at least a
// 2-3 genre cluster + enough titles to fill the PRIORITY TASTE block
// partially. Below 10 → trending fill (correct UX: new server, cold
// library). Raised from 3 (Agent C #5) — the prior threshold allowed
// near-empty libraries to burn API budget on low-quality suggestions.
const COLD_START_THRESHOLD = 10

export async function runClaudeSuggestionPath(
  c: Context<Env>,
  ctx: SuggestionRequestContext,
): Promise<Response> {
  const {
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
    diag,
    libraryGenres,
    timing,
    setTimingHeader,
  } = ctx
  // Legacy (non-recommender) short-circuits. Only reachable when
  // USE_LOCAL_RECOMMENDER is OFF — when it's on, the block above returns
  // first and these never fire (intentional: a free local model beats
  // hard-coded trending fallback in every case). Explicit force=trending
  // is already handled near the top of the handler for every mode.
  if (!tmdbKeyConfigured()) {
    setTimingHeader()
    return c.json({ error: 'tmdb_not_configured' }, 503)
  }

  // Cold start: library too small for meaningful taste signal.
  if (library.length < COLD_START_THRESHOLD) {
    console.warn('[suggestions] Cold-start path: library too small to filter', diag())
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
      _diag: diag({
        reason: 'library_below_threshold',
        libraryCount: library.length,
        threshold: COLD_START_THRESHOLD,
        hint: `Add at least ${COLD_START_THRESHOLD - library.length} more title(s) to get personalized recommendations`,
      }),
    })
  }

  // BYO key model — the caller's Anthropic key. Resolution order:
  //   1. X-Anthropic-Api-Key request header (back-compat: pre-migration
  //      SPAs and any scripted callers still send it) — header wins.
  //   2. The user's server-stored key (PUT /api/settings/anthropic-key,
  //      encrypted at rest per sub in services/userApiKeys.ts) — the
  //      current SPA never holds the key client-side.
  // 402 is the semantically correct response when neither is present:
  // "you need to provide credentials/funds yourself before this
  // resource is available." Distinguishes from auth failure (401) and
  // upstream breakage (5xx). The key itself must never be logged.
  const headerKey = (c.req.header('x-anthropic-api-key') ?? '').trim()
  const userKey = headerKey || (getUserApiKey(session.sub) ?? '')
  if (!userKey || !userKey.startsWith('sk-ant-')) {
    return c.json({ error: 'api_key_required', hint: 'set your key in the user menu' }, 402)
  }

  // Already in flight from the prologue — just await the resolution.
  const userFeedback = await userFeedbackPromise
  const likedRaw = type === 'movie' ? userFeedback.movie.liked : userFeedback.tv.liked

  // Start the candidate pool fetch in parallel with the backfill.
  // topGenreIds only needs `library`, which is already resolved.
  // Parallelizing the pool fetch with backfill saves the cold-cache
  // pool latency (1–2 s) when backfill is also doing TMDB calls;
  // on cache-hit the pool resolves in <1ms regardless.
  // Use top-5 genres instead of top-3 (iter 16). More genre coverage
  // gives Claude a richer pool, especially for households with 4-5
  // distinct clusters (e.g. Crime + Drama + Sci-Fi + Thriller + History).
  // Top-3 was fine for a 20-item "Fill" but for the pool we want
  // broader coverage to avoid the pool being dominated by a single genre.
  const topGenreIds = genreNamesToTmdbIds(type, topGenreNames(library, 5))
  const endPool = timing.mark('candidatePool')
  const rawPoolPromise = topGenreIds.length > 0 ? fetchCandidatePool(type, topGenreIds) : Promise.resolve([] as SuggestionItem[])

  // Backfill missing titles on legacy entries so the Claude prompt
  // carries the *entire* rejection + likes context, not a silently
  // trimmed subset. Resolved titles are persisted so this cost is
  // one-time per entry. Backfill failures fall through to
  // `[TMDB id N]` bullets — Claude still sees the id is gated.
  const [kindRejectionsTitled, liked, rawPool] = await Promise.all([
    backfillRejectionTitles(type, kindRejections),
    backfillLikedTitles(session.sub, type, likedRaw),
    rawPoolPromise,
  ])
  endPool()

  const client = new Anthropic({ apiKey: userKey })
  const libraryBlock = buildLibraryBlock(type, library, kindRejectionsTitled)
  const priorityTasteBlock = buildPriorityTasteBlock(library)
  const userLikesBlock = buildUserLikesBlock(liked)

  // Filter pool BEFORE building the recently-shown block so we know
  // the pool size to cap the recently-shown list proportionally.
  // Pool items pass through filterHouseholdSafe to drop library entries
  // and rejects. Shuffle the pool before presenting it to Claude so
  // each refresh sees a different ordering of the numbered list — this
  // is the per-refresh pool variety knob. The TMDB /discover cache still
  // serves the same 60 items per TTL window, but Claude's pick
  // distribution changes across refreshes because it sees a freshly
  // shuffled numbered list. The poolByTitle map is order-independent so
  // the fast-path lookup works regardless of shuffle order.
  const safePool = shuffleInPlace(filterHouseholdSafe(rawPool))

  // Cap recently-shown proportionally to pool size. With a 60-item pool
  // and a 150-item recently-shown list, Claude would have almost no fresh
  // candidates. Cap at 80% of pool size (min 30) so at least 20% of the
  // pool is "uncontested" fresh territory every refresh. When the pool
  // is empty, fall back to the full recently-shown buffer.
  const recentlyShownCap = safePool.length > 0
    ? Math.max(Math.floor(safePool.length * 0.8), 30)
    : RECENTLY_SHOWN_CAP
  const recentlyShownAll = getRecentlyShown(session.sub, type)
  const recentlyShownTrimmed = recentlyShownAll.slice(0, recentlyShownCap)
  const recentlyShownBlock = buildRecentlyShownBlock(recentlyShownTrimmed)
  const poolByTitle = new Map<string, SuggestionItem[]>()
  for (const it of safePool) {
    const key = normalizeTitle(it.title)
    const existing = poolByTitle.get(key)
    if (existing) existing.push(it)
    else poolByTitle.set(key, [it])
  }
  const candidatePoolBlock = buildCandidatePoolBlock(safePool)
  const isAcceptedPoolHit = (item: SuggestionItem): boolean =>
    (poolByTitle.get(normalizeTitle(item.title)) ?? []).some((poolItem) => poolItem.id === item.id)
  const countAcceptedPoolHits = (items: SuggestionItem[]): number =>
    items.reduce((count, item) => count + (isAcceptedPoolHit(item) ? 1 : 0), 0)

  // Tool-use enforced pipeline:
  //   1. Pre-fetch a candidate pool from TMDB /discover (genre-seeded,
  //      quality-sorted). Claude ranks from this pool instead of
  //      generating from its popularity prior.
  //   2. Claude is forced to call submit_recommendations with N picks
  //   3. We validate each pick — pool hits skip the TMDB lookup (id
  //      already known), non-pool picks fall back to /search lookup
  //   4. If we don't have TARGET_COUNT survivors, re-prompt Claude
  //      with a tool_result describing exactly which picks were
  //      rejected and why — single retry, bounded cost
  //   5. If still short, fill from pool remainder → trending
  //
  // The id-set post-filter remains as defense-in-depth but is no
  // longer load-bearing; Claude is told exactly what failed and
  // self-corrects on the retry pass. Pool picks skip /search lookup
  // entirely — the TMDB id is already resolved, so the validation
  // path is a cheap in-memory check instead of a network round-trip.

  // Household context captured once; both validation passes (initial +
  // retry) share it.
  const validationCtx: PickValidationContext = {
    kind: type,
    rejectedIds: rejected,
    libraryTmdbIds,
    rejectedTitles,
    libraryTitles,
    poolByTitle,
  }

  let totalUsage: UsageBlock = {}
  let r1: ClaudeResponse
  let claudeTruncated: boolean
  let claudeCallCount = 0
  let usageLogFailed = false
  const recordUsageEvent = async (event: Parameters<typeof appendUsageEvent>[0]): Promise<void> => {
    try {
      await appendUsageEvent(event)
    } catch (err) {
      usageLogFailed = true
      console.error('[suggestions] usage log append failed:', err)
    }
  }
  // One salt per request — shared by initial + retry. Refresh variety
  // hangs on this: the cached library prefix makes deterministic Claude
  // calls otherwise. Salt rides outside the cache (in the user msg).
  const salt = refreshSalt()
  // Genre hint: top-2 genres from the library with percentages, repeated
  // in the volatile user message for high-attention positioning (iter 55).
  // Complements the TARGET GENRE MIX line in the cached library block.
  // Empty when the library has no genre data (uncommon; Sonarr/Radarr always
  // populate genres for well-catalogued libraries).
  const genreHint = libraryGenres.length > 0
    ? libraryGenres.slice(0, 2).join(' and ')
    : undefined
  const endClaudeInitial = timing.mark('claudeInitial')
  try {
    r1 = await callClaudeInitial(client, type, libraryBlock, priorityTasteBlock, userLikesBlock, recentlyShownBlock, candidatePoolBlock, salt, genreHint)
    claudeCallCount++
    totalUsage = mergeUsage(totalUsage, r1.usage)
    claudeTruncated = r1.truncated ?? false
  } catch (e) {
    endClaudeInitial()
    const errorMsg = e instanceof Error ? e.message : String(e)
    // Pull the API status off Anthropic SDK errors so the SPA can
    // distinguish 401 (bad key) from 429 (rate limit) from 5xx (their
    // outage) from 4xx (our prompt). The SDK exposes .status on
    // APIError subclasses.
    const errorStatus =
      typeof (e as { status?: unknown }).status === 'number'
        ? ((e as { status: number }).status)
        : undefined
    console.error('[suggestions] Claude call failed:', errorMsg, errorStatus ?? '')
    await recordUsageEvent({
      sub: session.sub,
      username: session.username,
      type: 'claude_error',
      model: MODEL,
      kind: type,
      error: errorMsg,
    })
    const trending = filterHouseholdSafe(await tmdbTrending(type)).map((it) => ({
      ...it,
      provenance: 'trending' as const,
      reason: null,
    }))
    setTimingHeader()
    return c.json({
      source: 'trending_fallback',
      items: tagIptvAvailability(trending.slice(0, TARGET_COUNT)),
      _diag: diag({ reason: 'claude_threw', claudeError: errorMsg, claudeStatus: errorStatus, ...(usageLogFailed ? { usageLogFailed: true } : {}) }),
    })
  }
  endClaudeInitial()

  const endValidate1 = timing.mark('validate1')
  const v1 = await validatePicks(r1.picks, validationCtx)
  endValidate1()
  const accepted = v1.accepted
  let lastCounters = v1.counters
  let triedRetry = false

  // Retry once when there's actionable feedback for Claude:
  //   - rejectedForRetry > 0 → tell Claude which picks were dropped
  //     and why, so it can produce different picks
  //   - picks.length === 0 → Claude returned an empty array (likely
  //     hit max_tokens truncation or saw the constraints as
  //     unsatisfiable). Re-prompt; the explicit count contract in the
  //     user message should land harder on the second pass.
  // Skip retry when picks resolved cleanly but happened to fall short
  // — re-asking the same prompt without rejection feedback would just
  // produce the same list.
  if (
    r1.toolUse &&
    accepted.length < TARGET_COUNT &&
    (v1.rejectedForRetry.length > 0 || r1.picks.length === 0)
  ) {
    triedRetry = true
    const nNeeded = Math.min(CLAUDE_OVERFETCH, TARGET_COUNT - accepted.length + 4)
    const endClaudeRetry = timing.mark('claudeRetry')
    try {
      const r2 = await callClaudeRetry(
        client,
        type,
        libraryBlock,
        priorityTasteBlock,
        userLikesBlock,
        candidatePoolBlock,
        r1.toolUse,
        v1.rejectedForRetry,
        nNeeded,
        salt,
        genreHint,
      )
      claudeCallCount++
      totalUsage = mergeUsage(totalUsage, r2.usage)
      endClaudeRetry()
      const endValidate2 = timing.mark('validate2')
      const v2 = await validatePicks(r2.picks, validationCtx)
      endValidate2()
      // Accumulate drop counts across both validation passes so the
      // reported droppedPicks reflects the TOTAL cost of dropped picks
      // (both initial and retry), not just the retry pass's drops.
      // Before iter 59, lastCounters was replaced (not merged), meaning
      // a request that dropped 10 picks in call 1 + 8 in call 2 showed
      // only 8 in _diag — understating the waste. Merged now so the
      // >10 droppedPicks UI warning fires correctly for multi-pass waste.
      const c1 = lastCounters
      const c2 = v2.counters
      lastCounters = {
        lookupNulls: (c1.lookupNulls ?? 0) + (c2.lookupNulls ?? 0),
        droppedAsDedupe: (c1.droppedAsDedupe ?? 0) + (c2.droppedAsDedupe ?? 0),
        droppedAsRejected: (c1.droppedAsRejected ?? 0) + (c2.droppedAsRejected ?? 0),
        droppedAsLibrary: (c1.droppedAsLibrary ?? 0) + (c2.droppedAsLibrary ?? 0),
        droppedAsYearMismatch: (c1.droppedAsYearMismatch ?? 0) + (c2.droppedAsYearMismatch ?? 0),
        // Sum pool hits across both passes — pool hits in the initial
        // pass still count toward "this refresh used the pre-vetted
        // pool." Previously we replaced with retry-only, which under-
        // reported poolHits/poolHitRate in _diag whenever the retry
        // contributed fewer pool-matched picks than the initial pass.
        poolHits: (c1.poolHits ?? 0) + (c2.poolHits ?? 0),
      }
      const acceptedIds = new Set(accepted.map((a) => a.id))
      for (const item of v2.accepted) {
        if (!acceptedIds.has(item.id)) {
          accepted.push(item)
          acceptedIds.add(item.id)
          if (accepted.length >= TARGET_COUNT) break
        }
      }
    } catch (e) {
      console.error('[suggestions] Claude retry failed:', e)
      // Fall through with whatever we accepted from r1.
    }
  }

  const refreshCostCents = computeCostCents(totalUsage)
  // Prompt cache hit rate: cacheRead / (input + cacheRead + cacheCreation).
  // 1.0 = library block always came from cache (best case — 10x cheaper);
  // 0.0 = no cache hits (first call of the day or library changed).
  // Surfaced in _diag so the household can see whether prompt caching is
  // working. A persistently 0.0 rate suggests the library fingerprint is
  // thrashing (library changing too frequently or TTL too short).
  const totalInputTokens =
    (totalUsage.inputTokens ?? 0) +
    (totalUsage.cacheReadInputTokens ?? 0) +
    (totalUsage.cacheCreationInputTokens ?? 0)
  const cacheHitRate = totalInputTokens > 0
    ? Math.round(((totalUsage.cacheReadInputTokens ?? 0) / totalInputTokens) * 100) / 100
    : 0
  await recordUsageEvent({
    sub: session.sub,
    username: session.username,
    type: 'claude_call',
    model: MODEL,
    kind: type,
    callCount: claudeCallCount,
    ...totalUsage,
    costCents: refreshCostCents,
  })

  // Still short of target after the retry — fill so the user always
  // sees a full strip. Prefer library-aware discover (TMDB popularity
  // sorted by the household's top genres) over generic trending; fall
  // back to trending when no genres map. Source labels stay stable so
  // the SPA's typed switch keeps working — fillSource diagnostic
  // surfaces which path actually fired.
  if (accepted.length < TARGET_COUNT) {
    const endFill = timing.mark('fill')
    const fillIds = new Set(accepted.map((a) => a.id))
    // topGenreIds already computed above for the candidate pool —
    // reuse it so the fill path shares the same cached discover call.
    let fillSource: 'discover' | 'trending' | 'discover+trending' = 'trending'
    let fill: SuggestionItem[] = []
    if (topGenreIds.length > 0) {
      const discover = filterHouseholdSafe(await tmdbDiscoverByGenres(type, topGenreIds))
        .filter((t) => !fillIds.has(t.id))
        .map((it) => ({ ...it, provenance: 'discover' as const, reason: null }))
      if (discover.length > 0) {
        fill = discover
        fillSource = 'discover'
      }
    }
    // If discover didn't return enough, top up with trending so the
    // strip still fills.
    if (accepted.length + fill.length < TARGET_COUNT) {
      const fillIdsAfter = new Set([...fillIds, ...fill.map((f) => f.id)])
      const trending = filterHouseholdSafe(await tmdbTrending(type)).map((it) => ({
      ...it,
      provenance: 'trending' as const,
      reason: null,
    })).filter(
        (t) => !fillIdsAfter.has(t.id),
      )
      fill = [...fill, ...trending]
      fillSource = fillSource === 'discover' ? 'discover+trending' : 'trending'
    }
    const filled = [...accepted, ...fill].slice(0, TARGET_COUNT)
    endFill()
    console.warn('[suggestions] Personalized picks short of target — filling', {
      kind: type,
      sub: session.sub,
      libraryCount: library.length,
      rejectionCount: kindRejectionsTitled.length,
      titledRejections: kindRejectionsTitled.filter((r) => r.title).length,
      accepted: accepted.length,
      retryAttempted: triedRetry,
      fillSource,
      lastCounters,
    })
    recordShown(session.sub, type, filled)
    setTimingHeader()
    // Compute total dropped picks across all validation passes for cost transparency.
    const droppedTotal =
      (lastCounters.droppedAsLibrary ?? 0) +
      (lastCounters.droppedAsRejected ?? 0) +
      (lastCounters.lookupNulls ?? 0) +
      (lastCounters.droppedAsYearMismatch ?? 0) +
      (lastCounters.droppedAsDedupe ?? 0)
    const filledPoolHits = countAcceptedPoolHits(accepted)
    const filledCounters = { ...lastCounters, poolHits: filledPoolHits }
    const filledPoolHitRate = accepted.length > 0
      ? Math.round((filledPoolHits / accepted.length) * 100) / 100
      : 0
    // recentlyShownCount: how many titles are in the active recently-shown
    // buffer for this request (after cap). Helps the household observe
    // whether the pool-cap is firing (recentlyShownCount < recentlyShownAll
    // means the cap kicked in). Surfaced in _diag for observability.
    const recentlyShownCount = recentlyShownTrimmed.length
    if (accepted.length === 0) {
      return c.json({
        source: 'personalized_empty_trending_fallback',
        items: tagIptvAvailability(filled),
        _diag: diag({ accepted: 0, retryAttempted: triedRetry, fillSource, lastCounters: filledCounters, poolSize: safePool.length, poolHitRate: 0, droppedPicks: droppedTotal, costCents: refreshCostCents, cacheHitRate, callCount: claudeCallCount, recentlyShownCount, ...(claudeTruncated ? { claudeTruncated: true } : {}), ...(usageLogFailed ? { usageLogFailed: true } : {}) }),
      })
    }
    return c.json({
      source: 'personalized_filled',
      items: tagIptvAvailability(filled),
      _diag: diag({ accepted: accepted.length, retryAttempted: triedRetry, fillSource, lastCounters: filledCounters, poolSize: safePool.length, poolHits: filledPoolHits, poolHitRate: filledPoolHitRate, droppedPicks: droppedTotal, costCents: refreshCostCents, cacheHitRate, callCount: claudeCallCount, recentlyShownCount, ...(claudeTruncated ? { claudeTruncated: true } : {}), ...(usageLogFailed ? { usageLogFailed: true } : {}) }),
    })
  }

  const droppedTotal =
    (lastCounters.droppedAsLibrary ?? 0) +
    (lastCounters.droppedAsRejected ?? 0) +
    (lastCounters.lookupNulls ?? 0) +
    (lastCounters.droppedAsYearMismatch ?? 0) +
    (lastCounters.droppedAsDedupe ?? 0)
  const finalAccepted = accepted.slice(0, TARGET_COUNT)
  // Pool hit rate: fraction of accepted personalized picks that came from
  // the pool (vs needing a full TMDB /search round-trip). 1.0 = ideal
  // (every pick pre-vetted), 0.0 = pool didn't help. Observable in devtools.
  // Use lastCounters (accumulated across initial + retry, per iter 59)
  // not v1.counters — previously we under-reported on the retry path.
  const poolHitsTotal = countAcceptedPoolHits(finalAccepted)
  const finalCounters = { ...lastCounters, poolHits: poolHitsTotal }
  const poolHitRate = finalAccepted.length > 0
    ? Math.round((poolHitsTotal / finalAccepted.length) * 100) / 100
    : 0
  recordShown(session.sub, type, finalAccepted)
  setTimingHeader()
  return c.json({
    source: 'personalized',
    items: tagIptvAvailability(finalAccepted),
    _diag: diag({ accepted: accepted.length, retryAttempted: triedRetry, poolSize: safePool.length, poolHits: poolHitsTotal, poolHitRate, lastCounters: finalCounters, droppedPicks: droppedTotal, costCents: refreshCostCents, cacheHitRate, callCount: claudeCallCount, recentlyShownCount: recentlyShownTrimmed.length, ...(claudeTruncated ? { claudeTruncated: true } : {}), ...(usageLogFailed ? { usageLogFailed: true } : {}) }),
  })
}
