# M3 internal-principal rollout runbook

This rolls the cross-service `Authorization: Bearer <jwe>` header from
"minted but ignored" to "minted and enforced." The Hono backend already
mints the JWE on every outbound recommender call (12 commits ahead of
origin/main as of 2026-05-27). The receiver is wired but defaults to
`off`. This doc takes the receiver through `off → log → enforce`.

## Prereqs

- All 13 backend → recommender call sites thread caller identity
  through `recommenderCallerFromSession()`
  (commit `dfb8ac4`).
- Multi-stage backend Docker image builds the `@emerald/contracts-napi`
  linux-x64-gnu .node (commit `28686a0`, fixed by `11da5f8` to use the
  correct `napi` binary name).
- Multi-stage recommender Docker image builds the PyO3 wheel
  (commit `7d6c449`).
- 12 (now 13) commits pushed to `origin/main`.

## Step 0: provision the secret

`INTERNAL_PRINCIPAL_SECRET` is the IKM for HKDF-SHA256 with info string
`eex/internal-principal/v1`. **Both containers must see the same value
byte-for-byte** — they derive the same 32-byte key independently.

Generate once on a secure machine:

```bash
openssl rand -base64 48
```

Add to `.env.production` on the deploy host:

```
INTERNAL_PRINCIPAL_SECRET=<base64 value from openssl>
```

Boot-time guards will reject:

- Values shorter than 32 bytes (`server/env.ts` via
  `validateSecretStrength`).
