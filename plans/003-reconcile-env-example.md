# Plan 003: Reconcile .env.example with the backend's real environment surface

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 4132b9a..HEAD -- .env.example server/env.ts README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (but execute BEFORE plan 005, which adds two more vars to this file)
- **Category**: dx
- **Planned at**: commit `4132b9a`, 2026-06-12

## Why this matters

`.env.example` (last substantively updated 2026-05-25) predates the
media-core/transcoder playback stack, the local recommender, passkeys,
device tokens, and telemetry. A developer who copies it gets a backend
whose modern halves are silently disabled or fail at first use, with no
hint in the file they copied:

- No `USE_MEDIA_CORE` / `MEDIA_CORE_URL` / `TRANSCODER_URL` — the media
  library tab never mounts.
- No `INTERNAL_PRINCIPAL_SECRET` — playback grants fail closed with 502
  `principal_mint_failed` when media-core IS wired up
  (`server/routes/media.ts:163-169`).
- No `STREAM_TOKEN_SECRET` / `DEVICE_TOKEN_SECRET` / recommender /
  telemetry vars.
- The header comment says "copy to `.env.local`" while `README.md` says
  "Backend secrets live in `.env`" — and the backend actually loads
  `.env.local` (`server/env.ts:44`: `dotenvConfig({ path: '.env.local' })`),
  so the README is the wrong one.

The repo may become public; this file is also the de-facto statement of
what configuration exists. Secrets hygiene matters: placeholders only,
never real values (a standing repo rule).

## Current state

- `.env.example` (74 lines) documents only: `SONARR_API_KEY`,
  `RADARR_API_KEY`, `SAB_API_KEY`, `PLEX_CLIENT_ID`, `SESSION_SECRET`,
  `ADMINS`, `PLEX_SERVER_ID`, `PORT`, `ALLOWED_ORIGINS`, service URLs
  (commented), `MIN_FREE_GB`, `RUNWAYML_API_SECRET`, and the IPTV/Xtream
  block (`XTREAM_*`, `IPTV_*`). Header lines 1-4:
  ```
  # Local development only — copy to .env.local and fill in real values.
  # Real values are in /mnt/user/appdata/{sonarr,radarr,sabnzbd}/* on the NAS.
  ```
- `server/env.ts` is the single authoritative env loader (~530+ lines): it
  reads `.env.local` at boot (line 44), checks `NODE_ENV` (line 101), and
  exposes flags like `ALLOW_UNSCOPED_PLEX_LOGIN` (line 124),
  `USE_LOCAL_RECOMMENDER` (line 137), `USE_MEDIA_CORE` (line 138), and
  `MEDIA_CORE_URL` via an `opt(...)` helper (lines 524-525). The complete
  variable inventory must be enumerated from this file — it is the source
  of truth, not this plan.
- `README.md` "Local development" section says backend secrets live in
  `.env` (README line ~62) — inconsistent with `server/env.ts:44`.
- Note for accuracy: `MEDIA_INTERNAL_PRINCIPAL_MODE` is consumed by the
  Rust media-core **container** (set in `docker-compose.yml`), not by the
  Node backend — if you document it, do so in a clearly-labelled "sidecar
  services (docker-compose / local sidecar runs)" comment block, not as a
  backend var.

## Commands you will need

| Purpose   | Command            | Expected on success |
|-----------|--------------------|---------------------|
| Install   | `npm ci`           | exit 0              |
| Typecheck | `npx tsc -b`       | exit 0              |
| Tests     | `npm test`         | all pass            |
| Lint      | `npm run lint`     | exit 0              |

(No code changes expected — these gates just prove nothing broke; the real
verification is the Step-2 audit script output.)

## Scope

**In scope** (the only files you should modify):
- `.env.example`
- `README.md` — only the `.env` vs `.env.local` sentence(s) in the local
  development section

**Out of scope** (do NOT touch):
- `server/env.ts` — document what exists; change nothing.
- `docker-compose.yml`, `recommender/`, `crates/` — sidecar env surfaces
  get at most a pointer comment, not enumeration.
- Any real secret value, hostname, or IP. Placeholders and generation
  recipes only (follow the existing style: e.g. the `SESSION_SECRET` block
  at `.env.example:18-24` shows the `node -e "crypto.randomBytes(...)"`
  recipe pattern — keep that voice).

## Git workflow

- Branch: `advisor/003-env-example-reconcile`
- Conventional-commit style (e.g. `docs(dx): reconcile .env.example with the real backend env surface`)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Enumerate the real env surface

Extract every variable the backend reads:

