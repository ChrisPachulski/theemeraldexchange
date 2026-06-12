
# Teaching Dossier: Recommendation Strip UI

---

## 1. WHAT

The recommendation strip is the horizontal row of movie or TV posters you see at the top of the Movies and TV Discover tabs. When you first arrive, the app asks the server for a personalized lineup — titles picked for your household based on your library and taste history. Each card shows a poster, title, and year. Underneath every card sit two small dots: a red one on the left ("never suggest this again") and a green one on the right ("show me more like this"). At the bottom-right of the strip is a Recommended / Trending toggle that lets you switch between your personalized picks and the global TMDB trending chart. There is also a small refresh button in the header that forces a brand-new lineup from the recommender. The strip is designed to stay completely stable while you are browsing — you can click green or red dots on multiple cards in a row without the whole row reshuffling under you.

---

## 2. WHY

**Strip stability is a trust contract with the user.** When a lineup reshuffles mid-browse, the card you were about to click on moves or disappears. Early versions of this strip did reshuffle — on every like, on every mount, when you toggled Recommended vs. Trending and back, and when you added a title from the modal. Users reported the experience as "accept one and the entire line resets, can't grab the next." That erodes trust: the strip feels unreliable, so users stop using it.

**Stability requires enumerating every possible refetch path**, because React Query will silently re-request data whenever you tell it the cache is stale. There are exactly four ways the cache can be told to go stale or be invalidated:
1. `staleTime` expires — if `staleTime` is short (or 0), any component mount or window refocus triggers a background refetch.
2. `invalidateQueries(['suggestions', ...])` — an explicit cache bust that causes a re-request on next read.
3. `refetch()` — bypasses `staleTime` entirely and runs the query immediately.
4. The query key itself changing — if the key changes, TanStack Query treats it as a brand new query and fetches.

If you miss even one of these paths and leave it open, you get strip churn. This is why the comments in this code enumerate every path explicitly and explain why each one is either closed or intentionally left open.

---

## 3. MAP

**Key files:**

- `src/lib/hooks/useSuggested.ts` — fetches `/api/suggestions/{kind}`, sets `staleTime: Infinity`, defines the query key `['suggestions', kind, mode, keyFingerprint]`
- `src/lib/hooks/useUserFeedback.ts` — `useFeedback()` reads the dot state; `useSetFeedback(kind)` sends like/dislike, does optimistic updates, and contains the low-water refill logic (lines 156–168)
- `src/lib/hooks/useSuggestionStrip.ts` — orchestration hook that wires the above two together; exports `items`, `feedback`, `refresh`, `mode`, `label`
- `src/lib/hooks/useSuggestionMode.ts` — reads/writes `localStorage` key `eex.suggestionMode`; wired to the toggle
- `src/components/search/TrendingRow.tsx` — the visual strip; renders cards, `FeedbackDots`, `StripModeToggle`
- `src/components/search/FeedbackDots.tsx` — the two-dot component; stops click propagation so card `onPick` does not fire
- `src/components/search/StripModeToggle.tsx` — Recommended / Trending segmented control
- `src/components/add/AddMovieModal.tsx` — "Add to library" modal; `onSuccess` explicitly does NOT invalidate `['suggestions']` (line 66–76)
- `src/components/add/AddSeriesModal.tsx` — TV equivalent; same deliberate omission (lines 105–114)

**One like click — walkthrough:**

1. User clicks the green dot on card for TMDB id 550 ("Fight Club").
2. `FeedbackDots` (line 52 of FeedbackDots.tsx) calls `onLike()`, which stopped propagation so `onPick` does not fire.
3. In `useSuggestionStrip.ts` (line 128–130), `onLike` checks the current `stateFor(id)`. If it was already `'liked'`, it sends `signal: null` (toggle off). Otherwise sends `signal: 'like'`.
4. `useSetFeedback.mutate({ tmdbId: 550, title: 'Fight Club', signal: 'like' })` fires.
5. In `useUserFeedback.ts` `onMutate` (line 83): the `['feedback']` cache is updated optimistically — id 550 is added to `liked[]`, removed from `disliked[]`. No change to `['suggestions']` cache because `signal !== 'dislike'` (line 112 gates the suggestions block on `signal === 'dislike'`).
6. The dot for Fight Club immediately renders green. The rest of the strip is completely unchanged.
7. In `onSettled` (line 137), `['feedback']` is invalidated (re-fetched from server). The `signal !== 'dislike'` guard at line 156 exits immediately — the low-water check is skipped. Strip stays put.

