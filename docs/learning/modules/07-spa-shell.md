
# SPA Application Shell — Teaching Dossier

---

## 1. WHAT

The Emerald Exchange web app is a **Single-Page Application (SPA)**: the browser downloads one HTML file (`index.html`) and one JavaScript bundle, and from that point on JavaScript takes full control of the screen — it never loads a new page from the server. Instead of navigating to `movies.html` or `tv.html`, the JavaScript listens to the URL's `#` fragment (the part after the `#`) and swaps which component is drawn on screen. To a user it feels like a normal multi-page website with TV, Movies, and Downloads sections; to the browser, it is always the same HTML document, just with different content rendered inside a `<div id="root">` placeholder. The framework doing this rendering is **React**: a library that lets you describe what the screen *should* look like as a tree of reusable **components** (functions that return HTML-like JSX), and re-draws only the parts that change when data updates.

---

## 2. WHY

**Why a SPA instead of a traditional multi-page website?**
Because this is an app, not a document site. Every tab — TV, Movies, Downloads — shares a persistent animated background (the Kraken atmosphere), a navigation bar, and user identity. Re-loading a full page on every click would flash the screen, lose the background animation, and re-run the session check from scratch each time. A SPA keeps all of that mounted in memory and only swaps the center content.

**Why React specifically?**
React's component model means the TV tab and the Movies tab are independent modules. You can add, remove, or rewrite one without touching the other. React also lazy-loads non-home tabs (they are not in the initial JavaScript bundle at all — the browser only downloads the Movies code when someone actually navigates to Movies), which keeps the first-load fast.

**Why React Query (`@tanstack/react-query`) for server state?**
Every tab needs to fetch data from the backend: movie lists, download status, suggestions. Raw `fetch` calls inside React components create a mess: you have to manually track loading/error states, deduplicate identical requests from different components, and decide when stale data should be refreshed. React Query solves all of this with a single `queryClient` cache. Any component that asks for `['movies']` gets the same cached response; React Query automatically refetches in the background when the cache expires (default 30 seconds here). It also handles the entire session-expiry loop: when *any* API call returns a 401, the `queryClient` fires a `SESSION_EXPIRED_EVENT` and the whole app drops back to the login screen.

---

## 3. MAP

### Key files

| File | What it does |
|---|---|
| `index.html` (line 17) | The single HTML page. Contains only `<div id="root">` and a `<script>` tag loading the JS. |
| `src/main.tsx` | Entry point. Mounts React into `#root`, wraps the app in providers. |
| `src/App.tsx` | Top-level component tree. Owns auth gating and tab routing. |
| `src/lib/router.ts` | Hash-based router. Parses `window.location.hash` to pick the active tab. |
| `src/lib/auth.tsx` | `AuthProvider` + `useAuth` hook. Fetches `/api/me` to discover if the user is logged in, owns all sign-in flows. |
| `src/lib/queryClient.ts` | Creates the single React Query client with session-expiry wiring. |
| `src/components/tabs/HomeTab.tsx` | The default landing tab (always in the main bundle). |
| `src/components/nav/TopNav.tsx` | The persistent navigation bar shown on all non-home tabs. |

### Boot walkthrough: `index.html` → first tab render

