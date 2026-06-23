# Sonarr/Radarr Advanced Options — Design & API Contract

**Date:** 2026-06-22
**Status:** Approved (orchestrated build)
**Spans:** `theemeraldexchange` (web: backend proxy + React UI) and `theemeraldexchange-apple` (SwiftUI: EmeraldKit + screens). This file is the **single source of truth**; the Apple repo reads it from this absolute path.

## Goal
Surface Sonarr/Radarr power-user actions behind an **Advanced** button on the series/movie detail views, in **both** the web app and the Apple app. All new actions are **admin-only**. The web backend (`server/routes/{sonarr,radarr}.ts`) is the shared API for both clients; every action is implemented **once** on the backend and consumed by two thin clients.

## Decisions (locked)
1. **Access:** Admin-only. The Advanced button + every new action renders only for admins. Non-admin behavior is unchanged. Server enforces `requireAdmin` on every new mutating handler.
2. **TV "filters":** This is Sonarr's **interactive search** — the backend returns the real release list; the client filters it (All / Season Pack / Not Season Pack / English / custom regex) and the admin picks a release to grab.
3. **Cap on interactive grab:** Show the GB cap, flag over-cap releases, but allow an admin to override (`allowOverCap`). Every grab still routes through the existing grab-event recorder + reservation ledger.

## Architecture
- Follow the existing convention: intercept specific `/api/v3/...` subpaths inside the route handlers (admin-gated, field-allowlisted). No new transport convention — matches both the web `arrClient` and the Apple `EmeraldRequestBuilder` enum.
- New mutating handlers: `requireAdmin` + existing per-session rate limiter.
- `PUT` edit handlers fetch the full upstream object, merge **only** allowlisted fields, then PUT the full object back. Never blind-passthrough a client body.
- `command` handler accepts only an **allowlisted set of command names**.

---

## API Contract (new backend routes)

All paths are under the existing proxies. All require admin. Errors: `403` non-admin, `400` bad/again-disallowed input, `424` over-cap-without-override, `502` upstream failure. Responses are JSON.

### Sonarr (`/api/sonarr/...`)

| # | Method & path | Request body / query | Response | Upstream |
|---|---|---|---|---|
| S1 | `POST /api/v3/command` | `{ name, seriesId?, episodeIds?, files? }` | `{ id, name, status }` | `POST /command` |
| S2 | `GET /api/v3/release` | `?seriesId=&seasonNumber=` | `[Release]` (see below) | `GET /release?seriesId=&seasonNumber=` |
| S3 | `POST /api/v3/release?seriesId=&seasonNumber=` | body `{ guid, indexerId, allowOverCap? }` | `{ status, title, sizeGb }` | `POST /release` |
| S4 | `GET /api/v3/rename` | `?seriesId=` | `[{ episodeFileId, seasonNumber, existingPath, newPath }]` | `GET /rename?seriesId=` |
| S5 | `PUT /api/v3/episode/monitor` | `{ episodeIds:[int], monitored:bool }` | `{ ok, updated:int }` | `PUT /episode/monitor` |
| S6 | `GET /api/v3/history/series` | `?seriesId=` | `[HistoryRecord]` (see below) | `GET /history/series?seriesId=` |
| S7 | `PUT /api/v3/series/:id` | `{ monitored?, qualityProfileId?, rootFolderPath? }` (allowlist) | updated `Series` | fetch series → merge → `PUT /series/:id` |

**Allowlisted Sonarr command names (S1):** `RefreshSeries` (refresh & scan), `SeriesSearch` (search monitored), `EpisodeSearch` (per-episode search; needs `episodeIds`), `RenameFiles` (apply rename; needs `seriesId` + `files`=episodeFileIds). Any other name → `400`.

### Radarr (`/api/radarr/...`)

| # | Method & path | Request body / query | Response | Upstream |
|---|---|---|---|---|
| R1 | `POST /api/v3/command` | `{ name, movieIds?, files? }` | `{ id, name, status }` | `POST /command` |
| R2 | `GET /api/v3/release` | `?movieId=` | `[Release]` | `GET /release?movieId=` |
| R3 | `POST /api/v3/release?movieId=` | body `{ guid, indexerId, allowOverCap? }` | `{ status, title, sizeGb }` | `POST /release` |
| R4 | `GET /api/v3/rename` | `?movieId=` | `[{ movieFileId, existingPath, newPath }]` | `GET /rename?movieId=` |
| R5 | `GET /api/v3/history/movie` | `?movieId=` | `[HistoryRecord]` | `GET /history/movie?movieId=` |
| R6 | `PUT /api/v3/movie/:id` | `{ monitored?, qualityProfileId?, rootFolderPath? }` (allowlist) | updated `Movie` | fetch movie → merge → `PUT /movie/:id` |

