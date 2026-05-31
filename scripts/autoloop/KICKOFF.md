# Autoloop KICKOFF — run this to launch the loop (safe for a fresh/compacted session)

You are a fresh Claude Code session asked to **kick off the autonomous improvement loop**.
Everything is already built and committed. Follow these steps **in order**. Do not
re-architect anything. If a check fails, stop and report — do not improvise.

## What this is (1 paragraph of context)
A pure-Claude, in-session autonomous mesh that improves theemeraldexchange while the user
is away. Engine = **Claude subagents via the Workflow tool**, kept alive by **`/loop` in
tmux**. It **never uses `claude -p`** and **never deploys / never touches `main`** — it only
opens reviewable `auto/*` branches. It spends the interactive Max 5h/7d window, so a guard
(`claude-guard.mjs`) hard-stops on any paid-overage rise and idles when the window is tight.
Full design: `~/.claude/plans/how-can-i-set-piped-aurora.md`. Memory: `project-autoloop-codex-mesh`.

## Step 0 — sanity (read-only)
```sh
cd /Users/cujo253/Documents/theemeraldexchange
git log --oneline -3                      # expect P1 (claude-guard) + P2/P3 (mesh) present
ls scripts/autoloop/{claude-guard,mesh.workflow,control,node-state,notify}.mjs scripts/autoloop/loop-prompt.md
```

## Step 1 — confirm the usage window actually reset (the whole reason to wait)
```sh
node -e 'const c=require(require("os").homedir()+"/.claude/.usage-cache.json");console.log("5h="+c.five_hour_pct+"% 7d="+c.seven_day_pct+"% extra_usage_credits="+c.extra_usage_used_credits)'
```
- Proceed only if **7d is comfortably below `SEVEN_DAY_CEILING` (90)** and 5h below 85.
  If 7d is still high, the loop will just idle — wait for the reset and re-check.
- Note the `extra_usage_used_credits` value; it must **not rise** once running.

## Step 2 — set the notify recipient (so errors/convergence email you)
No address is hardcoded. Pick one:
```sh
# simplest: a local, gitignored pin
printf 'AUTOLOOP_NOTIFY_TO=pachun95@gmail.com\n' > .autoloop/notify.env
node scripts/autoloop/notify.mjs "[autoloop] kickoff channel test" "If you got this, email works."
```
Confirm the test email arrives. (Falls back to `git config user.email` if unset.)

## Step 3 — arm
Edit `.autoloop/CONTROL.md`: set `MASTER: ON`. (Optionally, for a zero-risk wall, the user
can disable "extra usage" billing in Anthropic settings so the window just *blocks*.)

## Step 4 — launch in tmux
```sh
bash scripts/autoloop/start-loop.sh        # refuses unless MASTER: ON; records the overage baseline
```
This starts a **separate** Claude session in tmux (`eex-autoloop`) running `/loop` against
`scripts/autoloop/loop-prompt.md`. The kickoff session does NOT need to stay open.

## Step 5 — WATCH the first iteration (mandatory — the mesh has never run live)
```sh
tmux attach -t eex-autoloop                # detach with Ctrl-b then d
```
Confirm, in order:
1. The guard returns **go** (not idle/stop).
2. The Workflow runs a real **mesh** — parallel Haiku discovery → Sonnet audit → Opus synth
   → worktree executor → tester+skeptic (visible via the workflow progress / `/workflows`).
3. It produces an `auto/*` branch (`git branch --list 'auto/*'`) and writes
   `.autoloop/iteration-log.md` + `.autoloop/handoff.md`.
4. **`extra_usage_used_credits` is unchanged** (re-run the Step 1 one-liner). If it rose, the
   guard should have stopped — verify the loop halted; investigate before continuing.
If anything misbehaves: `bash scripts/autoloop/stop-loop.sh` and report.

## Step 6 — let it run / stop it
- It self-paces (ScheduleWakeup), idling when the window tightens. Live status:
  `cat .autoloop/STATUS.json`. Branches it proposes: `git branch -a | grep auto/`.
- **Review `auto/*` branches before merging** — the loop never merges to main itself.
- Stop anytime: `bash scripts/autoloop/stop-loop.sh` · or `MASTER: OFF` · or `touch .autoloop/STOP`.

## Hard invariants (do not violate)
- Never `claude -p`. Never commit to `main`. Never deploy. Branches only, cap 6 first run.
- The guard is authority on spend — if it says stop/idle, obey. Any agent may `touch .autoloop/STOP`.
- This is a first live run: prefer observing it through at least one full window before walking away.
