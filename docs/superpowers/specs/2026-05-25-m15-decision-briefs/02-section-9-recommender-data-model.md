# §9 Decision Brief: Recommender Data Model (canonical title identity)

> Status: [USER'S CALL]. Decision-research only — picking is the user's job.
> Source agents: a9-question, a9-impl-cost, a9-oneway-door, a9-failure-modes, a9-precedents
> Date: 2026-05-25

## TL;DR

- Four resolutions: **A** (keep `iptv_title_link` join, drop inert per-source `iptv_vod`/`iptv_series` rows), **B** (drop join, keep per-source rows), **C** (keep both, document the line, integration test the sync), **D** (sync-event-driven `available_on` JSON column on canonical TMDB row).
- Dominant trade-off is **identity model**: A/D treat a title as one TMDB-keyed thing with multiple access paths; B treats each source as a first-class peer that may share a TMDB id; C straddles.
- Pivotal question: **when the same movie exists in IPTV and on Plex, is it one thing the user has access to, or two different ways to watch the same thing?**
- Implementation cost: C = **11.5h**, A = **12h**, B = **17h**, D = **31h**.
- Evidence most strongly supports **Resolution A**: 6 of 8 surveyed industry systems use it (JustWatch, Reelgood, TMDB, Trakt, Letterboxd, Radarr). Stremio (the closest architectural analog) makes A explicit in its addon protocol. Resolution B's only precedent is Jellyfin, where it is treated as technical debt by Jellyfin's own developers (the `MergeVersions` plugin is a community A-retrofit). Resolution C is used by zero surveyed systems as a permanent architecture.

## The pivotal question

From `a9-question`: **"When the same movie exists in IPTV and on Plex, is it one thing the user has access to, or two different ways to watch the same thing?"**

This is not about tables — it is about what a `title` *is*. Resolution A treats a title as a TMDB concept with sources as metadata hanging off it; the sources are properties. Resolution B treats an IPTV VOD and a Plex item as first-class peers that happen to share a TMDB id; the TMDB identity is a join key, not the thing itself. C papers over the question without answering. D is a timing variant of A.

Every downstream consequence in §9.3 (the M3 media-core data-model shape, orphan handling, Python-vs-Rust port trajectory) flows from this identity model, not from the table structure per se. The recommender currently treats `iptv_vod`/`iptv_series` rows as inert — the only live consumer of badge availability is `tagIptvAvailability`, which reads `iptv_title_link` exclusively. The join path is not just load-bearing, it is the only wired path.

## Options at a glance

| Option | Impl cost | One-way door | Worst failure mode | Industry precedent |
|---|---|---|---|---|
| **A** Keep join, drop per-source rows | **12h** (2 mig + 3 code + 2 test + 4 rollback + 1 ops) | Low — A→D ~2-3d; A→C ~1d; A→B ~2-3d | A1: TMDB-side delete leaves dangling link row (no FK; §11 tombstones don't cover this — HIGH severity but LOW likelihood) | JustWatch, Reelgood, TMDB watch/providers, Trakt, Letterboxd, Radarr `MovieMetadata` split, Stremio (6/8 surveyed) |
| **B** Drop join, keep per-source rows | **17h** (3 + 5 + 4 + 3 + 2) | HIGH — once M3 Rust media-core writes `kind='local_*'` rows directly into `exchange.db.titles`, cross-language schema coupling is locked | B1: Structural double-recommendation. Every TMDB+IPTV match generates two rows sharing `tmdb_id`, two embeddings derived from divergent metadata. Steady state, not transient (CRITICAL, HIGH likelihood). Also: WAL not configured on `exchange.db` → reader stalls during ingest | Jellyfin (per-path rows; treated as tech debt by its own devs; `MergeVersions` plugin is the community A-retrofit) |
| **C** Keep both, document the line | **11.5h** (0.5 + 2 + 4 + 2 + 3) | Reversibility cheapest short-term, most expensive long-term. M3 adds a third pattern by precedent | C1/C3: Drift is the default steady state, not an exception. 24h+ stale-data windows are guaranteed by schedule mismatch. C5: M3 inherits ambiguous dual-path model with no locked precedent — third pattern probable by M4 | None as a permanent architecture. Plex comes closest but with clean layer separation; C as proposed shares data surfaces |
| **D** Sync-event-driven `available_on` JSON | **31h** (4 + 8 + 6 + 8 + 5) | Lowest for M3+ (JSON array token per new source). HIGH for §11 redesign cost | D1: Event delivery failure → `available_on` permanently stale with no fallback periodic reconcile (HIGH severity, MEDIUM likelihood). At-most-once delivery semantics unspecified | TMDB's own data model (canonical row + watch/providers sub-endpoint). Stremio also implicit-D. |

## Decision tree

From `a9-question`, tightened:

```
Q1: Is a title ONE thing (TMDB-keyed) that may be reachable via multiple sources?
│
├── YES (title = TMDB concept, sources are metadata)
│   ├── Q2: Does the ranker ever need to score IPTV-only orphans (no TMDB id)?
│   │   ├── NO  →  Resolution A
│   │   └── YES →  Resolution D (with available_on column for ranker query)
│   └── Q3: Will IPTV availability ever be per-user (multi-user IPTV subs)?
│       └── YES → A becomes painful; consider C with explicit per-source user_id scope
│
└── NO (each source produces a peer row; TMDB is a unifier, not an identity)
    ├── Q4: Is M3 media-core genuinely similar to IPTV in data shape?
    │   ├── YES →  Resolution B
    │   └── NO  →  Resolution C (split canonical authority by domain)
    └── Q2: Does the ranker need IPTV-only orphan scoring?
        └── YES →  Resolution B is required (A and D foreclose cold-start)
```

Cold-start capability (surfacing IPTV-only titles with no `tmdb_id` in recommendations) is the single binary capability gate: A and D foreclose it structurally; B and C preserve it. Per `a9-failure-modes`, the §11.3 `vod_without_tmdb` log line catches the symptom but no alert threshold is defined.

## Detailed comparison

### Resolution A — Keep join, drop per-source rows

- **Implementation cost** — 12h total (`a9-impl-cost`). Migration is a near-direct template of `0005_iptv_kinds.sql`. Code changes: delete `iptv_ingest.py`, remove `/api/iptv/export/recommender` route, remove cron entry. `tagIptvAvailability` and `iptvSync.ts` require no changes — already on the join path.
- **One-way door** — Lowest. Per `a9-oneway-door`: A→C is ~1 day, A→D is ~2-3 days, A→B is ~2-3 days. New downstream sources (M3 media, M6 music) follow the same join pattern: `media_title_link`, `music_title_link`. `exchange.db.titles` stays clean as TMDB items only.
- **Worst failure mode** — A1: TMDB-side hard-delete leaves a dangling `iptv_title_link` row because there is no FK; `tagIptvAvailability` still matches it and surfaces a badge for a non-existent title. §11 tombstones protect against IPTV-upstream disappearance, not TMDB-upstream churn. HIGH severity, LOW likelihood (current M1 nightly ingest prunes stale rather than hard-deleting). A4: forecloses adding IPTV-specific ranker features without re-adding per-source rows.
- **Precedent** — JustWatch (one canonical title + offers array, 6h sync cadence = identical to this project). Reelgood (one canonical Reelgood ID + service availability list). TMDB itself (`/movie/{id}/watch/providers` returns availability on the canonical row). Radarr's V4+ `MovieMetadata`/`Movie` split is structurally identical to `exchange.db.titles` + `iptv_title_link`. Stremio's protocol is explicit: addons using IMDB IDs (`idPrefixes: ["tt"]`) contribute streams to canonical Cinemeta entries rather than creating per-source title rows.

### Resolution B — Drop join, keep per-source rows

- **Implementation cost** — 17h. Drop `iptv_title_link`, add `removed_at` column on recommender DB titles, rewrite `tagIptvAvailability` to read `exchange.db` for `kind LIKE 'iptv_%'` (crosses Hono's DB-handle boundary), rewrite §11 entirely (see r11 flag report).
- **One-way door** — HIGH (`a9-oneway-door`). M3 Rust media-core must write `kind='local_movie'`/`kind='local_episode'` rows directly into `exchange.db.titles`. Cross-language schema coupling from day one of M3. Decoupling later requires migration + API redesign while two runtimes are live.
- **Worst failure mode** — B1 (CRITICAL, HIGH likelihood): every title in both TMDB and IPTV generates two rows sharing `tmdb_id`. The recommender returns the same item twice with two embeddings from divergent metadata sources. This is the permanent steady-state under B, not a transient race. With 14,957 VOD titles in iptv.db, the majority of well-known titles have TMDB matches → the double-recommendation fires for a large fraction of the catalog on every render. B4: WAL mode unconfirmed on `exchange.db` — under B, `iptvSync.ts` (Node.js) writes while `featurize.py` reads, causing 10s read stalls per sync cycle without WAL.
- **Precedent** — Jellyfin (1 of 8). Jellyfin's own developers treat per-source rows as technical debt: `MergeVersions` plugin retrofits A. LiveTV Channel Merge issue #632 is unresolved. Jellyfin's model fits because it is a *file manager*, not a recommender/aggregator — a structural mismatch with this project.

### Resolution C — Keep both, document the line

- **Implementation cost** — 11.5h (cheapest direct), but ongoing operational cost is highest of any option. Two ingest schedules on diverging cadences permanently. Integration test must tolerate 24h drift by design. CI gate complexity.
- **One-way door** — Cheapest short-term, most expensive long-term (`a9-oneway-door`). Reversibility advantage disappears as soon as M3 wires in. Compounding maintenance surface: every additional source must be wired into both paths with two tombstone systems kept in sync.
- **Worst failure mode** — C1/C3: drift between badge surface and ranker surface is the steady state, not the exception. 6h IPTV sync vs nightly recommender ingest = 24h windows where badge shows "available on IPTV" but ranker doesn't know it (or vice versa). C5: M3 author building media-core faces two existing models with no locked precedent — third pattern probable by M4. C6: TMDB delete under C produces *both* an orphan link row *and* an orphan per-source row.
- **Precedent** — None as a permanent architecture. Plex has two layers (per-path local objects + Discover/Universal federated) but with clean separation, not a shared-surface dual write. Plex users and developers have long found this complex.

### Resolution D — Sync-event-driven `available_on` JSON

- **Implementation cost** — 31h (highest). New `available_on` JSON column on `titles`, new event consumer in Python, durable outbox or at-least-once delivery mechanism (not specified in synthesis note). Rewrite `tagIptvAvailability` to read JSON, rewrite §11 to use a grace-period column instead of a partial-index on link table.
- **One-way door** — Lowest for M3+ extensibility (new source = new string token in JSON array). HIGHEST for §11 redesign cost — adopting D before M1.5 closes requires revising §11 before any implementation begins.
- **Worst failure mode** — D1 (HIGH severity, MEDIUM likelihood): single transient HTTP failure between Hono and recommender → recommender's IPTV availability view permanently stale with no fallback. Under A, nightly ingest would eventually reconcile. D has no periodic fallback specified. D2: at-most-once delivery semantics. D3: recommender becomes a soft runtime dependency for Hono's correctness — new under D, not true under A or B.
- **Precedent** — TMDB's own watch/providers data model (canonical row + availability sub-endpoint). Stremio implicit-D via streams attached to Cinemeta canonical entries.

## Cross-option interactions

- **§9 ↔ §11 (tombstone design)**: Resolution choice cascades into §11 directly. Under A: §11 applies as written. Under B: §11 is silently wrong — every DDL targets `iptv_title_link` which doesn't exist. §11 must be entirely retargeted to `exchange.db.titles` with a new partial index using `kind LIKE 'iptv_%'` (which SQLite partial index expressions don't support directly; must enumerate kinds). Under C: §11 must be implemented twice (link table tombstones AND titles-side tombstones) with a documented drift-window rule. Under D: §11's tombstone concept survives but partial-index design must be replaced with a grace-period column. See `r11-tombstone-design` flag report for the full breakdown.
- **§9 ↔ §15 (telemetry)**: No direct coupling.
- **§9 ↔ §4 (auth)**: No direct coupling.
- **§9 ↔ Cold-start capability**: Binary gate. A and D foreclose cold-start for IPTV-only titles (no TMDB id). B and C preserve it. If "surface IPTV-only orphans in recommendations" is a planned product capability, A/D are wrong starting points regardless of other considerations.

## Disagreements among source agents

`a9-impl-cost` ranks **A** as lowest direct cost and lowest ongoing risk because it eliminates the inert code path entirely. `a9-oneway-door` agrees A is lowest constraining but notes the cold-start foreclosure as a HIGH one-way door. `a9-failure-modes` flags the TMDB-side delete orphan (A1) as the only HIGH-severity failure under A, with the explicit caveat that LIKELIHOOD is LOW — current M1 nightly ingest prunes rather than hard-deletes. `a9-precedents` is the most decisive: 6/8 surveyed systems converge on A.

No agent disputes that B's double-recommendation (B1) is the worst single failure across all four resolutions in steady state.

## Advisory recommendation

The evidence most strongly supports **Resolution A**. The industry convergence is overwhelming: every streaming guide service (JustWatch, Reelgood, TMDB) and every recommender-adjacent cross-source unifier (Trakt, Letterboxd, Stremio, Radarr) uses A. The only counter-example (Jellyfin) is a file manager, not an aggregator, and Jellyfin's own developers treat B as tech debt. The shipped code already supports A: `tagIptvAvailability` reads only `iptv_title_link`; `iptv_vod`/`iptv_series` rows are inert. Removing the parallel per-source path is a cleanup, not a capability reduction — *unless* cold-start for TMDB-less IPTV titles is a planned product feature, in which case B or C is required and the choice is forced.

This is non-binding.

## What I'd need to know before locking

- What's the orphan rate from a real sync run? §11.3 logs `vod_without_tmdb` counts but no alert threshold is defined. If 5% of the IPTV catalog is TMDB-unmatched and users want to watch those titles, A foreclosures matter. If <1%, A is safe.
- Is IPTV availability ever per-user (different IPTV credentials per household member)? If yes, A requires adding `user_id` to `iptv_title_link` — a non-trivial schema evolution that pushes toward B or C.
- What is the M3 media-core data shape? If 80%+ of local library files map to a TMDB id, A extends naturally (`media_title_link`). If half are unidentified rips/home videos, the answer for M3 may not be the answer for IPTV — pushes toward C with explicit per-domain scope.
- Does the recommender ever need to rank IPTV-only orphans (no TMDB match)? If yes, A and D foreclose it structurally. If no, the optionality argument for B collapses.
- Is WAL mode configured on `exchange.db`? Under B/C/D, concurrent writers between Node.js Hono and Python `featurize.py` require WAL. Without it: 10s read stalls per sync cycle. Under A this race does not exist.
