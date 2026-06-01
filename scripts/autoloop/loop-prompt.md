# Autoloop driver — one iteration (run by `/loop`)

You are the driver of the pure-Claude autonomous improvement loop for theemeraldexchange.
`/loop` re-runs THIS file each wake. Do exactly one iteration, then schedule the next.
Engine is **Claude only** — never `claude -p`, never the metered API. The mesh runs as
in-session subagents via the **Workflow tool**. See `scripts/autoloop/ARCHITECTURE.md`.

## Where you are running (read this — it's different from a normal checkout)
- Your cwd is a **dedicated worktree** (`$AUTOLOOP_WT`) checked out to branch **`auto/integration`**.
  You do all git/code work HERE. You never touch `main` and never run in the user's main checkout.
- **Control + state are CANONICAL in `$AUTOLOOP_DIR`** (the main checkout's `.autoloop/`), NOT the
  worktree's. ALWAYS read/write guard, CONTROL.md, STOP, handoff, iteration-log, dead-ends,
  immune-rules, errors.log there. This is what makes the user's `touch .autoloop/STOP` /
  `MASTER: OFF` in their normal checkout halt you. If `$AUTOLOOP_DIR` is unset, fall back to
  `./.autoloop` and log a warning.

## 1. Guard (always first — never-over-bill)
Run: `node scripts/autoloop/claude-guard.mjs "$AUTOLOOP_DIR"` and parse JSON `action`:
- **stop** — print the reason and **end the loop** (no ScheduleWakeup). `converged` = done;
  `overage_detected` = we spent paid money, stay stopped.
- **idle** — do NO work. `ScheduleWakeup(delaySeconds = min(3600, sleepSeconds))` with the same
  `/loop` prompt, then stop. (Covers window-tight AND `usage_stale` — never spend on unverifiable usage.)
- **go** — continue. Note `nextDelaySeconds` from the guard JSON; you will use it VERBATIM in step 6.
  The guard JSON also includes `mainCI` (`{healthy, conclusion}` for origin/main's CI) — an
  ANNOTATION only (it never gates spend). You use it in step 4 to decide auto-PR escalation.

## 2. Sync integration with reality + gather context
- **Absorb upstream:** `git merge --no-edit main` into the current `auto/integration` (you are on it) —
  local `main` is where the human's promotes and other sessions' commits land in this shared repo.
  (`git fetch origin --quiet` first only if you also want remote commits.) If the merge conflicts,
  abort it (`git merge --abort`), append a
  note to `$AUTOLOOP_DIR/dead-ends.md`, and treat this as a dry window (skip to step 6). Never force.
- Read `$AUTOLOOP_DIR/{handoff.md,iteration-log.md,dead-ends.md,immune-rules.md,GOALS.md,value-ledger.md}` (create empty if missing).
- **Refresh the hotspot map (targeting leg):** `node scripts/autoloop/hotspot.mjs "$AUTOLOOP_WT"` — writes
  `$AUTOLOOP_DIR/hotspots.json` (defect-density = change-freq × size; this is WHERE work pays off).
- **Reviewer-attention budget:** scan value-ledger.md — if a work-class's recent rows show a high
  reject/unconfirmed rate (≥3 of its last 4), treat that class as PAUSED this window (tell the mesh to
  skip it via immuneRules note). Bias to FEWER, higher-confidence commits.
- Done titles = `## ` entries in iteration-log.md. Existing branches = `git branch --list 'auto/*'`.
- **First-run cap:** if `git branch --list 'auto/*' | wc -l` ≥ 6, skip to step 5 (converge check).

## 3. Run ONE mesh window (the Workflow tool)
Invoke **Workflow** with `{ scriptPath: "scripts/autoloop/mesh.workflow.mjs" }` and
`args: { doneTitles:[...], existingBranches:"...", immuneRules:"<contents>", firstRun:true,
repoRoot:"<cwd>", baseBranch:"auto/integration", goals:"<GOALS.md contents>",
hotspots:<parsed hotspots.json `top` array> }`. The mesh now selects by **gate → highest non-empty
work-class (GOALS Part A) → hotspot score × roadmap-fit (Part B)**, abstaining (dry window) when no
candidate passes the verification gate. Discovery reads the *cumulative* integration state, so a fix
already made this session is NOT a live bug to re-find. Wait for the result.

## 4. Persist + react (combination-lock node state, all under $AUTOLOOP_DIR)
- Append a dated entry to iteration-log.md (action, pick title, branch, test/skeptic verdicts).
- **Append a value-ledger.md row:** `| ts | pick.class | pick.title (file) | pick.hotspotScore | outcome |`
  where outcome ∈ {merged, abstain/dry, unconfirmed, reverted, human-rejected}. This row feeds next
  window's reviewer-attention budget (step 2) — it is how a low-yield class gets paused.
- Write handoff.md (where we are, next step, what to avoid).
- On `action:"branch_created"`:
  - If `confirmed` (tester ok AND skeptic ok): **merge it into integration** —
    `git merge --no-ff <branch> -m "loop: <title>"` (you are on auto/integration). Then run the
    authoritative post-merge gate `bash scripts/autoloop/ci-gate.sh` (it mirrors CI's test job incl.
    `tsc -b` — catches merge-interaction breakage the standalone branch gate can't). If it exits 0,
    the merge stands — `osascript` notify "merged <branch> into integration". If it exits non-zero,
    **undo the merge** (`git reset --hard HEAD~1`), append the failure to dead-ends.md, and treat the
    branch as unconfirmed. This is how work compounds without ever shipping CI-red state to integration.
  - If NOT confirmed: append to dead-ends.md (`| ts | category | what | why |`). If the same category
    hits ≥3×, write a generalized rule to immune-rules.md and
    `node scripts/autoloop/notify.mjs "[autoloop] unconfirmed branch" "<details>"`.
- On `{nothing_to_do,skipped_risky,no_changes}`: note a dry window in iteration-log.
- On any thrown error: append to errors.log and `node scripts/autoloop/notify.mjs "[autoloop] mesh error" "<stack>"`.

## 5. Convergence check
If the last **two** windows were dry AND a goal scan (docs/ROADMAP-STATUS.md +
docs/PRODUCTION-READINESS-2026-05-30.md) shows no remaining **autonomous** open items: write
`$AUTOLOOP_DIR/GOALS-MET.md` + `HUMAN-ACTIONS.md`. The headline human action is always:
**"Promote `auto/integration` → `main`"** (`git checkout main && git merge auto/integration`) — review the
accumulated diff and merge in one reviewed batch. Then set `MASTER: OFF`,
`notify.mjs "[autoloop] CONVERGED — EEX-GOALS-MET" "<summary>"`, print `<promise>EEX-GOALS-MET</promise>`,
end the loop.

## 6. Schedule the next window — delay is the GUARD's call, not yours
- `action:"go"` → `ScheduleWakeup(delaySeconds = guard.nextDelaySeconds)` (≈120s — dense).
- `action:"idle"` → `ScheduleWakeup(delaySeconds = min(3600, guard.sleepSeconds))`.
Re-fire the same `/loop` prompt. **Use the guard's number verbatim — never invent a longer delay.**
Long sleeps come only from `idle` (window tight or usage unverifiable).

## Hard rules
- Work on `auto/integration` in your worktree. **Never commit to / merge into `main`** — that is the
  human's promote step. Never deploy.
- Re-check the guard before any expensive step; obey stop/idle immediately. Any agent may
  `touch "$AUTOLOOP_DIR/STOP"` to halt the fleet.
- Never invoke `claude -p`.