```
1. Browser fetches https://theemeraldexchange.com/
   → Server returns index.html (20 lines, static)
   → Browser sees <div id="root"> (empty) and <script src="/src/main.tsx">

2. Vite-bundled main.tsx runs (src/main.tsx:16-28):
   → initTelemetry() wires crash reporting (§15 Glitchtip) BEFORE any render
   → createRoot(document.getElementById('root')) mounts React
   → Render tree (outermost first):
       StrictMode
       └─ ErrorBoundary          (catches render-time crashes)
          └─ QueryClientProvider (injects the shared React Query cache)
             └─ ConfirmProvider  (global confirm-dialog context)
                └─ App

3. App renders (src/App.tsx:118-124):
   └─ AuthProvider               (starts the /api/me fetch)
      └─ AuthGate                (checks auth state)

4. AuthGate (src/App.tsx:98-116):
   → While /api/me is in-flight: renders null (blank screen, ~1 RTT)
   → If /api/me returns 401 (not logged in): renders <Walkthrough>
   → If /api/me returns user: renders <NavTransitionProvider><Shell>

5. Shell (src/App.tsx:56-89):
   → useRoute() reads window.location.hash → defaults to 'home'
   → useAuth() checks isAdmin for route gating
   → useLimits() checks if IPTV is enabled for the Live tab gate
   → Renders:
       <Kraken>         (animated background, persistent)
       <HomeNav>        (home-specific nav) OR <TopNav> (non-home)
       <main>
         <Suspense>
           <ActiveTab>  (HomeTab on first load, already in the bundle)
         </Suspense>
       </main>
       <ReplayButton>

6. Subsequent tab click (e.g. user clicks "Movies"):
   → TopNav calls transitionTo('movies') → sets window.location.hash = '#/movies'
   → useRoute()'s hashchange listener fires → setRoute('movies')
   → Shell re-renders → ActiveTab = MoviesTab (lazy)
   → React.lazy triggers dynamic import → browser fetches the movies chunk
   → <Suspense> shows <LoadingPulse> during the download
   → MoviesTab mounts and fires its useQuery calls
```

---

## 4. PREREQUISITES

**HTML basics (5-minute version)**
An HTML file is a text document that describes the structure of a web page using tags like `<div>`, `<button>`, `<h1>`. The browser reads it top to bottom and draws the result. The critical insight for SPAs: a `<div id="root">` is just an empty container — JavaScript fills it after the page loads.

**JavaScript basics**
JavaScript is the language browsers run. It can read the page, create/remove elements, make network requests (fetch), and respond to user clicks. In modern JS, you write modules (files that import/export functions), and a build tool like Vite bundles them into one or a few files the browser can load efficiently.

**React components (eli5)**
A React component is just a JavaScript function that returns JSX (HTML-looking code). When React calls `HomeTab()`, the function returns a tree of elements describing what should appear on screen. React tracks a component's *state* (local variables that, when changed, tell React to call the function again and update the screen). Multiple components compose into a tree: `App` contains `AuthGate`, which contains `Shell`, which contains `TopNav` + the active tab.

**React hooks**
Hooks are special functions (always starting with `use`) you call inside a component to opt into React features: `useState` stores a value and re-renders when it changes; `useEffect` runs side effects (like fetching `/api/me`) after the component renders; `useContext` reads from a Provider higher up in the tree.

**Context / Providers**
A Provider is a component that makes a value available to all its descendants without passing it as props through every layer. `QueryClientProvider` makes the React Query cache available everywhere. `AuthProvider` makes the logged-in user object available everywhere. Any component calls `useAuth()` and gets the current user — no prop-drilling required.

---

## 5. GOTCHAS & WAR STORIES

**Hash-based routing, not URL paths**
The router (`src/lib/router.ts`) uses `window.location.hash` (`#/movies`, `#/tv`), not actual URL paths. This means the server always serves the same `index.html` regardless of what comes after the `#` — the `#` fragment is never sent to the server. Netlify's `_redirects` (or `netlify.toml`) would handle path-based routing; here none is needed because hashes just work.

**Auth loading renders `null`, not a spinner**
`AuthGate` returns `null` while `/api/me` is in-flight (App.tsx:100). This is intentional: the Kraken background is not inside `AuthGate`, so it paints immediately. The blank content area during the ~1-RTT probe is virtually invisible if the session cookie is fresh. If you add a spinner here you will get a flash-of-spinner for every authed page load.