**One dislike click — walkthrough:**

1. User clicks the red dot on card for TMDB id 550.
2. Same path through `FeedbackDots`, `onDislike`, `useSuggestionStrip.onDislike` → `useSetFeedback.mutate({ tmdbId: 550, title: 'Fight Club', signal: 'dislike' })`.
3. `onMutate`: `['feedback']` cache updated (550 moved to `disliked[]`). Then — because `signal === 'dislike'` — all cache entries matching `['suggestions', kind]` are found (line 114), and id 550 is filtered out of each one (lines 119–127). Card disappears immediately from the strip.
4. `onSettled`: `['feedback']` invalidated. Low-water check runs (lines 156–168): if the remaining `items.length` in any matching suggestions entry is 5 or fewer (`LOW_WATER_MARK = 5`), `invalidateQueries(['suggestions', kind])` fires — which causes a re-request and a new lineup. If the strip still has 6+ cards, nothing happens.

---

## 4. PREREQUISITES

**React state (eli5):** React components re-render when their data changes. The way to store data that can change is `useState` — a variable + a setter function. When you call the setter, React re-renders the component with the new value. Derived values (like a filtered list) should be computed with `useMemo` so React only recomputes them when their inputs actually change.

**React Query / TanStack Query cache (eli5):** React Query is a library that manages server-fetched data. You describe a query with a `queryKey` (an array that acts like a cache address) and a `queryFn` (an async function that fetches the data). React Query fetches once, stores the result, and re-uses it for every component that asks for the same key. `staleTime` controls how long the cached result is considered "fresh" — while fresh, no background refetch happens. `Infinity` means "never consider it stale on its own." `invalidateQueries` marks a cache entry stale immediately and re-fetches it. `useMutation` is for writes (POST/PUT/DELETE); it has `onMutate` (optimistic update), `onError` (rollback), and `onSettled` (cleanup, runs whether success or error).

---

## 5. GOTCHAS & WAR STORIES

The recommendation strip went through four separate regressions, each caused by one unguarded refetch path. Understanding all four is the best way to internalize why the current code is written the way it is.