- Placeholder strings like `changeme`, `placeholder`, `test-secret`
  (`recommender/app/config.py` line 85: "INTERNAL_PRINCIPAL_SECRET
  looks like a placeholder value").

Do NOT commit the value. The `deploy-nas.sh` script ships
`.env.production` to the NAS over rsync and chmods it `600`.

## Step 1: deploy with mode=off (no-op verification)

This is the "is the JWE getting attached at all" check. The receiver
ignores the header in `off` mode; we're verifying that:

1. The backend image builds with the napi binding loaded.
2. The recommender image builds with the PyO3 wheel installed.
3. Backend boot doesn't crash on the new secret being present.

```bash
./scripts/deploy-nas.sh
```

Watch the napi-builder stage log for the message
"Finished `release` profile [optimized] target(s)" — that confirms
the napi-rs CLI invocation succeeded inside Docker.

Smoke-test the backend's napi binding from the running container:

```bash
ssh root@theemeraldexchange.local "docker exec exchange-backend node -e \
  \"console.log(Object.keys(require('@emerald/contracts-napi')))\""
```

Expected exports (alphabetical here, order in the import is module
order):

- `deviceTokenDecrypt`
- `deviceTokenEncrypt`
- `hkdfDeviceToken`
- `hkdfInternalPrincipal`
- `hkdfSession`
- `internalPrincipalEncrypt`
- `parseSub`
- `piiScrubKeys`
- `piiScrubValue`
- `streamTokenEnforceTimeWindow`
- `streamTokenSign`
- `streamTokenVerify`
- `streamTokenVerifyDualKey`

If `require('@emerald/contracts-napi')` throws `Error: cannot open
shared object` or a glibc version mismatch, the napi-builder stage's
`rust:1.90-slim-bookworm` (glibc 2.36) produced a binary the runtime
stage's `node:24-slim` (also glibc 2.36) can't load. Both base on
bookworm so this should not happen — if it does, the fallback is to
build inside `node:24-slim` with rustup added in stage 1.

Smoke-test the recommender's PyO3 wheel:

```bash
ssh root@theemeraldexchange.local "docker exec exchange-recommender \
  python -c 'import emerald_contracts; \
  print(dir(emerald_contracts))' | tr ',' '\n' | grep -E 'internal|hkdf'"
```

Should list `hkdf_internal_principal`, `internal_principal_decrypt`,
`internal_principal_encrypt`, `internal_principal_enforce_time_window`.

## Step 2: flip to mode=log (24h observation)

On the NAS, edit `/mnt/user/appdata/exchange-backend/.env`:

```
RECOMMENDER_INTERNAL_PRINCIPAL_MODE=log
```

Restart the recommender container only — the backend is unaffected:

```bash
ssh root@theemeraldexchange.local \
  "cd /mnt/user/appdata/exchange-backend && docker compose restart recommender"
```

In `log` mode the recommender verifies the JWE on every request, logs
any failure, and **always returns the response** (no 401). The `x-recommender-secret`
HMAC continues to gate.

### What "healthy" looks like

Run for 24 hours. With commit `dfb8ac4`, every call site threads
caller identity, so the receiver should observe a valid principal on
every request. The following log lines should be ABSENT:

```
WARNING internal-principal: missing on request (mode=log)
ERROR   internal-principal: emerald_contracts unavailable (mode=log)
ERROR   internal-principal: secret unset but mode=log — cannot verify
WARNING internal-principal: verify failed: <error> (mode=log)
```

Tail the live log:

```bash
ssh root@theemeraldexchange.local \
  "docker logs -f exchange-recommender 2>&1 | grep -i 'internal-principal'"
```

Or count occurrences over the observation window:

```bash
ssh root@theemeraldexchange.local \
  "docker logs --since 24h exchange-recommender 2>&1 | \
   grep -c 'internal-principal'"
```

Expected count: 0 (or very low, attributable to specific tracebacks).

### What "broken" looks like

| Log line | What's wrong | Fix |
|---|---|---|
| `missing on request` | Some Hono route bypasses `mintInternalPrincipal`. Most likely a route added since `dfb8ac4` that didn't get the `recommenderCallerFromSession()` lift. | Find the route via the surrounding traceback. Add the caller param. Stay in log mode until the count returns to zero. |
| `emerald_contracts unavailable` | PyO3 wheel didn't install in the recommender image. Image build is broken. | Roll back to mode=off. Rebuild the recommender image. |
| `secret unset but mode=log` | `INTERNAL_PRINCIPAL_SECRET` missing from the recommender's environment. | Verify `.env` has the secret AND `docker compose config` shows it propagated to the recommender service. |
| `verify failed: <error>` | Decrypt failure. Could be: secret mismatch between backend and recommender, clock skew between containers (claims have 60s TTL), or a binding-layer bug. | If decrypt error → secrets diverged; re-sync `.env`. If time-window error → check `docker exec ... date` on both containers. Otherwise capture the request ID and inspect. |

**Do NOT advance to enforce until 24h of zero warnings.**

## Step 3: flip to mode=enforce

Once log mode is silent for a full day:

```
RECOMMENDER_INTERNAL_PRINCIPAL_MODE=enforce
```

Restart the recommender:

```bash
ssh root@theemeraldexchange.local \
  "cd /mnt/user/appdata/exchange-backend && docker compose restart recommender"
```

In `enforce` mode the recommender:

- Returns `401 internal-principal required` if the `Authorization`
  header is missing.
- Returns `401 invalid internal-principal: <reason>` if decrypt or
  time-window check fails.
- Returns `503 emerald_contracts unavailable` if the PyO3 wheel
  isn't loaded.
- Returns `503 INTERNAL_PRINCIPAL_SECRET not configured` if the
  secret is empty.

The `x-recommender-secret` HMAC continues to gate as defense in depth.

### Verify enforce is live

From the NAS itself, call a protected route with NO event secret and no JWE —
the recommender's auth gate (`require_event_secret`) must reject it. Use
`/metrics/funnel`: it's protected and takes no request body, so the response is
an unambiguous `401` (a route like `/score` would 422 on the missing body
first). `/suggestions` does not exist on the recommender — its real routes are
`/score`, `/health`, `/events/*`, and `/metrics/funnel`.

```bash
ssh root@theemeraldexchange.local \
  "docker exec exchange-recommender curl -s -o /dev/null -w '%{http_code}\n' \
   http://localhost:8000/metrics/funnel"
```

Expected: `401` (the recommender refuses an unauthenticated internal call). The
event secret lives in `RECOMMENDER_EVENT_SECRET`, not `RECOMMENDER_SECRET`.

From the backend container (with a real Hono-minted JWE in the path):
hit any suggestion-returning user-facing endpoint in the browser and
confirm it 200s. Recent activity in the app's "For You" row also
counts — the recommender call sits on that path.

## Rollback

`enforce → log` or `log → off` is a single env var flip + recommender
restart. The backend keeps minting the JWE in all three modes; switching
the receiver back to `off` makes the header invisible.

```
RECOMMENDER_INTERNAL_PRINCIPAL_MODE=off
```

```bash
ssh root@theemeraldexchange.local \
  "cd /mnt/user/appdata/exchange-backend && docker compose restart recommender"
```

Time-to-roll-back: ~10 seconds plus container restart (~5s).

## Secret rotation

To rotate `INTERNAL_PRINCIPAL_SECRET`:

1. Generate a new value with `openssl rand -base64 48`.
2. The current binding only supports a single active key (`kid=internal-v1`).
   A dual-key rotation window requires extending the PyO3 binding's
   `internal_principal_decrypt` to accept multiple kids (the Rust
   `verify_dual_key` pattern from `streamToken` is the template).
3. Until that's wired: rotation is a synchronous deploy. Update
   `.env` on both containers, then restart both. Brief window
   (~5s of restarts) where in-flight requests will 401 in enforce
   mode.

Single-key rotation is acceptable for M3 — the entire stack is on the
NAS, no clients hold internal-principal JWEs, and the worst-case
window is one container restart cycle.

## Operator decision flow

```
Set secret in .env.production
        │
        ▼
deploy-nas.sh
        │
        ▼
Smoke test both containers' bindings  ──── fails ──── rebuild images
        │ ok
        ▼
mode=log + restart recommender
        │
        ▼
24h observation                       ──── warnings ─ fix the route
        │ silent                                       that bypassed
        ▼                                              the mint
mode=enforce + restart recommender
        │
        ▼
401 test from inside container         ──── 200 ───── re-check mode
        │ 401                                          env var
        ▼
ROLLED OUT
```

## Cross-references

- Contract: `docs/superpowers/specs/2026-05-25-cross-service-contract.md` §4
- Mint side: `server/services/internalPrincipal.ts`
- Verify side: `recommender/app/internal_principal.py`
- Receiver config: `recommender/app/config.py` (mode parsing)
- Backend env validation: `server/env.ts` (`validateSecretStrength`)
- Cross-binding interop test: `server/services/internalPrincipal.crossBinding.test.ts`
- Caller lift: `server/services/recommenderCaller.ts`
