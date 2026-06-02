# Autoloop SELF-IMPROVEMENT driver — one iteration (run by `/loop`)

You are the driver of the autoloop improving ITS OWN engine. `/loop` re-runs THIS file each wake.
Do exactly one window, then schedule the next. Engine is **Claude only** — never `claude -p`, never
codex (company seat), never the metered API. The mesh runs as in-session subagents via the **Workflow tool**.

## Where you are
- cwd = the dedicated worktree (`$AUTOLOOP_WT` = `…-loopself`) on branch **`auto/self-improve`**. All git/code
  work happens HERE. NEVER touch `main`, `auto/integration`, or product code.
- Control/state are CANONICAL in `$AUTOLOOP_DIR` (= `<repo>/.autoloop-self`). Read/write cap, guard,
  CONTROL.md, STOP, iteration-log, value-ledger, RESEARCH-BACKLOG.md THERE.
- **Scope = `scripts/autoloop/**` ONLY.** Never edit product code, `.github`, Dockerfile, secrets, or the
  live EEX `.autoloop/`. Mirror every confirmed change to `~/claude-sync/tools/autoloop/`.

## 1. CAP FIRST (controlled-gauging — before anything else)
Run: `node scripts/autoloop/self-cap.mjs "$AUTOLOOP_DIR" "$AUTOLOOP_WT"` and parse JSON `action`:
- **stop** — the batch cap is reached. self-cap has ALREADY written CHECKPOINT-REVIEW.md, tripped STOP,
  and flipped MASTER: OFF. Print the review path and **END the loop** (no ScheduleWakeup). Do not work.
- **go** — note `remaining.improvements`/`remaining.windows`; continue.

## 2. Guard (never-over-bill)
Run: `node scripts/autoloop/claude-guard.mjs "$AUTOLOOP_DIR"`; obey `stop`/`idle`/`go` exactly as the EEX
loop does (stop→end; idle→ScheduleWakeup(min(3600,sleepSeconds)) & end; go→note nextDelaySeconds).

## 3. Gather context (engine-scoped)
- Read `$AUTOLOOP_DIR/{GOALS.md,RESEARCH-BACKLOG.md,iteration-log.md,value-ledger.md,dead-ends.md}` (create empty if missing).
- Refresh engine targeting:
  `HOTSPOT_SRC_DIRS=scripts/autoloop AUTOLOOP_DIR="$AUTOLOOP_DIR" node scripts/autoloop/hotspot.mjs "$AUTOLOOP_WT"`
  `SIGNAL_SRC_DIRS=scripts/autoloop AUTOLOOP_DIR="$AUTOLOOP_DIR" node scripts/autoloop/signals.mjs "$AUTOLOOP_WT"`
- **Discovery is LITERATURE-GROUNDED.** Prefer the next un-done item from RESEARCH-BACKLOG.md (highest tier
  first: T0 safety → T1 verification → T2 proactivity → T3 escalation → T4 capability). Skip items whose
  iteration-log shows them done. If the backlog is exhausted OR you need fresh grounding, invoke the
  **literature-consultation** skill (production-first) to extend the backlog, then pick. Never invent an
  engine change from prior alone.
- Done titles = `## ` entries in iteration-log.md. Existing branches = `git branch --list 'auto/self-*'`.

## 4. Run ONE mesh window (Workflow tool)
Invoke **Workflow** with `{ scriptPath: "scripts/autoloop/mesh.workflow.mjs" }` and `args`:
`{ doneTitles:[…], existingBranches:"…", immuneRules:"<immune-rules if any>", repoRoot:"<cwd>",
  baseBranch:"auto/self-improve", scope:"scripts/autoloop/", gateCmd:"node scripts/autoloop/engine-gate.mjs scripts/autoloop",
  goals:"<GOALS.md contents + RESEARCH-BACKLOG.md contents — so discovery+synth rank toward the
  literature-grounded backlog items, highest tier first>", hotspots:<hotspots.json top>, signals:<signals.json signals> }`.
The executor forks from `origin/auto/self-improve` (it is PUSHED) and edits ONLY `scripts/autoloop/**`.
The tester verifies with `engine-gate.mjs` (NOT ci-gate — the engine is .mjs/.sh/.json). Wait for the result.

## 5. Persist + land (all under $AUTOLOOP_DIR)
- Append a dated entry to iteration-log.md (action, pick title, class, branch, test/skeptic verdicts).
- Append a value-ledger.md row `| ts | class | title (file) | hotspotScore | outcome |`.
- On `branch_created` + `confirmed` (tester ok AND skeptic ok — skeptic must assert VALIDITY, not just a
  green gate; a plausible-but-wrong engine change is NOT confirmed):
  - **DETERMINISTIC SCOPE CHECK (do this BEFORE merge):** `git fetch origin --quiet && git diff --name-only
    origin/auto/self-improve...<branch>` — if ANY path is NOT under `scripts/autoloop/`, REJECT the branch
    (append to dead-ends.md as `out-of-scope`, do NOT merge). The mesh is scope-constrained but this is the
    non-negotiable backstop: a self-improvement run may only change the engine. Only if every path is in
    scope do you proceed.
  - `git merge --no-ff <branch> -m "loop(self): <title>"` into auto/self-improve.
  - **Authoritative re-gate:** `node scripts/autoloop/engine-gate.mjs scripts/autoloop`. Exit 0 → merge
    stands; push (`git push origin auto/self-improve`); mirror changed files to `~/claude-sync/tools/autoloop/`;
    `notify.mjs`. Non-zero → `git reset --hard HEAD~1`, append dead-ends.md, treat as unconfirmed (never
    brick — last-good engine stays).
- NOT confirmed / dry → note it; append dead-ends.md if a branch failed.

## 6. Schedule next
- `go` → `ScheduleWakeup(delaySeconds = guard.nextDelaySeconds)` re-firing THIS prompt.
- Step 1 will re-check the cap next wake; when improvements or windows hit the cap, self-cap halts the batch.

## Hard rules
- Scope = `scripts/autoloop/**` only. Never main/integration/product/.github/secrets/deploy. Never `claude -p`/codex.
- Cap (step 1) and guard (step 2) run FIRST every window; obey stop immediately. `touch $AUTOLOOP_DIR/STOP` halts.
- Never trust an agent's green: the driver re-runs engine-gate.mjs on the merged result before it stands.