**Path 1 — Auto-refresh on all-judged (PR #79, then fully removed in PR #109, commit `e620372`):**
The original strip had a `useStripAutoRefresh` hook that watched how many cards had been judged (liked or disliked). When every visible card had a dot, it automatically triggered a refresh to load new picks. The intent was helpful: you've triaged the whole strip, give them a new one. The problem: a like counts as "judged." On a short strip (8 cards), liking one card was enough to push the judged count to the threshold. The result: clicking the green dot on any card caused the entire strip to vanish and reload with a new lineup — exactly while the user was looking at the other seven cards they wanted to act on. PR #79 raised the minimum to 8 judged cards before auto-refreshing; that wasn't enough because a short strip made every like trigger it. PR #109 deleted `useStripAutoRefresh` entirely. The only correct answer was no auto-refresh on likes at all.

**Path 2 — `staleTime: 0` churn (commit `e620372`):**
After removing auto-refresh, the strip still reshuffled on every tab toggle (Movies → TV → Movies) and on any component remount. The root cause: `useSuggested` had `staleTime: 0` and `refetchOnMount: 'always'`. TanStack Query's default behavior when staleTime is 0 is to re-fetch in the background whenever any component subscribes to that query key — which happens on every mount. The fix: `staleTime: Infinity` and removing `refetchOnMount`. The comment in `useSuggested.ts` lines 12–21 explains this in detail.

**Path 3 — Modal `invalidate(['suggestions'])` (commit `2eb5e88`):**
Even after fixing staleTime, users reported that accepting a pick from the strip (clicking a card, picking a profile in the modal, clicking "Add to library") still reshuffled the lineup. The cause was in both `AddMovieModal.tsx` and `AddSeriesModal.tsx`: their `onSuccess` callbacks called `qc.invalidateQueries({ queryKey: ['suggestions'] })`. The rationale at the time was "the added movie should drop out of the strip." The problem: `invalidateQueries` triggers a full re-fetch, which gives you a brand new lineup, not just the one card removed. The fix: delete both `invalidateQueries(['suggestions'])` calls. The added title already drops out automatically because the strip's `useSuggestionStrip` filters items against `libraryTmdbIds` — and the radarr/sonarr invalidation (which is still in `onSuccess`) refreshes the library query, updating that set. New library state flows in on the next explicit refresh; Claude does not need to re-run immediately.

**Path 4 — Like triggering low-water refill (identified while auditing, fixed in the same pass):**
The low-water refill logic (when the dislike drains the strip to 5 or fewer cards, trigger a new lineup) was initially not gated on `signal === 'dislike'`. This meant a like on a short strip — say, a 5-card strip where all cards were already personalized — would hit the low-water check, see `items.length <= 5`, and fire `invalidateQueries(['suggestions'])`, reshuffling the strip. The fix is the guard at `useUserFeedback.ts` line 156: `if (variables.signal !== 'dislike') return` before the low-water check runs.

**Tail-padding removed, never re-add:** An earlier version padded a short strip with trending titles when personalized picks ran short. This was removed. A short strip is a signal to improve recall, not to hide the shortfall with generic trending content. Do not re-add tail-padding.

---

## 6. QUIZ BANK

**Q1.** A user complains that every time they click the green dot on a card, the whole strip reshuffles and they lose their place. You look at `useUserFeedback.ts` and see this in `onSettled`:
```ts
qc.invalidateQueries({ queryKey: ['suggestions', kind] })
```
The line has no guard. What is the bug and what is the one-line fix?

**A1.** The invalidation runs on every signal (like, dislike, clear), not just dislikes. A like should never trigger a refetch. Fix: wrap the invalidation block with `if (variables.signal !== 'dislike') return` before the `LOW_WATER_MARK` check, as in the current code at line 156.

---

**Q2.** You add a new `useEffect` inside `useSuggested` that calls `refetch()` whenever the component mounts:
```ts
useEffect(() => { void refetch() }, [refetch])
```
What exactly breaks, and why does `staleTime: Infinity` not save you?

**A2.** `staleTime` only suppresses background refetches that React Query initiates automatically. Calling `refetch()` explicitly bypasses `staleTime` entirely — it always re-runs the query regardless. The strip will now fire a new recommender request on every mount (tab switch, modal close, any parent re-render). The lineup will change every time, breaking the stability contract.

---

**Q3.** Walk through what happens in the cache when a user dislikes TMDB id 42 from a strip that currently shows 7 cards. Does the strip re-fetch a new lineup? Why or why not?

**A3.** `onMutate` fires: the `['feedback']` cache is updated optimistically (42 added to `disliked[]`). Then — because `signal === 'dislike'` — all `['suggestions', kind]` cache entries are found and id 42 is filtered out. The strip now renders 6 cards. In `onSettled`, `['feedback']` is invalidated. The low-water check runs: `lowest = 6 > LOW_WATER_MARK (5)`. No invalidation. Strip stays at 6 cards, no re-fetch.

---

**Q4.** The `AddMovieModal` `onSuccess` currently calls `qc.invalidateQueries({ queryKey: ['radarr', 'movie'] })` but deliberately does NOT call `qc.invalidateQueries({ queryKey: ['suggestions'] })`. Explain in your own words why the added movie still disappears from the strip without a suggestions re-fetch.

**A4.** The strip renders items from `useSuggestionStrip`, which filters the suggestions list against `libraryTmdbIds` (a `Set` built from the Radarr library query). Invalidating `['radarr', 'movie']` causes the library list to re-fetch, which adds the new movie's TMDB id to that set. On the next render, `useSuggestionStrip`'s `useMemo` sees the updated set and filters out the added card. The suggestions query itself — the recommender's scored lineup — does not need to change. The card disappears through the filter, not through a new recommender run.

---

**Q5.** A new developer proposes restoring `staleTime: 0` on `useSuggested` but adding `refetchOnWindowFocus: false` to "prevent the worst case." Is this safe? What scenario does it miss?

**A5.** Not safe. `staleTime: 0` means the query is immediately stale after it resolves. React Query will re-fetch in the background any time a component subscribes (mounts) to the query key — this is the default behavior for stale queries and is separate from `refetchOnWindowFocus`. Every tab switch that mounts the Movies or TV tab, every modal close that re-mounts the parent, would trigger a background re-fetch. The user would see a new lineup after every navigation, which is the exact regression that was fixed by setting `staleTime: Infinity`.

---

**Q6.** Explain the four-segment query key `['suggestions', kind, forceTrending ? 'trending' : 'recommended', keyFingerprint ?? 'none']`. What happens to the cached lineup when the user flips the StripModeToggle from Recommended to Trending?

**A6.** TanStack Query treats different query keys as completely independent caches. When the user flips to Trending, `forceTrending` becomes `true`, so the third segment changes from `'recommended'` to `'trending'`. This is a new key — React Query looks up a different cache slot. If that slot is empty (first time on Trending), it fetches. If it was already fetched in this session, it serves the cached Trending lineup instantly (because `staleTime: Infinity` applies here too). When the user flips back to Recommended, the old `'recommended'` entry is still in cache, so the original lineup returns immediately — no re-fetch, no reshuffle. Each mode has its own independent stable cache.

---

## 7. CODE-READING EXERCISE

**File: `src/lib/hooks/useUserFeedback.ts`**

Read the entire file (172 lines). Then answer these questions step by step as you go:

**Step 1 (lines 1–43):** `useFeedback` uses `staleTime: 60_000` (60 seconds), not `Infinity`. Why is a 60-second stale time reasonable here but `Infinity` would be wrong? (Hint: what changes the feedback state?)

**Step 2 (lines 83–129 — `onMutate`):** The optimistic update for dislikes iterates over all cache entries matching `['suggestions', kind]` using `qc.getQueryCache().findAll(...)` rather than calling `qc.getQueryData(['suggestions', kind])` directly. Why does the code use `findAll` instead of `getQueryData`? What would `getQueryData` with a two-segment key return?

**Step 3 (lines 130–134 — `onError`):** The rollback iterates `ctx.suggestionsSnapshot`. When would this rollback be needed, and what state is it restoring?

**Step 4 (lines 137–168 — `onSettled`):** Locate the comment that explains why `['suggestions']` is NOT invalidated unconditionally in `onSettled`. Restate the reasoning in one sentence in your own words.

**Step 5 (lines 156–168):** The constant `LOW_WATER_MARK = 5` is defined inline. If you wanted to raise this to 8 (refetch sooner), where exactly would you change it, and would you need to change anything else?

**Answers:**

1. Feedback state changes whenever any mutation (like/dislike/clear) settles — `onSettled` explicitly calls `invalidateQueries(['feedback'])`. A 60-second stale time means a background re-sync happens at most once a minute, keeping the dots consistent with the server even if two devices are active. `Infinity` would leave the dots stale until the next mutation, which is fine for the lineup (you want it stable) but wrong for dots (you want them to reflect server truth after a minute or two).

2. The full query key is four segments: `['suggestions', kind, mode, keyFingerprint]`. `getQueryData(['suggestions', kind])` with only two segments would return `undefined` — TanStack Query requires an exact key match. `findAll({ queryKey: ['suggestions', kind] })` uses a prefix match and returns all entries whose key starts with those two segments, regardless of the mode or fingerprint. This means the dislike card-removal applies to all variants of the suggestions cache (recommended and trending, any key), so flipping the toggle doesn't leave a ghost card in one mode.

3. The rollback restores the suggestions cache entries to their pre-mutation state. This would be needed if the POST to `/api/feedback` fails — in that case the optimistic card-removal was premature (the server doesn't actually know the dislike), so the card should reappear. The `suggestionsSnapshot` array stored the pre-removal state for every affected cache entry.

4. The comment says: invalidating `['suggestions']` on every dot click replaces the lineup the instant the user acts, destroying any in-progress triage — the user can't mark the other cards they were eyeing. The signal is already persisted server-side and the optimistic update reflects the click instantly, so the strip stays stable across a batch of yes/no calls.

5. Change `const LOW_WATER_MARK = 5` at line 157 to `const LOW_WATER_MARK = 8`. Nothing else needs to change — the rest of the logic compares `lowest <= LOW_WATER_MARK` and the behavior scales automatically.

---

