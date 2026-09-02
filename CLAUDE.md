# theemeraldexchange — Claude Behavioral Contract

## Standing Authorization

Personal homelab; pre-approved every session, no re-ask: SSH into `root@theemeraldexchange.local`; remote `docker` commands on the NAS (start/stop/restart/pull/compose up-down/exec); DB migrations/schema changes on the NAS; deploys (rsync, scp, docker build+push+roll); `git push` to any branch. The allow-list enforces this at the harness level — do not prompt for routine SSH/docker/push. Exception: destructive bulk ops (mass branch deletion, wiping a prod volume/DB) still get one one-line confirm.

### Identity & access — ask first (not covered above)

Standing authorization covers operating the infrastructure, not minting access to it. Each needs one explicit confirmation naming the person/label, scope (uses, expiry), and why: issuing an invite code (`issueInvite`, `POST /api/admin/invites`, SPA panel — a bearer credential); creating/promoting/restoring a member or granting admin (`members`/`ADMIN_SUBS`); registering a passkey/webauthn credential or logging in as anyone but the operator; standing up VPN/proxy egress meant to spoof origin network/IP/location.

Read-only audits (listing invites/members, reading `server.db`, checking `used_count`/`revoked_at`, verifying a link from the box itself) are always allowed. Revoking needs no ask; granting does. "Verifying a link works" never justifies minting a real invite/member on prod — use a disposable local instance or inspect the code path instead.

## Execute, Don't Offer Menus

Never present "Option A / B / C — which first?" Investigate the codebase or runtime, decide, execute. Ask only when a decision is genuinely irreversible AND context gives zero signal on intent. Hard rule, not a preference.

## No Diagnostics-Only Punts

When something is broken, diagnose and fix the root cause in the same pass — don't ship observability-only additions or a plan to investigate later.

## Test Each Change End-to-End

Exit code 0 is not done. After every step in stateful/deploy work, verify the actual downstream behavior (service responds correctly, data lands where expected, UI/API returns the right result) before moving on.

## Multi-Agent Workflow Rules

1. Sessions share ONE working tree on `m3-media-core`. Mutating-agent workflows MUST use `isolation: 'worktree'`; never run parallel/long mutating agents against the shared tree.
2. Bound every workflow: no unbounded loop-until-dry. Cap fan-out (≤8 mutating agents/phase), cap total agents, wall-clock/budget-guard any accumulation loop. One bounded phase per turn beats a mega-workflow.
3. Never trust an agent's "green" self-report — re-run the real build/test from scratch before declaring done.
4. Watch, don't babysit: commit monitor + completion notification, not tight-loop polling or short `ScheduleWakeup`. No commit/journal result for ~10 min → stop it and finish by hand.
5. Kill switch on livelock (same commit landing 2-3x, or transcript active but HEAD static): `TaskStop` immediately, verify with `git fsck --no-reflogs | grep 'dangling commit'` nothing unique was lost, then take over directly.
6. Commit small and often in a contended tree: stage only your own paths (`git add -- <path>`), never `git add -A`/`.`.

## NAS Build Safety (it also runs Plex, 6-thread CPU)

1. Never run a raw compile against the NAS (`docker compose build`/`up --build`, `docker build`, `cargo build` over SSH). A PreToolUse hook (`~/.claude/hooks/guard-nas-build.sh`) blocks these — don't rely on the block.
2. `scripts/deploy-nas.sh` pulls the CI-built images (`ghcr.io ...:sha-<commit>`), so a normal deploy compiles nothing on the NAS. Only if GHCR is unreachable: `scripts/nas-safe-build.sh <service> [critical-container]` (or `deploy-nas.sh --build-on-nas`) — caps compile threads to spare cores, runs detached, auto-aborts if Plex/load degrades. Playbook: `scripts/nas-safe-build.sh:1-53`.
3. Swap a built image in with `docker compose up -d --no-build <service>` (seconds, no compile) — always safe.
4. Keep BuildKit cache mounts (`target/` + cargo registry) on compiled services; any new compiled service needs the same mounts plus `CARGO_BUILD_JOBS`. Do not remove them.
5. Watch via `https://api.theemeraldexchange.com/api/health`, not SSH — a 502/530 means the box is wedged. Never tight-poll SSH on a loaded box.

## Environment Cheat-Sheet

- `curl` works locally and over SSH on the NAS; `wget` is NOT installed.
- `$status` is reserved in zsh — use `exit_code`/`rc` instead.
- Scripts may run under zsh or sh — avoid bash-isms (`${var//pattern/replace}`) without an explicit `#!/bin/bash` shebang.
- Prod host `root@theemeraldexchange.local`; appdata root `/mnt/user/appdata/exchange-backend/`. All remote ops go through SSH or `docker` forwarded via SSH.
- No `sleep`-then-curl health-checks — sandbox blocks long leading sleeps; poll via `node` or SSH directly.
- Repo may be public — never hardcode secrets, API keys, tokens, IPs, or personal info in any committed file; use env vars and gitignored `.env`.

## Docs

- `README.md` — project overview, features, quick start, architecture, full-stack dev setup, build/test.
- `DEPLOY.md` — deploy runbook: NAS setup, ongoing deploys, troubleshooting, local recommender bootstrap.
- `DESIGN.md` — visual design system: colors, typography, layout, components, do's/don'ts.
- `PRODUCT.md` — product purpose, positioning, users, principles, roadmap.
