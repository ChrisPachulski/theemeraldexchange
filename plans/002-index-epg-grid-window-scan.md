# Plan 002: Index the EPG grid's time-window scan so the guide stops full-scanning epg_programs on the event loop

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 4132b9a..HEAD -- server/services/iptvEpgQuery.ts server/migrations/iptv/ server/services/iptvSync.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `4132b9a`, 2026-06-12

## Why this matters

The IPTV guide endpoint (`GET /api/iptv/epg/grid`) runs this query on every
request (`server/services/iptvEpgQuery.ts:131-136`):

```sql
SELECT channel_id, start_utc, stop_utc, title, description
FROM epg_programs
WHERE start_utc < ? AND stop_utc > ?
ORDER BY channel_id, start_utc ASC
```

The only index on `epg_programs` is
`epg_window(channel_id, start_utc, stop_utc)` (`0001_init.sql:80`), whose
leading column is `channel_id` — useless for a query with no channel
predicate. SQLite therefore full-scans the table. The table holds roughly
`[now − 24h, now + 7d]` of programmes for ~12-14k channels (the sync prunes
`stop_utc < now − 24h` and stores a 7-day forward horizon —
`iptvSync.ts:210-213`), i.e. on the order of 10⁵–10⁶ rows. The default grid
window is 4 hours (`server/routes/iptv.ts:340-341`), matching only a
fraction of those rows, and better-sqlite3 is synchronous — the scan blocks
the same Node event loop that is concurrently proxying live video
segments. Each guide open/refetch (the SPA refetches every 30 minutes) pays
it again.

Because the table is ~85-90% *future* rows (24h back vs 7d forward),
`start_utc < :to` is the selective predicate for any near-now window. An
index leading on `start_utc` lets SQLite range-scan only rows starting
before the window's end and check `stop_utc` from the same index entry.

## Current state

- Schema (`server/migrations/iptv/0001_init.sql:72-80`):
  ```sql
  CREATE TABLE IF NOT EXISTS epg_programs (
    channel_id  TEXT NOT NULL,
    start_utc   TEXT NOT NULL,
    stop_utc    TEXT NOT NULL,
    title       TEXT,
    description TEXT,
    PRIMARY KEY (channel_id, start_utc)
  );
  CREATE INDEX IF NOT EXISTS epg_window ON epg_programs(channel_id, start_utc, stop_utc);
  ```
- Retention (`server/services/iptvSync.ts:209-213`):
  ```ts
  // EPG window — drop stale, store 7-day forward.
  const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString()
  db.raw.prepare(`DELETE FROM epg_programs WHERE stop_utc < ?`).run(cutoff)
  const horizon = new Date(Date.now() + 7 * 24 * 3600_000).toISOString()
  ```
- The grid query is the ONLY query against `epg_programs` without a
  `channel_id` predicate. The other two are already well-served:
  `epgNow` filters `WHERE channel_id = ? AND stop_utc > ?`
  (`iptvEpgQuery.ts:54-60`) and `epgChannelWindow` filters
  `WHERE channel_id = ? AND start_utc < ? AND stop_utc > ?`
  (`iptvEpgQuery.ts:85-90`) — both use the PK/`epg_window` index. Do not
  touch them.
- Migrations are discovered from the directory: `server/services/iptvDb.ts:8`
  resolves `MIGRATIONS_DIR` to `server/migrations/iptv` and hands it to the
  shared migrator (`server/services/migrator.ts`), which applies `NNNN_*.sql`
  files in version order and records
  `schema_migrations(version, applied_at, checksum)` with a sha256 of the
  LF-normalized file. **Consequence: never edit an already-applied migration
  file — a checksum mismatch fails boot. New index = new migration file.**
  Existing files: `0001_init.sql` … `0006_epg_resolved_id.sql`, so the next
  version is `0007`.
- Existing test suite for the query module:
  `server/services/iptvEpgQuery.test.ts` (7 tests) — shows how a test DB is
  constructed for these services; model new assertions on it.

## Commands you will need

| Purpose   | Command                                        | Expected on success |
|-----------|------------------------------------------------|---------------------|
| Install   | `npm ci`                                       | exit 0              |
| Typecheck | `npx tsc -b`                                   | exit 0              |
| Tests     | `npm test -- iptvEpgQuery`                     | all pass            |
| Full tests| `npm test`                                     | all pass            |
| Lint      | `npm run lint`                                 | exit 0              |

## Scope

**In scope** (the only files you should modify/create):
- `server/migrations/iptv/0007_epg_grid_window_index.sql` (create)
- `server/services/iptvEpgQuery.test.ts` (extend)
- `server/services/iptvEpgQuery.ts` — comment only, if you add one noting
  the index the grid query relies on. The SQL itself should not need to
  change.

**Out of scope** (do NOT touch, even though they look related):
- `server/migrations/iptv/0001_init.sql` … `0006_epg_resolved_id.sql` —
  applied migrations are checksummed; editing one bricks every existing DB
  at boot.
- `server/services/iptvSync.ts` — retention policy stays as-is.
- `server/routes/iptv.ts` — no response-caching layer in this plan (see
  Maintenance notes).
- `epgNow` / `epgChannelWindow` queries — already indexed correctly.

