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

## Environment Cheat-Sheet

These gotchas were re-hit across multiple sessions. Treat them as invariants:

- **`curl` is not available** in the local Bash sandbox (`command not found: curl`). Use `node`, `wget`, or a small `fetch.mjs` script for HTTP calls from the local shell. `curl` works fine over SSH on the NAS.
- **`$status` is reserved in zsh** — never assign to it (`status=0` is a read-only variable). Use a different name (`exit_code`, `rc`, etc.).
- **Guard bash-isms** — scripts may run under zsh or sh. Avoid `${var//pattern/replace}` and other bash-specific substitutions without explicit `#!/bin/bash` shebang.
- **Prod host:** `root@theemeraldexchange.local`. Appdata root: `/mnt/user/appdata/exchange-backend/`. All remote ops: `ssh root@theemeraldexchange.local "..."` or `docker` commands forwarded via SSH.
- **No `sleep`-then-curl health-check one-liners** — the sandbox blocks long-leading sleeps. Use short polls via `node` or check via SSH directly.
- **Repo may be public** — never hardcode secrets, API keys, auth tokens, IP addresses, or personal info into any committed file. Use environment variables and `.env` (gitignored).
