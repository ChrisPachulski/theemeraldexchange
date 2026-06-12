
# SPA Tab Architecture & IPTV Hooks — Teaching Dossier

---

## 1. WHAT

The Emerald Exchange SPA is a single-page app rendered in a browser. Think of it as one web page that never reloads — instead of navigating between pages, the user switches between **tabs**, and React swaps out which component is on screen. There are six tabs in the routing table: Home, TV Shows, Movies, Downloads, Users (admin-only), and Live (IPTV). The URL uses a hash — `#/tv`, `#/movies`, `#/live` — so the server always serves the same `index.html` and the client figures out which tab to show. Every tab talks to the same backend API (a Hono/TypeScript server running on the NAS), but each tab is responsible for a distinct feature domain: TV fetches from Sonarr, Movies fetches from Radarr, Downloads aggregates SABnzbd + both arr queues, Live proxies an IPTV provider, and Users reads an `/api/users` endpoint. The Home tab is a pure landing page — it makes no API calls at all; it just explains the service and provides navigation buttons. All data-fetching tabs use TanStack Query (React Query) so data is cached, shared between components on the same tab, and automatically kept reasonably fresh without polling.

---

## 2. WHY

**Why tab-per-feature?** Each tab is a self-contained React component tree. This has three payoffs: (1) state is local — a search query typed in Movies doesn't corrupt the TV search; (2) code is split by feature — a developer touching the downloads display doesn't need to read IPTV concurrency logic; (3) feature toggling is trivial — the Live tab is gated by `limits.data?.iptvEnabled` and a route guard bounces users home if the flag is off, all without touching the other tabs. Tabs also map cleanly onto the API: there is no shared "get me everything" endpoint, so a tab-per-service model is the natural fit.

**Why lazy loading?** Non-home tabs (`TvTab`, `MoviesTab`, `DownloadsTab`, `UsersTab`, `IptvTab`) are wrapped in React's `lazy()` in `App.tsx`. This means Vite splits them into separate JS chunks at build time. On first load, the browser downloads only the shell (kraken atmosphere, nav, HomeTab, Three.js) — roughly the code that is visible within one second of opening the app. Visiting `/tv` for the first time triggers a network request for the TV chunk, which transitively includes `DetailModal`, `AddSeriesModal`, all the Sonarr types, etc. The payoff is a faster initial paint for the extremely common case: a user who authenticates via Plex and lands on Home, then navigates to one feature. The fallback during the chunk load is a `<LoadingPulse>` spinner that lives in `<Suspense>`.

**Why hash routing?** The SPA is deployed on Netlify as a static site. A path-based router (`/tv`) would require a server to rewrite all paths to `index.html`. A hash-based router (`#/tv`) works off any static host with zero server config because the hash is never sent to the server — the browser handles it locally. `src/lib/router.ts` parses `window.location.hash`, listens to `hashchange`, and returns a `[route, navigate]` pair.

---

## 3. MAP

### Tab Table

