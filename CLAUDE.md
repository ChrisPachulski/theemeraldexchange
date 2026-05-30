# theemeraldexchange — Claude Behavioral Contract

## Standing Authorization

This is the user's personal homelab. Standing approval is granted for ALL of the following without re-asking each session:

- SSH into `root@theemeraldexchange.local`
- Remote `docker` commands on the NAS (start, stop, restart, pull, compose up/down, exec)
- Database migrations and schema changes on the NAS
- Deploys (rsync, scp, docker build + push + roll)
- `git push` to any branch of this repo

The permissions allow-list enforces these at the harness level. Do not present a confirmation prompt before routine SSH, docker, or push operations.

Exception: genuinely destructive bulk ops (mass branch deletion, wiping a prod data volume, dropping a production database) still warrant a single one-line confirm before executing.

## Execute, Don't Offer Menus

Never write "Option A / Option B / Option C — which would you like me to drive first?" on this project.

When facing a choice:
1. Investigate the codebase or runtime to determine the correct action.
2. Execute it.

Only ask when a decision is genuinely irreversible AND context provides zero signal on intent. If you catch yourself about to write an option menu — stop, investigate, decide, execute.

The user has rejected option menus explicitly and repeatedly. This is a hard rule, not a preference.

## No Diagnostics-Only Punts

When something is broken, take a real swing at the root cause. Do not ship a response that consists only of observability additions or a plan to investigate later. Diagnose and fix in the same pass.

## Test Each Change End-to-End

Exit code 0 is not done. After every step in stateful or deploy work, verify the intended downstream behavior:
- Service responds correctly (not just "process started")
- Data is where it should be
- The UI/API endpoint returns the expected result

Do not move to the next step until the current one is confirmed working.

## Workflow Runaway Prevention

Long multi-agent workflows on this repo have repeatedly run away (2.5h+ with no
progress). The root causes and the hard rules that prevent them:

1. **Shared working tree → ref-race livelock.** Multiple Claude sessions share
   ONE working tree on `m3-media-core`. A workflow's sequential fix agents and a
   concurrent session both commit, orphaning each other's commits; an agent that
   commits-then-reverifies can loop forever re-committing the same change. RULE:
   any workflow whose agents MUTATE files MUST use `isolation: 'worktree'` so each
   agent gets its own checkout. Never run parallel/long mutating agents against
   the shared tree.

2. **Bound every workflow.** No unbounded `while`/loop-until-dry without a hard
   ceiling. Cap fan-out (≤8 mutating agents per phase), cap total agents, and put
   a wall-clock or budget guard on any accumulation loop. Prefer one bounded
   phase per turn over a single mega-workflow that owns the whole job.

3. **Never trust an agent's "green" self-report.** Agents have shipped commits
   that failed typecheck/pytest while claiming success. The orchestrator (or the
   main loop) MUST re-run the real build/test at the end, from scratch, before
   declaring done.

4. **Watch, don't babysit.** When a background workflow/command is running, go
   event-driven (a commit monitor + the completion notification). Do NOT poll in
   a tight loop or `ScheduleWakeup` short intervals — that itself is a runaway. If
   a workflow shows no commit/no journal `result` for ~10 min, STOP it and finish
   the remaining scope by hand rather than waiting longer.

5. **Kill switch.** If you catch a livelock (same commit message landing 2-3×,
   or an agent transcript active but HEAD not advancing), `TaskStop` the workflow
   immediately, verify with `git fsck --no-reflogs | grep 'dangling commit'` that
   no unique work was lost, and take over directly.

6. **Commit small and often in a contended tree.** Only committed state survives
   a concurrent `git add -A`. Commit each fix immediately, staging ONLY your own
   paths (`git add -- <path>`), never `git add -A`/`.`.

## Environment Cheat-Sheet

These gotchas were re-hit across multiple sessions. Treat them as invariants:

- **`curl` is not available** in the local Bash sandbox (`command not found: curl`). Use `node`, `wget`, or a small `fetch.mjs` script for HTTP calls from the local shell. `curl` works fine over SSH on the NAS.
- **`$status` is reserved in zsh** — never assign to it (`status=0` is a read-only variable). Use a different name (`exit_code`, `rc`, etc.).
- **Guard bash-isms** — scripts may run under zsh or sh. Avoid `${var//pattern/replace}` and other bash-specific substitutions without explicit `#!/bin/bash` shebang.
- **Prod host:** `root@theemeraldexchange.local`. Appdata root: `/mnt/user/appdata/exchange-backend/`. All remote ops: `ssh root@theemeraldexchange.local "..."` or `docker` commands forwarded via SSH.
- **No `sleep`-then-curl health-check one-liners** — the sandbox blocks long-leading sleeps. Use short polls via `node` or check via SSH directly.
- **Repo may be public** — never hardcode secrets, API keys, auth tokens, IP addresses, or personal info into any committed file. Use environment variables and `.env` (gitignored).