**Allowlisted Radarr command names (R1):** `RefreshMovie` (refresh & scan; needs `movieIds`), `MoviesSearch` (search monitored; needs `movieIds`), `RenameMovie` (apply rename; needs `movieIds` + `files`=movieFileIds). Any other name → `400`.

**No episode/monitor for Radarr — movies have no episodes. "Manage episodes" is TV-only.**

**Scope param on grab (S3/R3) — CONTRACT-CHANGE 2026-06-23:** the grab POST carries the scope as a **query param** (`?seriesId=&seasonNumber=` for Sonarr, `?movieId=` for Radarr); the body stays `{ guid, indexerId, allowOverCap? }`. The backend needs the scope to compute the cap (TV episode count / movie size) and to log the grab event against the right item.

**History ordering (S6/R5):** the backend returns history **newest-first**. Clients render as-received and carry no sort logic.

### Shared response shapes

**Release** (interactive search; backend computes `overCap`):
```
{
  guid, indexerId, title, size,                // size in bytes
  sizeGb,                                       // size/1e9, rounded 2dp (backend-added convenience)
  seeders?, protocol,                           // "usenet" | "torrent"
  indexer, ageHours?,
  quality, qualityWeight,                       // quality name + numeric weight for sorting
  languages,                                    // [string], e.g. ["English"]
  fullSeason?, seasonNumber?,                   // Sonarr only
  rejected, rejections,                         // bool + [string]
  overCap                                       // bool: size > cap (TV: maxTvBytesPerEpisode×epCount; Movie: maxMovieBytes)
}
```

**HistoryRecord:** `{ date, eventType, sourceTitle, quality, seasonNumber?, episodeId? }`. `eventType` ∈ `grabbed | downloadFolderImported | downloadFailed | episodeFileDeleted | movieFileDeleted | downloadIgnored | renamed`.

---

## Client UI requirements (both web + Apple)

**Detail view** (`DetailModal` web; `ArrSeriesDetailScreen`/`ArrMovieDetailScreen` Apple): add an **Advanced** button (admin-only) opening an actions surface (web: a section/panel; Apple: a sheet/menu). Actions:

1. **Refresh & scan** — fire command, toast "Refreshing…".
2. **Search monitored** — fire command, toast "Searching monitored…". Fire-and-forget (Sonarr/Radarr's own grab).
3. **Interactive search** — opens a **release browser**: list from S2/R2, sortable by quality weight then size; filter chips **All / Season Pack / Not Season Pack / English** + a **custom regex** field over title; each row shows quality, size (with over-cap badge), seeders, indexer, rejections; **Grab** button → S3/R3 (if `overCap`, require an explicit "grab anyway" confirm that sends `allowOverCap:true`).
4. **Preview rename** — fetch S4/R4, show existing→new path diff list; **Apply** → command RenameFiles/RenameMovie with the file ids. Empty list → "Nothing to rename."
5. **Manage episodes (TV only)** — per-episode monitor toggles (PUT S5 batched) + per-episode search (S1 EpisodeSearch). Reuse the existing episode list.
6. **History** — fetch S6/R6, render newest-first with event-type icon, source title, date.
7. **Monitoring toggle** — whole series/movie monitored on/off via S7/R6.
8. **Edit** — quality profile picker + root folder picker + monitored toggle, save via S7/R6. Reuse the pickers already loaded for Add.

**States:** every async surface (release browser, history, rename) needs explicit loading / empty / error states. Destructive or override actions need a confirm. tvOS: correct focus order; no focus traps.

## Testing requirements
- **Backend** (`server/routes/{sonarr,radarr}.test.ts`): per handler — admin gate (403 for non-admin), command-name allowlist (400 on disallowed), PUT field allowlist (ignores non-allowlisted fields), interactive-grab cap + `allowOverCap` override path + grab-event logged, upstream-error mapping. Assert real behavior, not just status codes.
- **Web client** (`src/lib/api/{sonarr,radarr}.test.ts`): request wiring (method/path/query/body/credentials/abort) + error mapping for each new method.
- **Apple** (`Tests/EmeraldKitTests/`): `EmeraldRequestBuilderTests` path/query/method for each new case; `LibraryStoreTests` for each new store method (success + failure + reload); `ModelWireContractTests` for `Release`/`HistoryRecord` decoding; extend `MockServer.swift` for the new endpoints.
- **Test audit (orchestrator-run, separate wave):** review new **and existing** *arr tests to confirm they assert behavior (state changes, body contents, side effects), not merely shape/HTTP status.

## UI-exemplary pass (after functional + tested)
Research current *arr-management + action-menu/empty-state UX standards, then polish both clients: release-browser readability and sort/filter affordances, consistent destructive/override confirms, loading skeletons over spinners where it helps, history legibility, and tvOS focus order. Keep both clients visually consistent with their existing design language.

## Out of scope
Library-wide bulk operations, blocklist management, indexer/download-client config, calendar, and non-admin exposure of any of the above.