| File path | What it shows | Backend routes it calls |
|---|---|---|
| `src/components/tabs/HomeTab.tsx` | Landing page: service explainer panels + nav buttons. Admin users see the Users button; regular users do not. No data fetches. | None |
| `src/components/tabs/TvTab.tsx` | TV show library + discovery. Two modes: Discover (TMDB search via Sonarr lookup, trending/personalized strip) and Library (full Sonarr catalogue with sort/filter/alphabet bar). Clicking a show opens DetailModal; in-library shows get season disclosures. Supports in-browser episode playback via EpisodePicker + MediaPlayer when media-core is enabled. | `GET /api/sonarr/series`, `GET /api/sonarr/lookup`, `GET /api/sonarr/episodes/:id`, `POST /api/sonarr/series`, `DELETE /api/sonarr/series/:id`, `POST /api/sonarr/season`, `GET /api/media/shows`, `GET /api/media/watch`, `GET /api/recommendations/suggestions`, `POST /api/recommender/click` |
| `src/components/tabs/MoviesTab.tsx` | Movie library + discovery. Mirror of TvTab but for movies: Discover (Radarr search + trending strip), Library (Radarr catalogue with sort/filter). Supports in-browser movie playback via MediaPlayer. Admin users can trigger an upgrade grab. | `GET /api/radarr/movie`, `GET /api/radarr/lookup`, `POST /api/radarr/movie`, `DELETE /api/radarr/movie/:id`, `POST /api/radarr/upgrade/:id`, `GET /api/media/movies`, `GET /api/media/watch`, `GET /api/recommendations/suggestions`, `POST /api/recommender/click` |
| `src/components/tabs/DownloadsTab.tsx` | SABnzbd download queue + Sonarr/Radarr queue status. Shows the active download with progress bar, queued items below it, download stats (speed/size/ETA/disk free), recently-added library posters. Admin users get pause/resume/cancel controls, a GrabActivityPanel, and UsageDashboard. | `GET /api/sab/queue`, `POST /api/sab/pause`, `POST /api/sab/resume`, `DELETE /api/sab/queue/:id`, `GET /api/sonarr/queue`, `GET /api/radarr/queue`, `GET /api/sonarr/series`, `GET /api/recently-added` |
| `src/components/tabs/IptvTab.tsx` | Thin shell that renders LiveTab. The old content-type subnav (Channels / Movies / Series) was removed; this now equals the Live channel experience only. VodTab and IptvSeriesTab remain in the codebase but are not routed. | (see LiveTab) |
| `src/components/tabs/LiveTab.tsx` | Live TV: default EPG guide view (channel list left, time-axis programmes right, live "now" line) plus a Cards view toggle. Category filter + search in the footer. Clicking a programme block starts live or catchup playback via IptvPlayer. Concurrency errors (provider cap hit) surface a kick-a-session modal. | `GET /api/iptv/live`, `GET /api/iptv/categories/live`, `GET /api/iptv/epg/now`, `GET /api/iptv/epg/grid`, `GET /api/iptv/epg/channel`, `POST /api/iptv/grant/live`, `POST /api/iptv/grant/catchup`, `DELETE /api/iptv/sessions/:id`, `GET /api/iptv/playlist`, `GET /api/iptv/favorites`, `POST /api/iptv/favorites`, `DELETE /api/iptv/favorites` |
| `src/components/tabs/EpgGuide.tsx` | The EPG grid sub-component rendered inside LiveTab. Channels down the left (sticky), scrollable 6-hour time axis across the top (sticky), programme blocks pixel-sized by duration, a live "now" vertical line. Vertically windowed so only on-screen rows are mounted (~11.5k channels with EPG). Clicking a live block starts live playback; clicking a past block (within archive window) starts catchup. | `GET /api/iptv/epg/grid` (via `useIptvEpgGrid`) |
| `src/components/tabs/UsersTab.tsx` | Admin-only. Lists all accepted + pending members (Plex username, email, role). Route-guarded — non-admins are bounced to Home. | `GET /api/users` |
| `src/components/tabs/IptvSeriesTab.tsx` | IPTV on-demand series catalogue (not currently routed). Poster grid with search + category filter. Clicking a series opens a season/episode list; clicking an episode plays it in IptvPlayer with resume support. | `GET /api/iptv/series`, `GET /api/iptv/series/:id`, `GET /api/iptv/categories/series`, `POST /api/iptv/grant/series`, `GET /api/iptv/favorites`, `GET /api/iptv/history` |
| `src/components/tabs/VodTab.tsx` | IPTV VOD catalogue (not currently routed). Same pattern as IptvSeriesTab but for single videos. Poster grid + category filter + playback with resume. | `GET /api/iptv/vod`, `GET /api/iptv/vod/:id`, `GET /api/iptv/categories/vod`, `POST /api/iptv/grant/vod`, `GET /api/iptv/favorites`, `GET /api/iptv/history` |

### Hook Table

| File path | State it owns | Consumed by |
|---|---|---|
| `src/lib/hooks/useIptvLive.ts` | Paginated list of live channels (`{items, total}`) filtered by search query, category, limit, offset. 5-min stale time. | `LiveTab` |
| `src/lib/hooks/useIptvCategories.ts` | Category list for a given content kind (`'live'`, `'vod'`, `'series'`). Very long stale time (6 h) — categories almost never change. | `LiveTab`, `IptvSeriesTab`, `VodTab` |
| `src/lib/hooks/useIptvFavorites.ts` | Three exports: `useIptvFavorites` (raw array of `{kind, item_id}` rows), `useIptvFavoriteSet` (derived `Set<"live:123">` strings for O(1) lookup), `useToggleIptvFavorite` (optimistic mutation — toggles the cache immediately, then fires the API, rolls back on error). | `LiveTab`, `IptvSeriesTab`, `VodTab` |
| `src/lib/hooks/useIptvHistory.ts` | Three exports: `useIptvHistory` (raw resume-position rows), `useIptvHistoryIndex` (derived `Map<"series_episode:456", row>` for O(1) position lookup), `useReportPosition` (throttled fire-and-forget callback — reports position every 5 s max, resets the timer when `kind`/`itemId` changes). | `LiveTab` (via `useReportPosition`), `IptvSeriesTab`, `VodTab` |
| `src/lib/hooks/useIptvEpg.ts` | Three exports: `useIptvEpgNow` (current + next programme for a batch of channel IDs — used for channel card "Now/Next" labels, stale 1 min), `useIptvEpgGrid` (full 6-hour programme grid for the EPG display, stale 1 min), `useIptvEpgChannel` (single-channel programme list for the per-channel guide modal, enabled only when `channelId != null`). | `LiveTab`, `EpgGuide` |
| `src/lib/hooks/useIptvSeries.ts` | Two exports: `useIptvSeries` (paginated IPTV series list) and `useIptvSeriesDetail` (season+episode tree for a single series, stale 6 h, only fires when `id != null`). | `IptvSeriesTab` |
| `src/lib/hooks/useIptvSessions.ts` | Two exports: `useIptvSessions` (list of active stream sessions, polled every 5 s, `staleTime: 0`) and `useKillIptvSession` (mutation — kills a session by ID and invalidates the sessions query). Powers the ConnectionsWidget in the LiveTab footer. | `LiveTab` (via `ConnectionsWidget`) |
| `src/lib/hooks/useIptvVod.ts` | Two exports: `useIptvVod` (paginated VOD list) and `useIptvVodDetail` (single-item detail, stale 6 h, enabled-guarded). | `VodTab` |

