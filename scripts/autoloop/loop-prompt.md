# Autoloop driver — one iteration (run by `/loop`)

You are the driver of the pure-Claude autonomous improvement loop for theemeraldexchange.
`/loop` re-runs THIS file each wake. Do exactly one iteration, then schedule the next.
Engine is **Claude only** — never `claude -p`, never the metered API. The mesh runs as
in-session subagents via the **Workflow tool**.

## 1. Guard (always first — never-over-bill)
Run: `node scripts/autoloop/claude-guard.mjs .autoloop` and parse the JSON `action`:
- **stop** — print the reason and **end the loop** (do NOT ScheduleWakeup). If reason is
  `converged`, you're done. If `overage_detected`, the loop spent paid money → stay stopped.
- **idle** — do NO work this iteration. `ScheduleWakeup(delaySeconds = min(3600, sleepSeconds))`
  with the same `/loop` prompt, and stop. (Window is tight; wait for reset.)
- **go** — continue below.

## 2. Gather context (cheap, read-only)
- `cat .autoloop/handoff.md` (if present), `.autoloop/iteration-log.md`, `.autoloop/dead-ends.md`,
  `.autoloop/immune-rules.md` (create empty if missing).
- Done titles: the `## ` entries in `iteration-log.md` plus `git branch --list 'auto/*'`.
- Existing branches: `git branch --list 'auto/*'`.
- **First-run cap:** if `git branch --list 'auto/*' | wc -l` ≥ 6, skip to step 5 (idle/converge check).

## 3. Run ONE mesh window (the Workflow tool)
Invoke the **Workflow** tool with `{ scriptPath: "scripts/autoloop/mesh.workflow.mjs" }` and
`args: { doneTitles: [...], existingBranches: "...", immuneRules: "<contents>", firstRun: true,
repoRoot: "<cwd>" }`. Wait for the result.

## 4. Persist + react to the result (combination-lock node state)
- Append a dated entry to `.autoloop/iteration-log.md`: the `action`, the pick title, branch,
  and the test/skeptic verdicts.
- Write `.autoloop/handoff.md`: where we are, the next step, and anything to avoid.
- On `action: "branch_created"`:
  - If `confirmed` (tester ok AND skeptic ok) → `osascript` notify "new branch <branch>".
  - If NOT confirmed → append the failure to `.autoloop/dead-ends.md` (`| ts | category | what | why |`).
    If the SAME category now appears ≥3× in dead-ends.md, write a generalized rule to
    `.autoloop/immune-rules.md`, and `node scripts/autoloop/notify.mjs "[autoloop] unconfirmed branch" "<details>"`.
- On `action` in {`nothing_to_do`,`skipped_risky`,`no_changes`}: increment a dry-window note in
  iteration-log.
- On any thrown error: append to `.autoloop/errors.log` and
  `node scripts/autoloop/notify.mjs "[autoloop] mesh error" "<stack>"` (emails).

## 5. Convergence check
If the last **two** windows were dry (no new branch) AND a quick goal scan
(docs/ROADMAP-STATUS.md + docs/PRODUCTION-READINESS-2026-05-30.md) shows no remaining
**autonomous** open items: write `.autoloop/GOALS-MET.md` + `.autoloop/HUMAN-ACTIONS.md`
(the human-only remainder), set `MASTER: OFF` in `.autoloop/CONTROL.md`,
`node scripts/autoloop/notify.mjs "[autoloop] CONVERGED — EEX-GOALS-MET" "<summary>"`, print
`<promise>EEX-GOALS-MET</promise>`, and **end the loop**.

## 6. Schedule the next window — run NEAR-CONTINUOUSLY while the window is healthy
`ScheduleWakeup` with the same `/loop` prompt. The default is **dense**, not lazy:
- **Comfortable headroom** (both 5h and 7d are ≥5 points below their ceilings): use **~120s**.
  The point of this loop is to keep working; back-to-back windows are expected and correct.
- **Approaching a ceiling** (within 5 points of either ceiling): use the guard's `sleepSeconds`
  (idle to the reset) so we never cross into overage.
The guard re-gates every wake, so a short delay is safe — it will flip to idle/stop the instant
the window tightens. Never sit on a 30–60 min gap while headroom is wide.

## Hard rules
- Branches only — **never commit to main, never deploy** (first run).
- Re-check the guard (`claude-guard.mjs`) before any expensive step; if it flips to stop/idle,
  obey immediately. Any agent may `touch .autoloop/STOP` to halt the fleet.
- Never invoke `claude -p`.