## Git workflow

- Branch: `advisor/002-epg-grid-index`
- Conventional-commit style (e.g. `perf(iptv): index epg_programs(start_utc, stop_utc) for the grid window scan`)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the full scan with EXPLAIN QUERY PLAN

Write a throwaway check (run with `npx tsx`, do not commit it) that opens
an in-memory better-sqlite3 DB, applies the existing migrations via the
same path the app uses (see how `server/services/iptvEpgQuery.test.ts`
builds its test DB), then runs:

```sql
EXPLAIN QUERY PLAN
SELECT channel_id, start_utc, stop_utc, title, description
FROM epg_programs WHERE start_utc < ? AND stop_utc > ?
ORDER BY channel_id, start_utc ASC
```

**Verify**: the plan line says `SCAN epg_programs` (a full table scan —
possibly `SCAN ... USING INDEX epg_window` purely as a covering scan; the
point is it is a SCAN, not a SEARCH). Record the output.

### Step 2: Add migration 0007

Create `server/migrations/iptv/0007_epg_grid_window_index.sql`:

```sql
-- The guide grid (/api/iptv/epg/grid) filters epg_programs by time window
-- only (start_utc < :to AND stop_utc > :from) with no channel predicate, so
-- the channel_id-led epg_window index can't serve it and every guide open
-- full-scanned the table on the synchronous better-sqlite3 driver.
-- Retention keeps [now-24h .. now+7d] (iptvSync), so the table is mostly
-- future rows and start_utc < :to is the selective predicate; leading on
-- start_utc turns the scan into a bounded range SEARCH, with stop_utc
-- present so the second predicate is checked in the index.
CREATE INDEX IF NOT EXISTS epg_grid_window ON epg_programs(start_utc, stop_utc);
```

Match the comment style of `0004_playlist_tokens.sql` (explanatory header
comments are the convention in this migration chain).

**Verify**: `npm test -- migrator` → migrator suite still green (it
validates the chain's shape).

### Step 3: Prove the index is picked up

Re-run the Step-1 check against a DB that now includes 0007.

**Verify**: the EXPLAIN QUERY PLAN line for the grid query now reads
`SEARCH epg_programs USING INDEX epg_grid_window (start_utc<?)`. The
`epgNow`/`epgChannelWindow` queries still use their original index/PK
(re-run their EXPLAIN to confirm no plan regressed).

### Step 4: Add regression tests

Extend `server/services/iptvEpgQuery.test.ts` with:

1. an EXPLAIN QUERY PLAN assertion: the grid query's plan contains
   `USING INDEX epg_grid_window` (this pins the index against accidental
   removal or a query rewrite that breaks eligibility);
2. a correctness assertion with rows on both sides of each boundary: a
   programme ending before `from`, one starting after `to`, one fully
   inside, one straddling `from`, one straddling `to` — the grid returns
   exactly the overlapping three. (If an equivalent overlap test already
   exists among the 7, extend it rather than duplicating.)

**Verify**: `npm test -- iptvEpgQuery` → all pass, including the new ones.

### Step 5: Full gate

```bash
npm test && npx tsc -b && npm run lint
```

**Verify**: all green.

## Test plan

Covered in Step 4: one query-plan pin + one boundary-overlap correctness
test in `server/services/iptvEpgQuery.test.ts`, modeled on the existing
test-DB setup in that file. The migration itself is exercised by every test
that builds the iptv DB (the chain auto-applies).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `server/migrations/iptv/0007_epg_grid_window_index.sql` exists and creates `epg_grid_window` on `epg_programs(start_utc, stop_utc)`
- [ ] EXPLAIN QUERY PLAN for the grid query shows `SEARCH ... USING INDEX epg_grid_window` (asserted by a committed test)
- [ ] `npm test` exits 0
- [ ] `npx tsc -b` exits 0 and `npm run lint` exits 0
- [ ] `git diff --stat` shows changes only to files in scope
- [ ] No edits to migrations 0001–0006 (`git diff --name-only -- server/migrations/iptv/000[1-6]*` is empty)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts.
- A migration numbered 0007 already exists in `server/migrations/iptv/`.
- After Step 3 the planner still chooses a SCAN — do not start rewriting
  the query or adding ANALYZE calls; report the EXPLAIN output.
- The migrator rejects the new file for a reason other than your SQL syntax
  (e.g. checksum machinery complaining about existing rows) — that signals
  a migrator behavior this plan didn't anticipate.

## Maintenance notes

- The index assumes the retention shape stays "short past, long future"
  (`now−24h … now+7d`). If catchup/archive features ever extend EPG
  retention weeks into the past, `stop_utc` becomes the selective column
  and this index choice should be revisited.
- Deliberately NOT done here: a short-TTL response cache for the gzipped
  grid body (`server/routes/iptv.ts:350-366` re-stringifies and re-gzips
  ~28MB → ~2MB per request). The route's `from` param defaults to
  `new Date().toISOString()` so naive keying never hits; a cache needs
  window bucketing. Worth a follow-up plan if guide opens are still slow
  after this index lands — measure first.
- Reviewer should scrutinize: that the new test pins the query plan (not
  just correctness), and that no applied migration file was touched.