---

## 4. PREREQUISITES

Before this dossier makes full sense, a learner needs:

1. **React fundamentals** — components, props, state (`useState`), effects (`useEffect`), and how JSX compiles to function calls.
2. **React hooks** — the rules of hooks (no conditionals, no loops), `useMemo` for derived state, `useCallback` for stable function references.
3. **TanStack Query (React Query)** — what `useQuery` and `useMutation` do, what `queryKey` is and why it matters for caching, what `staleTime` controls, and how `invalidateQueries` triggers a refetch. This is the data layer every non-home tab sits on top of.
4. **Hash-based SPA routing** — why `window.location.hash` doesn't cause a page reload, and how `hashchange` events let `router.ts` re-render the right tab.
5. **React `lazy` + `Suspense`** — how dynamic `import()` returns a Promise, how `lazy()` wraps it, and how `Suspense` provides the loading fallback.
6. **The spa-shell dossier** (already written) — covers the Kraken atmosphere, TopNav/HomeNav, AuthProvider/AuthGate, and the overall shell structure that wraps all tabs.
7. **The spa-api-layer dossier** (already written) — covers how `src/lib/api/*.ts` files form the fetch boundary each hook delegates to.
8. **The spa-player dossier** (already written) — covers IptvPlayer and MediaPlayer in depth; this dossier deliberately skips that to avoid duplication.
9. **The spa-recs-ui dossier** (already written) — covers useSuggestionStrip, TrendingRow, FeedbackDots in depth; TvTab and MoviesTab both use these.

---

## 5. GOTCHAS & WAR STORIES

**Lazy chunk deploy verification.** When Netlify auto-deploys on a `main` push, the entry chunk hash (`index-*.js`) does NOT change if only lazy tab chunks changed — only the lazy chunks themselves get new hashes. This burned the team once when a fix deployed to the TV tab was confirmed "live" by checking the entry chunk hash in the deployed bundle. The entry chunk looked identical to pre-deploy because it only contains the `lazy(() => import(...))` call, not the tab code itself. The correct verification: grep the deployed lazy chunk for a unique marker in the changed code. See `project_suggestion_strip_toggle_and_deploy_arch` memory.

**VodTab and IptvSeriesTab are dead routes.** Both files exist and compile, and all their IPTV hooks work, but neither is wired into `App.tsx`'s `TABS` map or into the `Route` type in `router.ts`. They were removed when the IPTV tab was simplified to Live only. A new developer may wonder why `useIptvVod` exists but nothing seems to call it from a routed tab — that's why.

**IptvTab is just a wrapper.** `IptvTab.tsx` is a single-component file that renders `<LiveTab />` inside a shell div. It exists so the lazy import boundary in `App.tsx` can target a dedicated file (`import('./components/tabs/IptvTab')`) without directly importing LiveTab, keeping LiveTab's full dependency tree out of the entry chunk.

**Concurrency cap handling is session-level, not error-boundary-level.** When the IPTV provider rejects a new stream because its connection cap is hit, `iptvApi.grantLive` throws an error that `concurrencyPayloadFromError` recognizes. LiveTab catches this at the `playChannel` / `playCatchup` call site, surfaces `ConcurrencyLimitModal`, and stashes the pending play as `pendingPlay`. Once the user kicks a session, the stashed attempt retries. The important lesson: the error is handled at the point of the API call, not as a global ErrorBoundary, because only the IPTV tab knows what "retry the play" means in context.

