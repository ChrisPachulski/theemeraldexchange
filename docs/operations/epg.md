# EPG (Electronic Programme Guide) — operations

How the IPTV guide data is fetched, stored, and served.

## Sources

1. **Provider XMLTV** (`/epg.xml` on the Xtream host) — the primary, working
   source. Carries schedules for ~6k feed channels.
2. **Third-party (iptv-org via epgshare01)** — *optional supplement*, layered on
   top by channel-name match. See `iptvEpgExternal.ts`. **Built but not yet
   delivering on prod** — see "External supplement: status & known bugs" below.

## Pipeline

```
syncOnce (node-cron, every 6h)
  ├─ fetchAndStreamEpg      → provider /epg.xml (SAX stream + regex sniffer)
  ├─ resolveEpgChannels     → exact tvg-id, then unambiguous name match
  └─ ingestAllExternalEpg   → epgshare01 supplement (best-effort, see below)
```

## Coverage (verified 2026-05-30, live prod DB)

- Catalog: **50,592** channels.
- Resolved with a real schedule (`epg_resolved_id` set **and** has programmes):
  **14,309**. (All of these come from the provider feed: exact tvg-id ~806, plus
  unambiguous name match against the feed's `<channel>` aliases.)
- `epg_programs` rows: **521,630**. Distinct EPG channels in the feed: **6,024**.
- The rest of the catalog has **no schedule in any source** (24/7 loops, PPV,
  XXX performer streams, F1 data/tracker channels, regional duplicates). These
  are shown as **tunable rows** in the guide (hybrid scoping — see below), not
  hidden.

> Honest ceiling: automated third-party name-matching adds **at most ~3k** more
> channels, **not** "all 50k". Competitors that appear to show EPG for everything
> rely on manual per-channel tvg-id mapping or much heavier name normalization,
> not a single magic feed. Be blunt about this when scoping "full EPG" asks.

## Guide UI scoping (hybrid)

- **Default view (no category, no search):** only channels that actually have a
  schedule overlapping the window — the guide proper, kept light. (`hasEpgOnly`
  in `epgGrid`, driven by `hasEpg: !scoped` in `EpgGuide.tsx`.)
- **Category or search active:** **all** matching channels, even schedule-less
  ones, as tunable rows — so a category is never empty. This was the fix for
  "categories show nothing." Requires an SPA hard-refresh to pick up.
- The Live tab defaults to the **guide** view (not cards).

## External supplement: status & known bugs (2026-05-30)

The third-party supplement (`ingestAllExternalEpg` → epgshare01
`epg_ripper_ALL_SOURCES1.xml.gz`, ~196 MB) is wired into the repo's `iptvSync.ts`
but is **NOT effectively deployed** and its programme-storage has **never been
verified on prod**. Two real bugs gate it:

1. **gz stream crash on Node 24 (deployed image only).** The *deployed*
   `iptvEpg.ts` crashes streaming the gzipped feed:
   `TypeError: dest.destroy is not a function` (Node 24's `pipe()` teardown calls
   `.destroy()` on sax's legacy stream, which has no such method). The repo's
   *current* `iptvEpg.ts` streams the full 196 MB feed cleanly (~192 s, ok) — so
   this is fixed in the repo and ships on the next backend image redeploy. There
   is no current prod risk because the *deployed* `iptvSync.ts` predates the
   ext-ingest wiring and never calls it; the provider `/epg.xml` path is
   unaffected.

2. **Partial-crash poison + non-idempotency.** `resolveAgainstExternal` selects
   only channels whose `epg_resolved_id` is empty, sets it, *then* streams
   programmes. If the stream dies after the resolve commit but before storing
   programmes, those channels are left "resolved-but-empty" and a re-run **skips
   them** (they're no longer unresolved), so they never get programmes. This bit
   us on 2026-05-30: a crashed run left 3,172 resolved-but-empty rows (resolved
   jumped 14,293→17,481 with no new programmes); cleaned by nulling any
   `epg_resolved_id` that has zero programmes. Suggested fix: only set
   `epg_resolved_id` for channels we actually stored ≥1 programme for.

**Before relying on the supplement:** measure its real programme yield on a
**copy** of the prod DB (recipe in the EPG handoff memory note), confirm the
lift is worth it, then redeploy the backend image — and **restart cloudflared
afterward** (a backend recreate breaks the tunnel's shared netns; see
`cloudflare-tunnel.md`).

## Cap / windowing

- The `/epg/grid` endpoint returns the full has-EPG set (virtualized
  client-side); row cap 60,000. Response is gzipped when large.
- EPG is stored 7 days forward; stale rows (`stop_utc < now-24h`) are pruned each
  sync.

## Running a one-off ingest / probe under the hardened container

The backend container is `read_only` with `cap_drop: ALL` and a tmpfs `/tmp`.
The only writable path is the `/app/data` bind mount (host:
`/mnt/user/appdata/exchange-backend/data/`). To run a one-off:

- Put the script in `/app/data` (scp straight to the host path). It's under
  `/app/package.json` (`type: module`) so `tsx` treats it as ESM (top-level
  await works).
- Run off the backend image with `--entrypoint node` **and**
  `--env-file /mnt/user/appdata/exchange-backend/.env` — `server/env.ts` requires
  `STREAM_TOKEN_SECRET` et al **unconditionally** (`NODE_ENV=development` does
  **not** bypass it).
- For the ingest, pass the real `iptvDb()` singleton (it has `.stmts.upsertEpg`;
  a bare `{ raw }` object does not).
- DB read-only probes: `docker exec -w /app exchange-backend node /app/data/<probe>.cjs`
  with `require('better-sqlite3')('/app/data/iptv.db', { readonly: true })`.
