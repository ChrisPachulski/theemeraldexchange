# Play-in-Plex Overlay — Design

**Date**: 2026-05-20
**Status**: approved
**Scope**: Add a centered play-icon overlay to in-library cards so a household member can jump straight to that title's page in Plex (play one tap away) instead of going through the existing detail panel.

## Why

Today, clicking an in-library search-result card opens the local detail panel. From there a household member sees Upgrade / Remove actions but no path back to Plex — they have to memorize that the top-nav "Watch" button drops them at the Plex root and then navigate to the title themselves. For a tool that gets used nightly, that's a friction the dashboard should erase.

## Surfaces affected

1. **Search-result grid** in `TvTab` and `MoviesTab` (via `MediaCard`).
2. **Detail panel** that opens when a search-result card is clicked — when `inLibrary`, gain a primary "Play in Plex →" button alongside the existing Upgrade / Remove buttons.
3. **NOT** the recommendation strip (`TrendingRow`) — that surface excludes library items by design (the entire hygiene dimension from the iter-1-through-75 improvement loop).

## Click behavior

- Click the play icon on a card → opens the title's Plex web page in a new tab.
- Plex web URL pattern (NAS-local):
  `http://theemeraldexchange.local:32400/web/index.html#!/server/{PLEX_SERVER_ID}/details?key=%2Flibrary%2Fmetadata%2F{ratingKey}`
- `target="_blank" rel="noopener"`. `stopPropagation` on the click so the card's existing onClick (detail panel) does not also fire.
- If the ratingKey lookup hasn't returned yet (first card click of the session, cold cache), the icon shows a brief inline spinner and resolves within ~500ms.
- The detail panel's "Play in Plex →" button uses the same URL builder.

## Server: `/api/plex/library-links`

A new route that resolves every Plex library item's `tmdbId → ratingKey` mapping.

**Endpoint**: `GET /api/plex/library-links` → 200
```json
{
  "movie": { "27205": "12345", "37799": "12346", ... },
  "tv":    { "95396": "23456", "1396":  "23457",  ... }
}
```