```bash
grep -oE "process\.env\.[A-Z0-9_]+|opt\('[A-Z0-9_]+'\)|req\('[A-Z0-9_]+'\)" server/env.ts | grep -oE "[A-Z0-9_]{2,}" | sort -u
```

Also sweep the few services that read env directly (`server/services/appleAuth.ts`,
`server/services/grabLog.ts`, `server/services/logger.ts`,
`server/services/iptvEpgExternal.ts` — found via
`grep -rln 'process.env' server --include='*.ts' | grep -v test`).

**Verify**: you have a deduplicated list; spot-check three entries against
`server/env.ts` to confirm how each is parsed (boolean `=== '1'`, optional
string, required-in-prod, default value).

### Step 2: Diff against .env.example and write the audit

For each variable in the list, classify: already documented / missing /
documented-but-stale (wrong default, wrong description). Save the
classification as the commit-message body or a code comment — it is the
review artifact.

**Verify**: every `USE_*`, `*_SECRET`, `*_TOKEN*`, `*_URL` from Step 1 is
classified.

### Step 3: Rewrite .env.example

Reorganize into labelled sections mirroring how `server/env.ts` groups
things (auth/session, *arr bridges, IPTV/Xtream, media-core + transcoder,
recommender, telemetry, dev-only). For each variable: one-to-three-line
comment in the existing explanatory voice (what it does, what happens when
unset, generation recipe where applicable — match the `SESSION_SECRET`
block's style), then `VAR=` with an empty or safe-default value. Rules:

- Required-in-prod vars get a `# REQUIRED in production:` prefix in their
  comment.
- Boolean flags show their off state (`USE_MEDIA_CORE=` with a comment
  saying `set to 1 to mount /api/media`).
- Keep the existing accurate entries (don't churn wording that's still
  right); keep the IPTV block.
- Add the clearly-labelled sidecar pointer block (compose-managed vars like
  `MEDIA_INTERNAL_PRINCIPAL_MODE` live in `docker-compose.yml`; local
  sidecar runs are documented in README's full-stack section).
- NO real values anywhere — placeholders only.

**Verify**: re-run the Step-1 extraction and confirm every variable from it
now appears in `.env.example` (either as an entry or, for the handful of
truly internal/test-only vars, deliberately listed in a trailing comment
naming them as intentionally undocumented). A var can only be skipped
silently if it never affects local dev or prod ops — justify each skip.

### Step 4: Fix the README inconsistency

In README's "Local development" section, align the secrets sentence with
reality: the backend loads `.env.local` (`server/env.ts:44`); `.env.example`
is the template you copy. One or two sentences; don't restructure the
README.

**Verify**: `grep -n 'env' README.md | head -20` — no remaining claim that
backend secrets live in `.env`.

### Step 5: Gate

```bash
npm test && npx tsc -b && npm run lint
```

**Verify**: all green (no code was touched; this is the safety net).

## Test plan

No unit tests for a template file. The verification is Step 3's
enumeration-coverage check plus one manual smoke: copy the new file to a
scratch path, `grep -c '=.\+' <scratch>` to confirm no entry accidentally
ships a filled-in value other than documented safe defaults (ports, cron
expressions, paths).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] Every variable extracted in Step 1 appears in `.env.example` or in its explicit intentionally-undocumented trailing note
- [ ] `grep -iE '(secret|key|token|password)=' .env.example` shows only empty values after the `=`
- [ ] `.env.example` contains a media-core/transcoder section including `USE_MEDIA_CORE`, `MEDIA_CORE_URL`, `INTERNAL_PRINCIPAL_SECRET`
- [ ] README no longer claims backend secrets live in `.env`
- [ ] `npm test`, `npx tsc -b`, `npm run lint` all exit 0
- [ ] `git diff --name-only` shows only `.env.example` and `README.md`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `server/env.ts` doesn't match the "Current state" description (loader
  moved or split).
- You find what looks like a REAL credential value anywhere in the tracked
  files while doing this work — do not copy it anywhere (not even into your
  report); reference file:line and the credential type only, and stop.
- The Step-1 inventory exceeds ~60 variables — that suggests the extraction
  regex is over-matching; report instead of writing a 300-line file.

## Maintenance notes

- Plan 005 (mock media-core dev mode) adds `USE_MEDIA_CORE_MOCK` and its
  port var to this file — execute this plan first so 005 edits a current
  template.
- Future env vars should land in `.env.example` in the same PR that adds
  them to `server/env.ts`; reviewers should treat a new `process.env` read
  without a template entry as a review flag.