**Lazy tabs and the `Suspense` fallback**
All non-home tabs use `React.lazy()` (App.tsx:25-53). The first time you click "Movies" the browser makes a network request for the movies JS chunk. During that download, React renders the `<Suspense fallback={<LoadingPulse>}>`. If you see `LoadingPulse` for more than a second, either the network is slow or the chunk was not prefetched. The Walkthrough (unauthenticated landing) is also lazy for the same reason — authed users never download it.

**Route gating via `useEffect` bounce, not early return**
The admin/IPTV route guard (App.tsx:66-73) uses `useEffect` to call `navigate('home')` when you land on `/users` without being admin. It also has a synchronous `blocked` check so the wrong tab content never flashes. The `useEffect` fires async (after render), but the synchronous `effectiveRoute` computation prevents the wrong tab from rendering for even one frame.

**Auth clears the entire React Query cache on identity change**
`applyUser` in `auth.tsx` calls `qc.clear()` before setting the new user (auth.tsx:176-182). This prevents per-user data (feedback dots, suggestions) from leaking across a sign-out / sign-in cycle on a shared device. Consequence: after sign-out all cached server data is gone and every query refetches from scratch.

**Session expiry is event-driven, not polling**
`queryClient.ts` dispatches a `window` custom event (`exchange:session-expired`) whenever any React Query call returns a 401 or 403. The `AuthProvider` listens for this event and clears the user. This event-bus pattern is used because `queryClient.ts` and `auth.tsx` would form a circular import if they referenced each other directly — the window event decouples them.

**Admin "view as user" is UI-only**
Admins can toggle `effectiveRole` to `'user'` via `setViewAs` (auth.tsx:184-187, 621). The server's actual session is unchanged. This is just for checking what non-admin users see. The preference is persisted in `localStorage` under key `eex.viewAs`.

---

## 6. QUIZ BANK

**Q1.** You click the "Movies" tab. Trace what happens from the click to the first movie card appearing on screen. Name at least 3 components or hooks involved.

*Answer:* `TopNav`'s onClick calls `transitionTo('movies')` → `navTransition` sets `window.location.hash = '#/movies'` → `useRoute`'s hashchange listener fires and calls `setRoute('movies')` → `Shell` re-renders, `ActiveTab` becomes `MoviesTab` (lazy) → React's `Suspense` renders `LoadingPulse` while the JS chunk downloads → `MoviesTab` mounts and its `useQuery` hooks fire fetches to the backend → cards appear.

**Q2.** A user signs into the app on their iPad. They then sign out and their roommate signs in. Why does React Query's cache get cleared between sign-ins, and what would go wrong if it didn't?

*Answer:* `applyUser` calls `qc.clear()` before setting the new user. Without it, the roommate would see the first user's cached feedback dots, suggestion strip, and usage data until each query individually refetched — leaking private data across accounts on a shared device.

**Q3.** The app boots and immediately shows a blank white screen for about 200 ms, then the Kraken animation and content appear. Is this a bug? Where does this blank-screen window come from?

*Answer:* Not a bug — it's the intentional `if (loading) return null` in `AuthGate` while `/api/me` is in-flight. The Kraken renders *outside* `AuthGate` (it's in `Shell`, which is only created after auth resolves), so during the probe the whole screen is blank. The 200 ms is the round-trip time to `/api/me`.

**Q4.** An admin visits `https://theemeraldexchange.com/#/users`. The next day they revoke their own admin rights and reload the page. What stops them from seeing the Users tab?

*Answer:* `Shell` calls `useAuth()` which returns the server-truth `isAdmin` (derived from the session cookie via `/api/me`). The `useEffect` in Shell checks `route === 'users' && !isAdmin` and calls `navigate('home')`, bouncing them. The synchronous `blocked` check also prevents the Users tab component from rendering even for a single frame.

**Q5.** A new tab component called `StatsTab` is added to the app. The developer forgets to add it to the `TABS` record in `App.tsx`. What happens when someone navigates to `#/stats`?

