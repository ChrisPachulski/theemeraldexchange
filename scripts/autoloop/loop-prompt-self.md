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
- **Merit gate — decide whether to re-ground on the literature THIS window. Run:**
  `node scripts/autoloop/merit-state.mjs "$AUTOLOOP_DIR"` and parse the JSON.
  - **`consult: false`** (open impactful backlog items remain) — DO NOT invoke literature-consultation;
    it is expensive and re-grounding is unnecessary while real work is queued. Steer this window to
    **`topOpen`** (the highest-tier un-done backlog item, ID + its description from RESEARCH-BACKLOG.md).
    Do NOT invent low-level work (ad-hoc lint cleanup, coverage padding) while an impactful item is open —
    that funnel-to-trivia is exactly the failure mode this gate exists to stop. (A REPRODUCED engine
    signal-fix from signals.mjs still outranks backlog grooming — if discovery surfaces a red/broken
    engine script, fix that first.)
  - **`consult: true`** (backlog empty, or all impactful items done — the loop has run out of real work
    and would otherwise drop to busywork) — THIS is the trigger: invoke the **literature-consultation**
    skill via the **Skill tool**, scoped to the engine-improvement topic (production agentic-SWE loops:
    task selection, self-mod safety, verification, escalation), to refill `RESEARCH-BACKLOG.md` with fresh
    high-value targets. Then pick the new `topOpen`. If consultation surfaces nothing genuinely impactful,
    the engine is CONVERGED → abstain/halt (a clean dry window) rather than padding with trivia.
  - Lit-consult fires on DEGRADATION (impactful work exhausted), never on a fixed every-batch cadence.
  - When you land an item, cite its backlog ID with a `— DONE`/`CONFIRMED` marker in iteration-log.md so
    merit-state retires it (a bare mention does NOT count — the gate requires the explicit marker).
- **Scope is a PREFERENCE, not a wall.** Favor `scripts/autoloop/**`, but reasonable, low-risk, clearly-
  related adjacent work is allowed (being proactive beyond a strict path is good). The ONLY hard rule is:
  never touch the infra set (package.json, lockfiles, .github, Dockerfile, compose, tsconfig, vitest.config,
  .env, deploy) — those are human/IR-8.
- Done titles = `## ` entries in iteration-log.md. Existing branches = `git branch --list 'auto/self-*'`.

## 4. Run ONE mesh window (Workflow tool)
Invoke **Workflow** with `{ scriptPath: "scripts/autoloop/mesh.workflow.mjs" }` and `args`:
`{ doneTitles:[…], existingBranches:"…", immuneRules:"<immune-rules if any>", repoRoot:"<cwd>",
  baseBranch:"auto/self-improve", scope:"scripts/autoloop/", gateCmd:"node scripts/autoloop/engine-gate.mjs scripts/autoloop",
  primaryObjective:"<merit-state.topOpen ID + its FULL description pasted verbatim from RESEARCH-BACKLOG.md>",
  goals:"<GOALS.md contents + RESEARCH-BACKLOG.md contents for ranking>",
  hotspots:<hotspots.json top>, signals:<signals.json signals> }`.
- **`primaryObjective` is the DETERMINISTIC steer (not advisory prose).** When set, the mesh enters
  OBJECTIVE MODE: discoverable classes collapse to {signal-fix, objective}, and an in-script gate rejects
  any pick that is not 'objective' or 'signal-fix' (→ `action:'off_objective'`, a dry window) BEFORE the
  executor runs. So the mesh either implements the assigned item, fixes a reproduced red that preempts it,
  or abstains — it CANNOT return invented trivia (the "#1" failure mode). Always pass it (from
  merit-state.topOpen) on a normal `consult:false` window; omit it only on a `consult:true` window
  (backlog exhausted) where you've just refilled via literature-consultation but not yet chosen the new top.
The executor forks from `origin/auto/self-improve` (it is PUSHED) and PREFERS `scripts/autoloop/**` (adjacent
related work allowed; infra never). The tester verifies with `engine-gate.mjs` (the engine is .mjs/.sh/.json);
if the change touched a non-engine file, also run any test that covers it. Wait for the result.

## 5. Persist + land (all under $AUTOLOOP_DIR)
- Append a dated entry to iteration-log.md (action, pick title, class, branch, test/skeptic verdicts).
- Append a value-ledger.md row `| ts | class | title (file) | hotspotScore | outcome |`.
- On `branch_created` + `confirmed` (tester ok AND skeptic ok — skeptic must assert VALIDITY, not just a
  green gate; a plausible-but-wrong engine change is NOT confirmed):
  - **DETERMINISTIC INFRA CHECK (do this BEFORE merge):** `git fetch origin --quiet && git diff --name-only
    origin/auto/self-improve...<branch>` — if ANY path matches the infra set (`package.json`, `*lock*`,
    `.github/`, `Dockerfile`, `compose*`, `tsconfig*`, `vitest.config*`, `.env`, `deploy`), REJECT the branch
    (append dead-ends.md as `infra-touch`, do NOT merge). Non-engine but reasonable files are fine — this
    backstop blocks only human-owned infra (the first fire's package.json dep bumps), not proactive adjacent work.
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
