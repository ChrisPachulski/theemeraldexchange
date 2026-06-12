
# SPA API Client Layer — Teaching Dossier

## 1. WHAT

The SPA's API client layer is a thin TypeScript wrapper around `fetch()` that turns HTTP responses from `/api/*` endpoints into JavaScript objects the React components can work with. It's located in `src/lib/api/` (base.ts, media.ts, errors.ts, etc.) and `src/lib/hooks/` (useMediaLibrary.ts and friends). The layer does three jobs: (1) adds timeouts and error handling to every request, (2) converts snake_case backend responses into camelCase JavaScript objects, and (3) feeds those objects to React Query, which caches them so the UI doesn't re-fetch the same data on every re-render. When errors happen, they become readable toasts instead of raw HTTP status codes.

## 2. WHY

**Why a dedicated client layer:** The backend (Hono) returns snake_case JSON (`tmdb_id`, `added_at`) because it mirrors the Rust media-core library's serde defaults, but the React codebase expects camelCase (`tmdbId`, `addedAt`). A single normalizer in `src/lib/api/media.ts` (the `normMovie`, `normShow` functions) keeps that translation in one place — if the API changes shape, you fix it once, not in 50 components.

**Why caching (React Query):** The `/api/movies` endpoint returns your entire local library. If every component that displays a movie called it independently, you'd fire the same request 30+ times per page load. React Query caches the response (default 30 seconds, called `staleTime`) — subsequent requests within that window get the cached answer instantly. Beyond staleTime, the next caller triggers a fresh fetch, keeping data reasonably fresh without hammering the backend.

**Why query hooks:** `useLocalMovieIndex()` and `useMediaWatch()` are the glue: they wrap React Query's `useQuery()` with sensible defaults (what to cache, how long to cache it) and transform raw API responses into the shapes components actually need. That boundary — "the API returned a list, now I need a map of tmdbId→id" — goes in a hook, not in 50 components.

## 3. MAP

### Key files (src/lib/ only):

- **src/lib/api/base.ts** (24 lines): The `apiUrl()` function. In dev, it returns same-origin URLs like `/api/media/movies` (Vite proxy forwards to backend); in prod, it builds absolute URLs like `https://api.theemeraldexchange.com/api/media/movies` (cross-origin, credentials='include').

- **src/lib/api/media.ts** (659 lines): The thin fetch client. Has raw types (`RawMovieRow`, snake_case), normalized types (`MediaMovie`, camelCase), and the `mediaApi` export — a bag of functions (`allMovies()`, `playback()`, `watch()`, etc.) that each wrap `fetch()` with timeout + error handling + normalization.

- **src/lib/api/errors.ts** (137 lines): The `ApiError` class and `throwApiError()` fn. When the backend returns a 4xx/5xx, `throwApiError()` reads the JSON body (e.g., `{ error: 'insufficient_disk_space', free_bytes: ... }`), constructs a readable message (e.g., "Not enough disk space. 1.2 GB free, need 5 GB."), and throws an `ApiError` with both the message and the raw details. Components catch this and render a toast.

- **src/lib/queryClient.ts** (52 lines): The root React Query cache config. Sets global defaults (staleTime: 30s, single retry, no refetch-on-focus), and wires a `SESSION_EXPIRED_EVENT` dispatch when any query hits a 401/403 — the auth provider listens for this and logs the user out.

- **src/lib/hooks/useMediaLibrary.ts** (113 lines): Four hooks that wrap the media API. `useLocalMovieIndex()` calls `mediaApi.allMovies()` and transforms the flat list into a Map<tmdbId, localId>. `useReportWatch()` throttles watch-progress saves to once per 10 seconds (unless forced, e.g., on pause). The rest are read hooks.

### Walkthrough: useLocalMovieIndex (lines 11-23, useMediaLibrary.ts)

When the Detail modal opens a title and wants to show a "Play Direct here" button, it calls `useLocalMovieIndex(enabled)`:

```typescript
export function useLocalMovieIndex(enabled: boolean) {
  return useQuery({
    queryKey: ['media', 'movies', 'index'],
    queryFn: ({ signal }) => mediaApi.allMovies({ signal }),
    staleTime: 60_000,
    enabled,
    select: (data): Map<number, number> => {
      const m = new Map<number, number>()
      for (const mv of data) if (mv.tmdbId) m.set(mv.tmdbId, mv.id)
      return m
    },
  })
}
```

React Query does:
1. **queryKey**: `['media', 'movies', 'index']` is the cache key. If another component uses the same hook, they share the same cache entry (no duplicate fetches).
2. **queryFn**: Calls `mediaApi.allMovies({ signal })`, which pages through `/api/media/movies` at 200 items per page until it has every title. The `signal` prop lets React Query cancel the request if the component unmounts.
3. **staleTime: 60_000**: Cache is fresh for 60 seconds. After that, the next caller re-runs queryFn automatically (no explicit refetch call needed).
4. **enabled**: Gates the query (if false, it never fires). Deployments without a media-core don't 404.
5. **select**: Transforms the data AFTER caching. The raw API returns an array; `select` converts it to a Map so components can do `movieIndex.get(tmdbId)` in O(1) instead of looping.

The "Play Direct" button's hidden bug was that `allMovies()` didn't exist — developers called `/movies` with no limit, which returns only the first 50 (or 200, backend's cap). The library was 817 titles. So the button appeared only for titles 1-50. Fixed by adding `allMovies()` (lines 552-569, media.ts), which pages through at MAX_LIST_PAGES=200 (40k title ceiling).

---

## 4. PREREQUISITES

### Fetch, eli5:
`fetch(url, options)` is the browser's HTTP API. Returns a Response object whose `.ok` (true if status 200-299), `.status`, and `.json()` (parses the body) you can inspect:

```typescript
const res = await fetch('/api/movies')
if (res.ok) {
  const data = await res.json() // Returns a Promise
  console.log(data.items)
} else {
  console.error(res.status, res.statusText) // 404, 503, etc.
}
```

The client adds timeout (AbortSignal.timeout + AbortSignal.any), credentials (the `'include'` flag tells the browser to send cookies), and error throwing (`throwApiError` on non-ok).

### Caching, eli5:
React Query is a library that sits between your component and fetch, remembering the last response. If you call `useQuery(key, fn)` twice:
- **First call**: Runs `fn` (i.e., fetch), stores the result under the key.
- **Second call (within staleTime)**: Returns the cached result instantly without running `fn`.
- **Third call (after staleTime expires)**: Marks data as "stale" but still returns it immediately (optimistic); in the background, runs `fn` again and updates the cache if the new response differs.

This saves bandwidth and latency. But staleTime is NOT "cache forever" — it's "this data is fresh enough to show without re-fetching". Example: `staleTime: 30_000` = "30s is my SLA for a stale title list".

### Query hooks, eli5:
A custom hook is a React function that encodes a piece of application logic. `useLocalMovieIndex()` wraps `useQuery()` and adds the tmdbId→id transformation. Calling it from two different components both hit the same cache entry (same queryKey). If you need the raw array instead of a map, you'd write a different hook:

```typescript
export function useMovieList() {
  return useQuery({
    queryKey: ['media', 'movies', 'list'],
    queryFn: ({ signal }) => mediaApi.movies(undefined, { signal }),
    staleTime: 60_000,
    // No `select` — return the raw array
  })
}
```

Different queryKey = different cache = different fetch. The boundary between "what shape the API returns" (Array) and "what shape this app logic needs" (Map) goes in the hook.

---

## 5. GOTCHAS & WAR STORIES

### **Play Direct Button Vanished for Large Libraries**
The Detail modal has a "Play Direct here" button — if the local library has a matching tmdbId, play the file instead of transcoding. Developers called `/api/media/movies` to build an index, but the API caps responses at 50 items (or 200 at max). A library with 817 titles returned only the first 50 in the index, so the button appeared for movies 1-50 and silently vanished for the rest.

Fix: Added `allMovies()` and `allShows()` (media.ts, lines 552-588) that page through the API at 200 items per batch and concatenate until `items.length < PAGE_SIZE`. Now the index covers the whole library. Both a schema fix (the function) and a schema test (verify the index is complete, not "did you call allMovies").

### **staleTime:0 Churn**
In an early version, the suggestion strip had `staleTime: 0` — every time you switched from Recommended to Trending and back, or the component remounted for any reason, React Query re-ran the expensive Claude API call. The user opened the strip, browsed two picks, toggled to Trending, toggled back, and the entire lineup swapped because the recommender re-ran. (Issue: "the strip keeps refreshing".)

Fix: Set `staleTime: Infinity` (lines 10-20, useSuggested.ts). The user calls `refetch()` manually (Refresh button) when they want new picks. Toggling Recommended ⇄ Trending no longer invalidates the query, so the lineup stays put while browsing. Variety still comes from the backend's temperature (randomness param) on explicit refresh.

### **Timeout: 15 Seconds Default**
`mediaApi.get()` and `post()` default to 15_000ms (15 seconds) before aborting. A stalled backend (media-core down, network partition) would pin a query in "pending" forever otherwise, showing an endless spinner. If the backend is actually slow (large scan, slow disk), raise the timeout on that call: `mediaApi.playback(..., { timeoutMs: 30_000 })`. Default is conservative; override upward if you know better.

### **Credentials: 'include' and Cross-Origin**
In prod, the SPA (Netlify) is at a different origin than the backend (api.theemeraldexchange.com). Every fetch needs `credentials: 'include'` to send the authentication cookie. The backend sends the cookie with `SameSite=None; Secure`, and the fetch automatically includes it in request headers (because of the `credentials` flag). In dev, Vite proxies `/api/*` to the backend (same origin), so the cookie is sent by default.

### **Post Requests Need Origin or CSRF 403**
POST requests (watch progress, heartbeat, stop) are gated by a CSRF check in production. The browser automatically sends the `Origin` header on cross-origin POSTs. If a request is missing `Origin` (e.g., malformed keepalive fetch), the backend rejects it with 403. The `mediaApi.heartbeat()` and `mediaApi.stop()` functions use the `heartbeatUrl`/`stopUrl` directly, which already carry the session token in the query string (`?t=...`), so they don't need cookies — the token is the credential.

### **Playback Grant URL Resolution**
The backend returns grant URLs as root-relative (`/api/transcode/...?t=TOKEN`). The frontend absolutizes them with `apiUrl()` so the <video>/hls.js player loads them from the correct origin in prod. Example: mediaApi.playback() calls `absolutizeGrant()` (media.ts, lines 483-500) which rewrites `/api/transcode/...` → `https://api.theemeraldexchange.com/api/transcode/...`. Miss this and prod playback silently breaks (cross-origin fetch, no cookies, 403s).

---

## 6. QUIZ BANK

### Q1: Why does mediaApi.allMovies() page through the API instead of asking for everything at once?
**Answer:** The backend's `/movies` route caps responses at 200 items and doesn't support unbounded requests. If you pass `limit: 200, offset: 0`, you get items 0-199. To get all 817 items, the client must loop: fetch offset 0-199, then 200-399, etc., until the response has fewer than 200 items (meaning you've hit the end). This is a classic pagination pattern; the alternative (asking the backend to return 40k items in one response) would be slow and memory-heavy.

### Q2: A component uses `useLocalMovieIndex()` and sees a stale movie list (a file was added to the library an hour ago but doesn't show up). How would you fix it?
**Answer:** The hook has `staleTime: 60_000` (1 minute). After 1 minute, the cache is stale. When the component remounts or another component requests the same queryKey, React Query refetches automatically. If the update is urgent, call `queryClient.invalidateQueries({ queryKey: ['media', 'movies', 'index'] })` to mark it stale immediately, triggering a refetch on next use. Or the user can navigate away and back (remount), which refetches after the staleTime window. The app doesn't auto-refetch (refetchOnWindowFocus: false in queryClient.ts), so the user must act.

### Q3: A POST to `/watch` with `credentials: 'include'` returns a 403 in production but works in dev. What's the likely cause?
**Answer:** The request is missing the `Origin` header (or it's malformed). The dev environment uses `localhost:3000` (same origin as the proxy), so the CSRF check is bypassed. In prod, the SPA (Netlify) and backend (api.theemeraldexchange.com) are different origins — the browser sends `Origin: https://www.theemeraldexchange.com` automatically, and the backend checks that it's in the whitelist. If the request is a cross-origin POST without `Origin` (e.g., a manual fetch call without headers), the backend rejects it. Check: fetch options must include `{ credentials: 'include', headers: { 'Content-Type': 'application/json' } }` and be called from the correct origin.

### Q4: The /playback/:kind/:id grant returns a URL like `/api/transcode/movie/123?t=xyz`. Why does the frontend rewrite it to an absolute URL?
**Answer:** The <video> or hls.js player needs to load the stream from the same origin as the API (in prod, api.theemeraldexchange.com), not from the SPA origin (Netlify). The backend returns a root-relative path assuming same-origin loading. The frontend calls `absolutizeGrant()` to rewrite `/api/transcode/...` → `https://api.theemeraldexchange.com/api/transcode/...`. Without this rewrite, the <video> element would try to fetch from `https://www.theemeraldexchange.com/api/transcode/...` (the SPA origin), which is a 404 or cross-origin rejection. The token (`?t=xyz`) is also preserved, so authentication works.

### Q5: Why does useReportWatch() throttle saves to once per 10 seconds, and why is there a `force` parameter?
**Answer:** The player fires a `timeupdate` event ~4 times per second as the video plays. Naively saving watch progress on every event would POST 4 times per second, hammering the backend and the database. The throttle (`WATCH_REPORT_INTERVAL_MS = 10_000`) saves at most every 10 seconds, batching updates. The `force` parameter (set to true on pause, ended, or player close) bypasses the throttle, ensuring the final resume point is accurate — you pause, the mutate fires immediately, so when you close the tab and reopen, you resume from the exact pause point, not from 10s earlier.

---

## 7. CODE-READING EXERCISE

**File: src/lib/api/media.ts, lines 26-64 (the `get()` function)**

**Setup:** This is the foundation fetch wrapper. Walk through it in order.

**Questions:**

1. **Lines 20-24 (withTimeout):** What does `AbortSignal.any()` do?
   - **Answer:** It combines two abort signals (the hard timeout and React Query's component-unmount signal) into one. If EITHER signal aborts, the combined signal aborts. This way, a request is cancelled if (a) the component unmounts (React Query's signal fires), OR (b) 15 seconds pass without a response (timeout fires), whichever comes first.

2. **Lines 31-42 (the try/catch):** Why is the timeout check inside the catch?
   - **Answer:** If the timeout aborts, the `fetch()` call throws an AbortError. The catch catches it. Inside the catch, we check if `timeout.aborted` is true — if it is, we know the timeout fired (not a network error or React Query cancellation), so we throw an `ApiError(0, 'Media /movies timed out')` with a human-readable message instead of an opaque AbortError.

3. **Line 43 (throwApiError):** Why is `throwApiError()` awaited, and what does it throw?
   - **Answer:** `throwApiError()` is async because it calls `await res.json()` to read the body. It ALWAYS throws (throws, never returns) — it parses the error response and constructs an ApiError with a readable message. If the JSON body is empty (non-JSON 500), it falls back to the status text. The caller (the hook or component) catches this and renders a toast.

4. **Line 44 (credentials):** Why is this fetch call different in dev vs. prod?
   - **Answer:** In dev, the SPA and backend are the same origin (both localhost via Vite proxy), so `credentials: 'include'` includes the session cookie in the request (it's already same-origin, so the browser sends it by default). In prod, they're different origins (Netlify vs. api.theemeraldexchange.com), so `credentials: 'include'` tells the browser to send the cross-origin cookie (which the backend set with SameSite=None). Without this flag, cross-origin requests don't include cookies by default.

5. **Line 44 (signal):** What does React Query pass in the signal, and what happens if the user navigates away while the request is in flight?
   - **Answer:** React Query passes an AbortSignal that fires when the component using the hook unmounts or the query is manually cancelled. If the user navigates away, the component unmounts, React Query fires the signal, the fetch() call throws AbortError, and the promise is cancelled (never resolved). The UI doesn't see a stale response pop in after navigation.

---