**Implementation**:
- Auth-gated through the existing `requireAuth` middleware.
- Queries the Plex server (`env.plexServerUrl` + `X-Plex-Token` header from the session) for `/library/sections` to discover Movie + Show section keys.
- For each, fetches `/library/sections/{key}/all?includeGuids=1` and parses each item's `Guid[]` for entries with `id` starting with `tmdb://`. Maps the numeric tmdb id to the item's `ratingKey`.
- 5-minute TTL cache (matches the suggestions route's library-cache TTL). Cache is in-process, per-server (not per-user).
- In-flight coalescing: simultaneous requests share a single Plex round-trip.
- If `env.plexServerId` is unset, the resolver still returns the map but the client falls back to opening the Plex root URL (logged once at startup so it's visible).
- Error shape: structured `{ error: 'plex_unreachable' | 'no_plex_token' | 'plex_returned_non_xml' }` with appropriate HTTP status.

**Latency budget**: cold scan ~200–500ms on a 1000-item library (Plex's `/all` is fast and returns once). Cached path is <1ms.

## Client: `useLibraryLinks()` hook

```ts
// src/lib/hooks/usePlexLinks.ts
export function usePlexLinks(): {
  linkFor: (kind: 'movie' | 'tv', tmdbId: number) => string | null
  isLoading: boolean
}
```

- React Query, `staleTime: 5 * 60_000`, `refetchOnMount: false` (the server-side cache already handles freshness).
- `linkFor` builds the deep-link URL given the resolved ratingKey and `PLEX_SERVER_ID` (read once from `import.meta.env.VITE_PLEX_SERVER_ID` — or, if we want to avoid a build-time env, exposed via a small `/api/plex/server-id` endpoint cached forever). **Pick the second path** so production deploys don't need a Vite rebuild.
- Returns `null` when: the link isn't resolved yet, no server id, or the tmdbId isn't in the map.

## UI: MediaCard play overlay

`MediaCard` gains an optional prop:
```ts
playUrl?: string | null
```

When `inLibrary && playUrl`, the overlay renders as a child of `.media-card__poster`:

```jsx
<a
  className="media-card__play"
  href={playUrl}
  target="_blank"
  rel="noopener"
  aria-label={`Play ${title} in Plex`}
  onClick={(e) => e.stopPropagation()}
>
  <span className="media-card__play-icon" aria-hidden="true" />
</a>
```

**Visual contract** (in `MediaCard.css`):
- Absolutely positioned, centered over the poster art.
- 56px circle, 1.5px emerald border (`--emerald`), translucent dark fill (`rgba(20, 24, 28, 0.55)`), centered SVG/CSS triangle.
- Resting state: `opacity: 0.7`. Hover/focus: `opacity: 1` + slight scale (1.06). Same `--dur-fast` + `--ease` tokens as the existing card hover lift.
- Poster gains a hover overlay: `background: linear-gradient(...rgba(0,0,0,0.4)...)` to keep the play icon legible against bright posters. Resting state: transparent.
- Touch target: 56px is comfortable; min-width/min-height ensures a ≥44px tap area on mobile per WCAG.

The existing `media-card__badge` ("In library") stays exactly where it is — the play icon is the action affordance; the badge is the state indicator. They coexist.

## UI: Detail panel button

The detail panel that opens when an in-library card is clicked (in `MoviesTab.tsx` and `TvTab.tsx`) gains:

```jsx
{inLibrary && playUrl && (
  <a className="detail-action detail-action--primary"
     href={playUrl} target="_blank" rel="noopener">
    Play in Plex →
  </a>
)}
```

Positioned in the action row alongside the existing Upgrade / Remove buttons. Becomes the primary action when present.

## Edge cases

1. `PLEX_SERVER_ID` not set → fall back to `PLEX_URL` (the Plex root) instead of the deep link. Server logs the gap at startup.
2. tmdbId not in Plex's GUIDs (rare; Plex sometimes hasn't matched a library item yet) → fall back to Plex search: `…/web/index.html#!/search?query={encodeURIComponent(title)}`.
3. Concurrent first-load on multiple tabs → in-flight coalescing on the server.
4. Plex server unreachable → the play icon does not render; existing card behavior unchanged. No user-facing error toast (we don't want every card to scream when Plex is down; the absence of the icon is the signal).
5. Session has no `plexAuthToken` → endpoint returns 409 `no_plex_token`. Client treats as "no links available." Existing behavior preserved.

## Tests

**Server (`server/routes/plex-links.test.ts` — new)**:
- Resolver parses `tmdb://` GUIDs from a mocked Plex `/library/sections/{key}/all` response.
- Returns empty map when sections are missing (Plex returns 200 but no Movie/Show sections).
- 5-min TTL: second request inside window hits cache; verified by `vi.useFakeTimers`.
- In-flight coalescing: two concurrent requests result in one upstream fetch.
- `no_plex_token` 409 when session has no token.
- `plex_unreachable` 502 when the upstream fetch throws.

**Client (`src/components/search/MediaCard.test.tsx` — new or expand existing)**:
- `inLibrary && playUrl` → play icon renders with the expected href.
- `inLibrary && !playUrl` → play icon does NOT render.
- `!inLibrary` → no play icon regardless of playUrl.
- Clicking the play icon does not also fire the card's onClick handler.

**Integration**: TvTab + MoviesTab render the MediaCard with `playUrl` derived from `usePlexLinks().linkFor(...)`. Add one test per tab.

## What's NOT in scope (deferred)

- True autoplay (Plex web doesn't support it reliably).
- `app.plex.tv` remote deep links (requires the PMS to be advertising publicly via `plex.tv`).
- Continue-watching / resume from position (Plex's title page handles this automatically when you land there).
- Background pre-warm of the resolver cache (cold lookup is ~500ms, acceptable).

## File-level summary

```
docs/superpowers/specs/
  2026-05-20-play-in-plex-overlay-design.md  (this file)
server/routes/
  plex-links.ts                              (new — resolver)
  plex-links.test.ts                         (new)
src/lib/hooks/
  usePlexLinks.ts                            (new)
src/components/search/
  MediaCard.tsx                              (modify — add playUrl + overlay)
  MediaCard.css                              (modify — overlay styles)
  MediaCard.test.tsx                         (new or modify)
src/components/tabs/
  MoviesTab.tsx                              (modify — wire usePlexLinks, pass playUrl, add detail button)
  TvTab.tsx                                  (modify — same)
server/index.ts                              (modify — register plex-links route)
```

## Acceptance

- A household member searching for a movie they own sees the play icon centered on the poster; clicking it opens that movie's Plex page in a new tab.
- The detail panel for an in-library title has a "Play in Plex →" primary action.
- Clicking elsewhere on the card still opens the detail panel.
- Tests pass; build clean; no regression in the existing 192-test suite.
