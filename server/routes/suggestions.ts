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

import { Hono } from 'hono'
import Anthropic from '@anthropic-ai/sdk'
import { requireAuth, type Env } from '../middleware/auth.js'
import { requireTrustedOrigin } from '../middleware/csrf.js'
import { getRejections } from '../services/rejections.js'
import { getUserFeedback } from '../services/userFeedback.js'
import { appendUsageEvent, computeCostCents } from '../services/usageLog.js'
import { scoreOnce, postShown, postImpressions, type RecommenderScoredItem } from '../services/recommender.js'
import { recommenderCallerFromSession } from '../services/recommenderCaller.js'
import { env } from '../env.js'
import { reportServerEvent } from '../services/serverTelemetry.js'
import {
  TARGET_COUNT,
  mapLimit,
  normalizeTitle,
  normalizeTitleBase,
  titleSetFrom,
  titleMatches,
  shuffleInPlace,
  type ClaudePick,
  type SuggestionItem,
} from '../services/suggestionsShared.js'
import {
  TMDB_LOOKUP_CONCURRENCY,
  backfillLikedTitles,
  backfillRejectionTitles,
  fetchCandidatePool,
  genreNamesToTmdbIds,
  tmdbDiscoverByGenres,
  tmdbKeyConfigured,
  tmdbLookup,
  tmdbTrending,
  topGenreNames,
} from '../services/suggestionsTmdb.js'
import {
  LibraryUnavailableError,
  fetchLibraryCached,
  librarySnapshotAgeMs,
  type LibraryItem,
} from '../services/suggestionsLibrary.js'
import {
  CLAUDE_OVERFETCH,
  MODEL,
  buildCandidatePoolBlock,
  buildLibraryBlock,
  buildPriorityTasteBlock,
  buildUserLikesBlock,
  callClaudeInitial,
  callClaudeRetry,
  computeGenreDistribution,
  mergeUsage,
  refreshSalt,
  type ClaudeResponse,
  type UsageBlock,
} from '../services/suggestionsPrompt.js'
import {
  RECENTLY_SHOWN_CAP,
  buildRecentlyShownBlock,
  getRecentlyShown,
  recordShown,
} from '../services/suggestionsRecentlyShown.js'
import { tagIptvAvailability } from '../services/iptvAvailability.js'
import { tagLocalAvailability } from '../services/localAvailability.js'

// Test escape hatches + helpers re-exported from their new service
// homes so existing imports keep working unchanged.
export { mapLimit }
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

// Minimum library size for a meaningful taste signal. Below this, the
// genre distribution is statistically noise (3 shows can be all Drama
// for genre-unrelated reasons). At 10, the household has at least a
// 2-3 genre cluster + enough titles to fill the PRIORITY TASTE block
// partially. Below 10 → trending fill (correct UX: new server, cold
// library). Raised from 3 (Agent C #5) — the prior threshold allowed
// near-empty libraries to burn API budget on low-quality suggestions.
const COLD_START_THRESHOLD = 10

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
  if (env.useLocalRecommender) {
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

  // BYO key model — caller must supply their Anthropic key in the
  // request header. 402 is the semantically correct response: "you
  // need to provide credentials/funds yourself before this resource
  // is available." Distinguishes from auth failure (401) and upstream
  // breakage (5xx).
  const userKey = (c.req.header('x-anthropic-api-key') ?? '').trim()
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

  const validate = async (
    picks: ClaudePick[],
  ): Promise<{
    accepted: SuggestionItem[]
    rejectedForRetry: Array<{ title: string; reason: string }>
    counters: { lookupNulls: number; droppedAsDedupe: number; droppedAsRejected: number; droppedAsLibrary: number; droppedAsYearMismatch: number; poolHits: number }
  }> => {
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
        tmdbLookup(type, pick.title, pick.year).catch(() => null),
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
        if (type === 'movie' && pick.year && r.year && Math.abs(r.year - pick.year) > 5) {
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
        if (rejected.has(r.id) || titleMatches(r.title, rejectedTitles)) {
          counters.droppedAsRejected++
          rejectedForRetry.push({ title: original, reason: 'on the household NEVER SUGGEST list' })
          continue
        }
        if (libraryTmdbIds.has(r.id) || titleMatches(r.title, libraryTitles)) {
          counters.droppedAsLibrary++
          rejectedForRetry.push({ title: original, reason: 'already in the household library' })
          console.warn('[suggestions] library duplicate dropped:', {
            kind: type,
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
  const v1 = await validate(r1.picks)
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
      const v2 = await validate(r2.picks)
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
})