*Answer:* `router.ts`'s `parseHash()` checks the hash against the `ROUTES` array. Since `'stats'` is not in `ROUTES`, it returns `DEFAULT_ROUTE` (`'home'`). The user sees the home tab. The `TABS` record in `App.tsx` would also fail to map `'stats'` to a component, but the router never lets `route` be `'stats'` in the first place.

**Q6.** React Query's `queryClient` is created once in `src/lib/queryClient.ts` and passed to `QueryClientProvider` in `main.tsx`. Why is it created *outside* the component tree rather than inside `App` or `main.tsx`'s render function?

*Answer:* If `queryClient` were created inside a component, it would be re-created on every re-render, wiping the cache and losing all in-flight queries. Creating it as a module-level singleton means there is exactly one client for the lifetime of the page, and all components share the same cache.

---

## 7. CODE-READING EXERCISE

### Guided walk: `src/App.tsx`

Open `src/App.tsx`. You are going to read it bottom-up, which matches how React mounts it.

**Step 1 — The entry point (lines 118-126)**

`App` is the root component exported to `main.tsx`. It renders one thing: `<AuthProvider>` wrapping `<AuthGate>`. Notice: `App` itself has zero logic. Its only job is to install the auth context before anything else renders. *Question: why is `AuthProvider` not in `main.tsx` alongside `QueryClientProvider`?* Answer: `AuthProvider` calls `useQueryClient()` internally (auth.tsx:15-16) — it must be a descendant of `QueryClientProvider`. Since `QueryClientProvider` lives in `main.tsx`, `AuthProvider` must live lower.

**Step 2 — The auth gate (lines 98-116)**

`AuthGate` calls `useAuth()` to read `loading` and `user`. Trace the three branches:
- `loading === true`: returns `null`. The user sees nothing.
- `user === null`: renders `<Walkthrough>` in a `<Suspense>`. Unauthenticated landing.
- `user` exists: renders `<NavTransitionProvider><Shell>`. Authenticated dashboard.

*Why is `Walkthrough` wrapped in `<Suspense fallback={null}>` instead of `<Suspense fallback={<LoadingPulse>}`?* Because `Walkthrough` contains its own Kraken atmosphere. If `LoadingPulse` showed while the chunk loaded, there would be a flash of a spinner where the Kraken should be — the `null` fallback is invisible and the Kraken appears as soon as the chunk arrives.

**Step 3 — The tab registry (lines 47-54)**

`TABS` is a plain JavaScript object mapping route names to component constructors. Find it:
```ts
const TABS: Record<Route, React.ComponentType> = {
  home: HomeTab,
  tv: TvTab,
  ...
}
```
`HomeTab` is a direct import (line 4). The others are `lazy()` imports (lines 25-45). *What is the practical difference?* `HomeTab`'s code is in the initial bundle — it renders immediately. `TvTab`, `MoviesTab`, etc. are in separate chunks that download on first visit.

**Step 4 — The shell (lines 56-89)**

`Shell` is the authenticated app frame. Read it in order:
1. `useRoute()` — reads the current tab from the URL hash.
2. `useAuth()` — reads `isAdmin` for route gating.
3. `useLimits()` — checks whether the Live/IPTV tab is enabled.
4. The `useEffect` (lines 66-69) — bounces unauthorized routes.
5. `const ActiveTab = TABS[effectiveRoute]` — looks up the component to render.
6. The JSX (lines 77-88) — always renders `<Kraken>` and the nav, then puts `<ActiveTab>` inside `<Suspense>`.

*Challenge: where would you add a new `SettingsTab` route?* You would need to: (1) add `'settings'` to the `Route` type in `router.ts` and the `ROUTES` array, (2) create `SettingsTab.tsx`, (3) add a lazy import in `App.tsx`, (4) add the entry to `TABS`, (5) add it to `TopNav`'s `TABS` array for the nav button, and (6) add any role gate in the `useEffect`.

---

