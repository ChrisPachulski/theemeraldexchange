# Flag Report: §11 Availability-Badge Tombstone Design — Cross-Resolution Compatibility

> Source agent: r11-tombstone-design
> Date: 2026-05-25

## What was checked

Whether §11's tombstone design (written assuming §9 Resolution A) survives intact under every §9 resolution (A, B, C, D). §11 specifies a `removed_at TEXT NULL` column on `iptv_title_link`, migration `0003_link_tombstones.sql`, a partial index `iptv_link_active_by_tmdb`, `iptvSync.ts` soft-delete behavior, a 14-day hard-delete sweep, and the `tagIptvAvailability` filter — every claim was independently tested against each of the four §9 resolutions.

## Verdict

**NEEDS-WORK.** §11 is VALID under Resolution A and Resolution D. **§11 is silently wrong under Resolution B** — every DDL targets `iptv_title_link` which doesn't exist under B, and the gestured-at equivalent on `exchange.db.titles` is left entirely unspecified. §11 **needs a rewrite under Resolution C** — badge continuity and ranker visibility are intentionally decoupled by design, producing UX states (badge fires but title never appears in suggestions) that §11 does not acknowledge.

This flag must resolve *in parallel with* the §9 resolution decision, not after.

## Findings

### Resolution A — VALID

§11 applies as written. No DDL or prose changes required. The prior correction from synthesis finding 1.26 (rewrite rationale from "watch-history cascade" to "badge continuity"; add the missing partial index DDL `CREATE INDEX iptv_link_active_by_tmdb ON iptv_title_link(tmdb_kind, tmdb_id) WHERE removed_at IS NULL`) is the only open item.

### Resolution B — SILENTLY WRONG

Every normative DDL in §11.1 targets `iptv_title_link`, which is dropped under B. Specific broken DDL:

```sql
-- §11.1 references a table that does not exist under Resolution B:
ALTER TABLE iptv_title_link ADD COLUMN removed_at TEXT NULL;
CREATE INDEX iptv_link_active_by_tmdb
  ON iptv_title_link(tmdb_kind, tmdb_id) WHERE removed_at IS NULL;
```

The §11 opening paragraph gestures at the alternative ("orphan handling shifts to tombstones on `titles` rows with an equivalent `removed_at TEXT NULL` column") but never specifies the migration, the index, the sweep job, or the sync-code coordination.

**Hardest unspecified case**: Under B, `iptvSync.ts` detects upstream VOD removal on the 6h Xtream sync, but `iptv_ingest.py` is what actually writes `iptv_vod` rows to `titles` on its nightly cycle. Which process owns the `removed_at` write? §11 is silent. If `iptvSync.ts` owns it, that's a new cross-DB write path (Hono writing to `exchange.db`). If `iptv_ingest.py` owns it, tombstoning is delayed by up to 24h after upstream removal.

### Resolution C — NEEDS-REWRITE

The §11.1 tombstone schema targeting `iptv_title_link` is valid for the badge path. But under C, the recommender also reads from `iptv_vod`/`iptv_series` in `titles`. If a `vod` row is hard-deleted from `titles` by the nightly `iptv_ingest.py` run but its corresponding `iptv_title_link` row is only tombstoned, the badge still shows `available_on: ['iptv']` for up to 14 days on a title that the ranker no longer sees. The user sees the availability badge but the title never appears in suggestions. §11 says nothing about this case — it is the most subtle cross-resolution failure.

### Resolution D — VALID (with caveat)

D changes sync architecture (Hono post-`syncOnce()` calls a recommender ingest endpoint) but not the data model. `iptv_title_link` remains canonical. All §11.1 DDL, migration numbers, and the partial-index spec are valid. Minor caveat: §11.1's "A new partial index is required for performance" explains accumulating tombstone case; under D, if Hono calls the recommender endpoint synchronously and items are re-added in the same sync run (transient upstream outage → immediate re-add), tombstone churn could be higher per window, not lower. Index is still correct and necessary; justification sentence should note it applies regardless of sync architecture.

## Required fixes

The fix scope depends entirely on §9 resolution. The contract must conditionalize §11 once §9 lands. Specific edits:

### If §9 lands as A or D: no §11 changes required

Apply the prior synthesis finding 1.26 correction (badge-continuity rationale + missing partial index DDL). Done.

### If §9 lands as B: full §11 rewrite required

- Add `recommender/migrations/0004_titles_tombstones.sql` adding `removed_at TEXT NULL` to `titles`
- Add `CREATE INDEX titles_iptv_active_by_tmdb ON titles(tmdb_id, kind) WHERE kind LIKE 'iptv_%' AND removed_at IS NULL` — **NOTE**: SQLite partial index expressions cannot use `LIKE` predicates directly in older versions; must enumerate kinds explicitly or use a generated column. Confirm NAS SQLite version >= 3.8.9 before relying on this form.
- Specify which process owns the `removed_at` write: either `iptvSync.ts` via a new cross-DB write path, or `iptv_ingest.py` triggered synchronously by `iptvSync.ts` on sync completion
- Rewrite `tagIptvAvailability` to query `exchange.db.titles` for `kind LIKE 'iptv_%' AND tmdb_id IN (...) AND removed_at IS NULL`
- Move the 14-day hard-delete sweep ownership to `iptv_ingest.py`
- Soften §11.3's "invisible to the recommender" claim: TMDB-less items still have `titles` rows under B; they produce no badge but may affect ranker output

### If §9 lands as C: §11 extension required

Add an explicit drift-window rule:

> "During a tombstone's active window (0–14 days after `removed_at` is set on `iptv_title_link`), the availability badge may show `available_on: ['iptv']` while the title is absent from the ranker's `titles` view. This is expected. The badge represents historical availability continuity; the ranker represents current availability. Do not attempt to synchronise them — that reintroduces the drift problem from a different direction."

Also qualify the metadata reconstruction statement in §11 C7: "If the `iptv_vod`/`iptv_series` row in `titles` has already been pruned by the nightly ingest, reconstruct metadata from `movie`/`tv` rows via `tmdb_id`. If the `titles` row still exists, it may be read directly."

### Lines in §11 requiring conditional treatment

1. **Line 9** — `iptv_title_link gains removed_at TEXT NULL column (migration 0003_link_tombstones.sql)` — applies under A, C, D only
2. **Line 10** — `iptvSync.ts no longer hard-deletes link rows` — applies under A, C, D only
3. **Line 11** — `tagIptvAvailability adds AND removed_at IS NULL` — applies under A and D only (deleted under B; badge-path-only under C)
4. **Line 11 DDL** — partial index target changes under B
5. **Line 15** — metadata reconstruction path differs by resolution

## Drop-in text (not applicable for r11)

N/A — fixes are spec patches conditional on §9.