**EPG scroll listener must bind after data loads.** EpgGuide uses a `useEffect` with `[guideReady]` dependency to attach the scroll listener. Before data loads, `scrollRef.current` is null (the scroll container doesn't exist yet — the component renders a `<p>Loading...` instead). An earlier version used `[]` deps, which ran exactly once during "Loading...", found a null ref, and never re-ran. The result was a frozen guide that looked like it had only ~25 channels even though thousands were returned. The fix was adding `guideReady` to the effect's dependency array so the listener binds as soon as the scroll container mounts. The comment in `EpgGuide.tsx` at line ~91 explains this in detail.

**Sessions useIptvSessions polling vs. other hooks.** `useIptvSessions` has `refetchInterval: 5_000` and `staleTime: 0` — it is the only IPTV hook designed to poll. Every other IPTV hook has a stale time (1 min, 5 min, or 6 h) and only fetches on mount or explicit invalidation. This distinction matters: if a developer accidentally copies `staleTime: 0` from the sessions hook into, say, `useIptvEpgGrid`, the EPG grid would refetch on every render, hammering the backend.

**useToggleIptvFavorite uses optimistic updates.** Unlike most hooks in the codebase, `useToggleIptvFavorite` modifies the query cache immediately (via `onMutate`), before the server responds. It also cancels any in-flight queries for the favorites key to avoid a stale response overwriting the optimistic state. On error, `onError` rolls back via the snapshot saved in `onMutate`. This is a more complex pattern than the other IPTV hooks — the complexity pays for instant star toggle feedback in the UI.

---

## 6. QUIZ BANK

**Q1.** A user opens the Movies tab, searches for "Dune", clicks the result, and the DetailModal opens with an "Add to library" button. While that modal is open, she switches to the TV tab and back. When she returns, the modal is gone and the search box is empty. Why does this happen, and is it a bug?

*Answer:* This is expected behavior, not a bug. Each tab is a separate React component that unmounts when the route changes and remounts when the user navigates back. All component-local state (`useState`) — including the `viewing` item that controls whether the modal is open and the `query` string — is destroyed on unmount and re-initialized to its default value on remount. The fix would be to lift state out of the tab (e.g., into URL params or a context), but the product deliberately chose not to do this — state is cheap to recreate and cross-tab state sharing would complicate the codebase significantly.

**Q2.** `useIptvEpgNow` takes a `channelIds: number[]` array as a parameter, but the query key serializes them as a sorted, deduplicated, comma-joined string. Why the extra processing when React Query accepts arrays as query keys?

*Answer:* Without processing, React Query compares arrays by reference, not by value. A new `channelIds` array is created on every render by `useMemo(() => visibleChannels.map(...))`, so even if the IDs haven't changed, a new array object would be a new query key, causing a refetch. The `stableChannelIds` helper sorts and deduplicates the IDs and joins them into a string — strings compare by value in JavaScript, so the same IDs always produce the same cache key. This is a classic React Query normalization pattern.

**Q3.** The Downloads tab joins data from three different sources: `useDownloadQueue` (SABnzbd), `useSonarrQueue`, and `useSonarrLibrary`. Each of these is its own `useQuery`. If SABnzbd is down and `useDownloadQueue` returns an error, the tab renders an error state and returns early — neither the Sonarr data nor the library are shown. Is there a better approach, and why did the team choose the current behavior?

*Answer:* A more resilient approach would be to show the Sonarr queue independently of the SAB error — "SAB is down, but here are the pending Sonarr grabs." The current approach returns early on a SAB error because the core of the Downloads tab is the SAB queue display; the Sonarr and library data are supporting context. The early return is a product simplicity choice: the team prioritized a clean "this is broken" signal over a partial-data UI that might mislead users into thinking downloads are happening when the downloader itself is unreachable.

**Q4.** `useReportPosition` is used identically in both LiveTab and IptvSeriesTab, but `useIptvSessions` (which polls every 5 s) is only used inside `ConnectionsWidget` which only renders in the LiveTab footer — not in IptvSeriesTab. What would break if someone added `<ConnectionsWidget />` to IptvSeriesTab as well?

*Answer:* Nothing would break functionally — `ConnectionsWidget` would render correctly and show active sessions. The `useIptvSessions` hook would start polling at 5-second intervals while IptvSeriesTab is mounted. The concern is unnecessary backend load: if a user is watching a series episode and the Sessions widget is present, the browser fires a `/api/iptv/sessions` request every 5 seconds for the entire viewing session. Since `refetchIntervalInBackground: false` is set, the polling does pause when the tab is backgrounded, which mitigates it somewhat. But the hook was explicitly scoped to the Live tab's footer widget because active-session awareness is a Live TV concern (to manage concurrency slots), not an on-demand series concern.

**Q5.** Both TvTab and MoviesTab call `useSuggestionStrip('tv', libraryTmdbIds)` and `useSuggestionStrip('movie', libraryTmdbIds)` respectively. The strip has `staleTime: Infinity` so it never auto-refetches. A user adds a movie to the library via AddMovieModal. How does the strip avoid showing that just-added movie in the recommendations?

*Answer:* The strip doesn't re-fetch — but it doesn't need to. The `libraryTmdbIds` set (derived via `useMemo` from the Radarr library query) is passed to `useSuggestionStrip` as a filter. When the library query invalidates after the add mutation succeeds, `libraryByTmdb` updates, `libraryTmdbIds` recomputes, and the strip re-derives its `items` by filtering out any IDs now in the library. The recommendation data itself is unchanged (stale forever) but the displayed items shrink. This "filter at render time rather than refetch" approach is why the AddMovieModal's `onSuccess` used to call `invalidateQueries(['suggestions'])` (which bypassed staleTime and caused the strip to reshuffle) — that call was removed as part of the fourth recommender-strip fix.

**Q6.** Why does `useIptvVod` exist if no routed tab calls it?

*Answer:* VodTab is present in the codebase but not wired into the router. The hook, the tab component, and the API methods all compiled and were used when VodTab was part of the IPTV subnav. When the Live tab was simplified to Live TV only, the routing was removed but the code was kept — partly because the product decision to remove VOD was not permanent (it may get a home later), and partly because dead code that still compiles is lower-risk than partially deleted code that breaks imports. `useIptvVod` having no active consumer is a "parked feature" signal, not a bug.

---

## 7. CODE-READING EXERCISE — Walking LiveTab's play flow

Open `src/components/tabs/LiveTab.tsx`. The goal is to trace exactly what happens from the moment a user clicks a channel card to the moment video is playing.

**Step 1 — Find the click handler.** The channel list is a `<ul className="iptv-channel-grid">` (lines ~155–214). Each `<li>` has an `onClick` of `() => void playChannel(c)`.

**Step 2 — Read `playChannel` (~line 94).** It calls `iptvApi.grantLive(stream.stream_id.toString())`. This is an API call to `POST /api/iptv/grant/live` — the backend proxies it to the IPTV provider, acquires a stream slot, and returns a `StreamGrant` containing a stream URL, a `sessionId`, and an expiry. On success, `setPlaying({ grant, title, itemId })` updates state. On error, the function checks `concurrencyPayloadFromError(err)` — if the provider rejected the request because the connection cap was hit, it pops the `ConcurrencyLimitModal` and stashes `() => attempt` in `pendingPlay`.

**Step 3 — Trace `playing` state to the DOM.** At the bottom of the JSX (~line 292): `{playing && <PlayerModal playing={playing} onClose={...} onPositionUpdate={...} />}`. The `PlayerModal` component (lines ~323–351) is a full-bleed div with `role="dialog"` and `aria-modal="true"`. It renders `<IptvPlayer grant={playing.grant} autoPlay ... />`. IptvPlayer is covered in the player dossier — the key fact here is that the grant's stream URL is an HLS manifest; hls.js plays it.

**Step 4 — Understand the cleanup.** The `useEffect` at line ~67 watches `playing?.grant.sessionId`. When it changes (new channel) or the component unmounts, the cleanup function fires `iptvApi.killSession(sid)` — releasing the concurrency slot. Without this, rapidly switching channels would accumulate phantom active sessions on the provider and exhaust the cap.

**Step 5 — Find where position reporting goes.** The `PlayerModal`'s `onPositionUpdate` prop calls `reportPosition(positionSecs, durationSecs, false)`. `reportPosition` is the return value of `useReportPosition('live', playing?.itemId ?? '')` at line ~56. Reading `useIptvHistory.ts`, this is a throttled `useCallback` that fires `iptvApi.putHistory(...)` at most once every 5 seconds. The history record enables "resume from where you left off" when the user re-opens a live channel (live TV doesn't actually resume, but VOD/series do).

**What to notice:** The entire play flow touches three hook files (`useIptvLive`, `useIptvSessions` via `ConnectionsWidget`, `useIptvHistory` via `useReportPosition`), one API module (`iptvApi`), one sub-component (`EpgGuide` for the guide view), one player component (`IptvPlayer`), and a concurrency helper (`concurrencyLimit.ts`). Each piece has a single responsibility and LiveTab is the orchestrator that wires them together.

---

