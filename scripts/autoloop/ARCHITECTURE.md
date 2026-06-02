# Autoloop architecture — the "going forward" design

This documents the structural decisions that keep the pure-Claude autonomous loop from
the two failure modes observed in the first live run (2026-06-01):

1. **Rediscovery churn** — the loop kept re-finding and re-fixing the *same* bug because
   its fix lived on an unmerged branch, so a fresh scan of live `main` still saw the crash.
2. **Shared-tree contention** — the loop's driver ran in the same working tree as the
   user's interactive Claude sessions; concurrent commits moved `HEAD` under it and a stray
   `git stash` hit a ref-race (the hazard CLAUDE.md forbids).

## Three layers of defense

### 1. Worktree isolation (fixes contention)
The loop NEVER runs in the shared `main` checkout. `start-loop.sh` creates a **dedicated git
worktree** (`<repo>-loopwt`) checked out to the integration branch, and launches the tmux
`claude` session there. Consequences:
- Interactive sessions on `main` and the loop on `auto/integration` never share a `HEAD` or
  index → no ref-race, no `git stash` collisions, no "HEAD moved under me".
- The mesh executor's own `isolation:'worktree'` still nests inside this — per-agent isolation
  for parallel mutating work.
- **Control/state stays canonical and shared:** the loop reads its guard/CONTROL/STOP from the
  **main repo's** `.autoloop/` (passed as `AUTOLOOP_DIR`), so `touch .autoloop/STOP` and
  `MASTER: OFF` in your normal checkout still halt the loop instantly. Code+git happen in the
  worktree; control+telemetry happen in the canonical `.autoloop/`.

### 2. Integration branch (fixes rediscovery + lets work compound)
The loop works on a long-lived `auto/integration` branch = `main` + every confirmed-but-unmerged
auto fix. Each window:
1. **Sync down:** `git merge --no-edit origin/main` into `auto/integration` so it absorbs human
   merges and other sessions' work (keeps the loop building on current reality).
2. **Discover/execute against integration** — the discovery forest reads the *cumulative fixed*
   state, so a fix already made this session is no longer a "live bug" to re-find. Rediscovery
   structurally cannot happen.
3. **On a confirmed branch:** the driver fast-forward/merges `auto/<ts>` into `auto/integration`,
   so later windows build on it (work compounds instead of stacking isolated orphan branches).
4. **`main` is still human-gated:** the loop never commits to or merges into `main`. The human
   action is a single **promote `auto/integration` → `main`** (review the integration diff, merge),
   not N separate branch merges. Convergence writes this into `HUMAN-ACTIONS.md`.

### 3. Effective immune gate (defense-in-depth)
Even with the above, `immuneRules`/`doneTitles` are injected into BOTH deciding stages (Sonnet
auditor + Opus synth), matched by symptom/root-cause not just title, with a clean dry-window exit
when only immune/done survivors remain. (Committed `ef74ac3`.) This catches any residual repeat.

## Signal ingestion (the proactivity leg — `signals.mjs`)
The first live run produced almost entirely *defensive coverage* because the discovery forest had ONE
input modality: Haiku leaves scan code SHAPE per work-class. The top class — `signal-fix` ("a REPRODUCED
failure that is RED right now") — had no feed of actual failures, so it rarely fired and the loop fell
through to `gated-test`. The loop was structurally blind to everything but code shape.

`signals.mjs` is the fix, and it is **repo-agnostic**:
- **Built-in adapters (any git repo, zero config):** CI health (reads the guard's `ci-status.json` — a red
  `main` is the highest-merit reproduced failure, and was the rediscovery-livelock root cause); git
  regression-risk (files with repeated fix/bug/revert commits, especially those lacking a sibling test);
  TODO/FIXME/BUG markers at hotspots; and an OPT-IN live-gate harvest (`SIGNAL_RUN_GATE=1` runs the gate
  and parses real test/type/lint failures).
- **Per-repo adapters (drop-in, loaded blindly):** every `<AUTOLOOP_DIR>/signals/*.mjs` exporting
  `export async function collect(ctx)` is run best-effort. An error tracker, issue tracker, or perf budget
  is a ~30-line adapter the repo adds **without touching the engine** — the engine never names a source.

The driver runs `signals.mjs` each window → `signals.json`, passes `signals` into the mesh, and each
work-class's discovery leaf is SEEDED with the real signals for its class. Result: the highest-merit class
fires on reproduced, evidence-bearing work; coverage is the floor (signal queue dry), not the default.
A reproduced `signal-fix` is exempt from the hotspot-targeting rail — the red itself is the justification.

## Single-loop invariant
Every loop spends the same account 5h/7d window, and two mutating loops on one repo re-introduce
contention. `start-loop.sh` refuses to start if another autoloop worktree/session is already live
(a lockfile in the canonical `.autoloop/`). One loop at a time, enforced — not just documented.

## What the human does
- Review `auto/integration` (or individual `auto/*` branches) at leisure.
- When happy: `git checkout main && git merge auto/integration && git push`.
- Stop anytime: `MASTER: OFF`, `touch .autoloop/STOP`, or `stop-loop.sh` (all in the normal checkout).

## Why not auto-merge to `main`?
The user deliberately made `main` a human gate (a one-way door). The integration branch preserves
that gate while removing the loop's bottleneck: the loop gets a place to accumulate verified work
so it never stalls or re-churns, and the human promotes that work to `main` in reviewed batches.
