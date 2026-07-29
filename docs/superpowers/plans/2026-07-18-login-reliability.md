# Login Reliability Implementation Plan

> **Execution rule:** complete each slice test-first and verify it independently. Do not deploy an authZ hardening change merely because the polling incident tests pass.

**Goal:** Eliminate the confirmed shared-household Plex login failures, make browser session establishment explicit and recoverable, close the adjacent provider-bootstrap authorization defects, and leave an executable roadmap for the single-origin/passkey-first future state.

**Architecture:** Preserve the existing Hono auth routes, encrypted HttpOnly session cookie, members/invites authorization model, and WebAuthn ceremony engine. Replace only the unreliable control logic: a completion-scheduled Plex poller, a PIN-first three-tier limiter, a centralized `/api/me` session reader, provider-aware UI state, decoupled ownership predicates, and a transaction around invite redemption plus passkey persistence.

**Stack:** TypeScript, React 19, Hono, Vitest/Testing Library, Playwright, better-sqlite3, Docker Compose/Netlify.

---

## Execution ledger

| Slice | State | Release gate |
|---|---|---|
| 1–11: limiter, poller, session truth, provider UI, authZ/schema/CSRF/passkey/admin/privacy/lifecycle | Implemented and independently reviewed | Focused unit/DOM/route/build gates green. |
| 12: protected-request expiry precision | Integrated; independent re-review Ready | Exact expiry classification, full producer inventory, single-flight `/api/me`, 659 client tests, focused server tests, SPA build, and lint green. |
| 13: deployment posture and strict first-owner semantics | Integrated; independent re-review Ready | Seal every proven effective-admin login with a durable marker, preserve env-driven demotion, and share one member verdict across passkey/provider/cookie/bearer paths; 2,781 tests, configuration contract, server build/lint, real-restart probes, Claude consensus, and independent re-review green. |
| 14: browser and production proof | Released; live gate independently Ready | Mocked Plex flow repeated 9/9 and real owner/member/reuse-denial journey repeated 3/3; production then completed 62/62 two-PIN shared-client checks without a 429, cookie, or authorization, with exact release/schema/logging checks green. A real credentialed ceremony remains intentionally deferred. |
| 15: future roadmap | Reprioritized from production evidence | Recovery and multiple passkeys precede the now-proven-healthy split-origin migration; alerting, single-origin auth, lifecycle/CSP, and the evidence-based session-store decision retain explicit exit criteria. |

No slice advances merely because its own focused test passes. The integration branch is rebuilt and retested from a clean process after every accepted review remediation.

---

## Task 1: Lock the production failure into server tests

**Files:**

- Modify: `server/auth.test.ts`
- Modify: `server/auth.ts`

1. Add a failing test that sends more than 60 normal checks split across two PINs from one trusted client address and expects them all to remain below the household backstop.
2. Add a failing test that one PIN reaches a 60/minute ceiling and returns `429` plus `Retry-After`.
3. Add a failing test that a trusted client reaches the new 300/minute backstop even while rotating PINs.
4. Run only the Plex-check route tests and record the expected failures against the old 60/minute client bucket and 90/minute PIN bucket.
5. Change `check` limits to per-PIN 60, trusted-client 300, global 600.
6. Parse the bounded body before performing the single combined limiter evaluation so the PIN participates without double-counting the request.
7. Emit a redacted structured warning on rejection with operation, bucket scope, request ID, and retry seconds.
8. Re-run the focused route tests until green.

## Task 2: Replace overlapping Plex polling

**Files:**

- Modify: `src/lib/auth.dom.test.tsx`
- Modify: `src/lib/auth.tsx`

1. Replace the interval-oriented test harness with fake timers and controllable promises.
2. Add a failing test proving that advancing the clock while a check is unresolved does not start a second check.
3. Add a failing test that a `429` with `Retry-After` schedules another check and does not render an alert.
4. Add a failing test that four consecutive network/5xx failures stop with a retryable service message.
5. Add a failing test that unmount/cancellation aborts the current request and ignores a late authorized response.
6. Implement one completion-scheduled `setTimeout` loop at a 2.5-second base cadence.
7. Add one controller and attempt generation per Plex attempt; centralize cleanup.
8. Honor/clamp `Retry-After`; add bounded exponential transient backoff; preserve popup-close grace and the five-minute deadline.
9. Re-run the DOM tests until green.

## Task 3: Centralize session truth and confirmation

**Files:**

- Modify: `src/lib/auth.dom.test.tsx`
- Modify: `src/lib/auth.tsx`
- Modify: `src/App.tsx`

1. Add failing tests for initial `/api/me`: 401 gives anonymous, while 500/network/malformed-200/timeout give an unavailable state with Retry.
2. Add a failing test that Retry can recover the unavailable state into an authenticated user.
3. Add failing tests for each cookie-setting provider success path proving UI identity is not applied until a subsequent `/api/me` returns the same subject.
4. Add a failing test that provider success followed by `/api/me` 401 reports a session-establishment failure.
5. Implement a validated session-response parser and a three-attempt bounded transient retry helper with a finite request timeout.
6. Add explicit session error/retry state to the auth context while preserving the existing `loading` compatibility surface.
7. Make `AuthGate` render a branded, accessible unavailable view with Retry; render Walkthrough only after explicit 401.
8. Route Plex, Apple, passkey login, and passkey registration success through session confirmation before `applyUser`.
9. Re-run auth DOM/App tests until green.

## Task 4: Make provider state truthful

**Files:**

- Modify: `src/lib/auth.tsx`
- Modify: `src/components/walkthrough/Walkthrough.tsx`
- Modify: `src/components/auth/AppleSignInButton.tsx`
- Modify: `src/components/auth/PasskeyButtons.tsx`
- Modify: corresponding component DOM tests

1. Add failing component tests showing passkey work does not label Plex as waiting and Apple work does not label passkey as waiting.
2. Add `activeSignIn` to the auth context for `plex`, `apple`, `passkey-login`, and `passkey-register`.
3. Set/reset the active provider in every terminal path and central cleanup path.
4. Keep cookie-setting ceremonies serialized, but render progress text only on the active provider.
5. Ensure duplicate sign-in blocks do not create contradictory progress/error output.
6. Use `useId()` for passkey registration labels while touching the duplicated block behavior; add the two-instance accessibility regression test.
7. Normalize Apple SDK object-shaped cancellation errors and make a failed SDK script retryable in-page; add focused tests.
8. Re-run component and auth tests until green.

## Task 5: Close provider-bootstrap authorization gaps

**Files:**

- Modify: `server/services/membership.ts`
- Modify: `server/services/membership.test.ts`
- Modify: `server/services/setupState.ts`
- Modify: `server/services/setupState.test.ts`
- Modify any boot-status tests documenting the split predicates

1. Add failing Google-only tests showing an unlisted verified identity is not admitted.
2. Add failing Apple-only and Google-only tests showing the installation is still setup-token claimable before durable ownership exists.
3. Add a failing test that an existing member/admin/claimed marker closes claimability.
4. Split "normal login is fail-closed" from "owner claim remains available." Provider configuration must not serve as durable ownership evidence.
5. Preserve the explicit Plex server-share auto-admission route and existing ADMIN_SUBS/member behavior.
6. Add a boot warning for provider-enabled, unclaimed installs without logging identities or secrets.
7. Re-run membership, setup, auth, passkey, and session-gate suites until green.

## Task 6: Repair Google persistence and browser login-CSRF

**Files:**

- Add: `server/migrations/server/0007_members_google_auth_mode.sql`
- Modify: `server/services/invites.test.ts` or add a migrated-database Google integration test
- Modify: `server/middleware/csrf.ts`
- Modify: `server/middleware/csrf.test.ts`

1. Add a failing real-database test that redeems an invite with `authMode='google'` and observe the current CHECK constraint failure.
2. Add a forward-only table-rebuild migration that preserves rows and permits `google`; do not edit migration 0003.
3. Keep the renamed source table as a recoverable migration backup so the migration does not cross the project's `DROP TABLE` gate during this incident.
4. Verify fresh and upgraded schema paths, including active/revoked roles and index-backed reads.
5. Change the native bootstrap exemption to require both no cookie and no Origin.
6. Replace the current hostile-Origin success expectation with a failing-then-green rejection test for every cookie-setting bootstrap path.
7. Preserve an explicit originless native bootstrap success test.
8. Re-run migrations, invites, auth routes, and CSRF suites until green.

## Task 7: Make passkey invite registration atomic

**Files:**

- Modify: `server/routes/passkey.ts`
- Modify: `server/routes/passkey.test.ts`
- Add or modify an integration test using the real temporary server database

1. Add a failing crash-window test: issue one invite, inject credential persistence failure, and assert no member plus no consumed invite use.
2. Wrap normal `authorizeOrRedeem` plus `persistCredential` in one outer database transaction.
3. Preserve the setup-token claim transaction unchanged.
4. Keep session minting and native device token creation strictly after commit.
5. Verify nested better-sqlite3 transactions use savepoints and do not produce a double-BEGIN failure.
6. Re-run invite, membership, WebAuthn, and passkey route/integration tests until green.

## Task 8: Keep administrator policy consistent and recoverable

**Files:**

- Modify: `server/services/reconcileDeviceToken.ts`
- Modify: `server/services/reconcileDeviceToken.test.ts`
- Modify: `server/services/members.ts`
- Modify: `server/routes/adminInvites.ts`
- Modify: `server/routes/adminInvites.test.ts`

1. Add a failing test that a device token for the DB-backed claimed owner reconciles as administrator.
2. Use the same active exact-sub member-role fallback as cookie reconciliation.
3. Add failing route tests for self-revoke and final-active-admin revoke.
4. Implement a transaction that refuses immutable owner, self, and last-admin revocation while permitting a non-admin or a redundant admin to be revoked.
5. Assert rejected operations leave the member and device/playlist tokens untouched.
6. Re-run cookie/bearer auth, member, admin-route, and device suites until green.

## Task 9: Preserve provider backpressure and add operational visibility

**Files:**

- Modify: `server/auth.ts`
- Modify: `server/index.ts` or the narrowest existing boot-report surface
- Modify: relevant log tests
- Modify: `docs/operations/` auth/runbook material if present

1. Add tests that rate-limit and terminal auth events never contain raw PIN, IP, invite, token, assertion, cookie, or subject.
2. Preserve upstream Plex `429` and browser-readable `Retry-After` through the local proxy without converting it to a generic 500/502.
3. Redact outbound provider request URLs and errors so a PIN or token cannot enter application logs or telemetry.
4. Emit structured operation/provider/outcome/reason/elapsed/request-id fields at the terminal auth seams.
5. Emit the effective public auth posture at boot: enabled providers, `serveSpa`, trusted-IP mode, origins, cookie mode, and WebAuthn RP configuration.
6. Document the three-tier Plex check limits and the browser session-confirmation diagnostic.
7. Verify existing PII scrubbers and token-redaction tests remain green.

## Task 10: Remove invite credentials before application startup

**Files:**

- Modify: the earliest browser bootstrap module
- Modify: `src/components/walkthrough/Walkthrough.tsx`
- Modify: telemetry and startup-order tests

1. Put invite codes only in the URL fragment, never path/query parameters that reach the server or referrer.
2. Consume and remove the fragment synchronously before React, telemetry configuration, or `/api/me` can run.
3. Preserve path and search exactly while clearing the fragment.
4. Keep the invite only in process memory; do not use local/session storage, analytics, logs, or error breadcrumbs.
5. Pass the in-memory invite into the registration panel and clear it after terminal success/cancellation.
6. Prove startup-order, history replacement, refresh, malformed-fragment, and redaction behavior in DOM tests.

## Task 11: Reconcile the browser session lifecycle

**Files:**

- Modify: `src/lib/auth.tsx`
- Modify: auth lifecycle DOM tests

1. Broadcast tokenless login/logout/expiry notifications across tabs.
2. Revalidate on focus and `pageshow`, including BFCache restore, without duplicating ordinary foreground probes.
3. Coalesce simultaneous lifecycle triggers and preserve the latest attempt generation.
4. On confirmed logout/expiry, clear protected query data, provider discovery, view-as state, and pending provider work before exposing the public shell.
5. Ensure provider discovery never starves a foreground session retry.
6. Prove remote logout, stale-message, abort, focus, BFCache, and cache-clearing behavior in DOM tests.

## Task 12: Make protected-request expiry signaling complete and precise

**Files:**

- Modify: shared API error/query-client utilities
- Modify: protected React Query and imperative API consumers
- Modify: Sonarr, Radarr, and media proxy boundaries
- Modify: focused component/API/auth lifecycle tests

1. Preserve numeric HTTP status plus typed edge error code in every protected wrapper.
2. Export one shared debounced expiry notifier used by React Query and imperative fetches.
3. Emit only for `401` plus edge-auth `unauthenticated`; explicitly reject `403`, other `401` codes, and integration failures.
4. Normalize upstream Arr/media-core `401` responses to an integration `502` at the server boundary.
5. Inventory locally caught/swallowed fetches in playback, Live, Movies, TV, feedback, settings, and telemetry paths.
6. Prove a burst coalesces and the complete `401 → event → /api/me anonymous → protected-cache clear` chain works.

## Task 13: Make deployment and first-owner posture operable

**Files:**

- Modify: provider/auth environment parsing and Compose surfaces
- Add: a deployment-contract checker and tests
- Add: `docs/operations/login-auth-runbook.md`
- Modify: membership/setup-state tests and legacy authenticated test fixtures

1. Pass Apple, Google, Plex, `ADMIN_SUBS`, and WebAuthn inputs through every supported deployment surface and production example.
2. Fail contract tests when an input is missing, hard-coded, or wired to the wrong environment file.
3. Log a redacted, truthful boot posture: configured versus request-derived RP, exact cookie mode, safe origins, provider booleans, and trusted-header mode.
4. Keep normal login fail-closed even on a fresh installation; signed cookies without active membership remain unauthorized.
5. Keep setup claimable until a durable administrator/owner exists. Provider config, Plex server id, and ordinary member rows are not ownership.
6. Pass `SETUP_ALLOW_REMOTE` through both Compose surfaces and every matching environment example, defaulting off.
7. Resolve first-owner source from a trusted proxy client header before the proxy's loopback socket; never trust spoofable forwarded headers on a directly reachable backend.
8. Update legacy test fixtures to create real active members instead of weakening production code, and exclude test-only membership helpers from production build/deploy payloads.
9. Run the entire server suite to catch impossible cookie-only fixtures and cross-route behavior.
10. After provider proof and shared authZ resolve an effective administrator via `ADMIN_SUBS`, legacy `ADMINS`, or durable role, atomically seal the first-owner marker before minting a cookie/bearer token. Do not promote the member row. Prove environment removal/restart cannot reopen setup, legacy demotion still works, invalid/denied identity cannot create ownership, and a revoked admin row remains a non-authorizing one-way gate.
11. Route passkey login through the same `memberStatus` verdict as provider, cookie, and bearer paths. Permit a rowless identity only when an exact `ADMIN_SUBS` match resolves it to administrator; deny missing ordinary rows and revoked identities.
12. Pair the setup and login predicates in one regression: `PLEX_CLIENT_ID` alone keeps setup claimable while normal Plex login remains fail-closed. Document the legacy `ADMINS`-only upgrade window and first successful administrator seal.
13. Persist Plex-server share admission as ordinary membership only. Apply legacy `ADMINS` after final authZ, seal before issuing credentials, fail closed when sealing fails, and prove a restart without `ADMINS` demotes the user while the marker keeps setup closed.

## Task 14: End-to-end regression and production verification

**Files:**

- Modify: `tests/e2e/auth.spec.ts`
- Modify: `tests/e2e/integration/selfhostClaim.spec.ts`
- Modify Playwright configuration only if a narrowly scoped auth project is needed

1. Add a rendered mocked Plex flow covering pending, 429/Retry-After, authorized, and `/api/me` confirmation.
2. Extend the self-host WebAuthn flow through invite fragment, fragment removal, registration, session cookie, `/api/me`, and an actual second redemption attempt; assert denial plus unchanged member, credential, and invite-use counts.
3. Make a missing production SPA build fail the self-host test and build it explicitly in clean CI; directly own and await the spawned backend process so test cleanup cannot leak a listener.
4. Run focused auth suites.
5. Run the full unit/integration suite, lint, typecheck/build, and any existing parity checks required by the repository contract.
6. Build and deploy through the repository's NAS-safe scripts; recreate with `docker compose up -d --no-build` only after a successful local image build.
7. Verify `/api/health`, `/api/version`, `/api/auth/methods`, canonical-origin CORS/CSRF behavior, and clean container startup.
8. Run two simultaneous unauthenticated Plex PIN poll flows behind one client address beyond the old threshold; verify no 429 and no overlapping request per flow.
9. Inspect redacted auth logs for correct outcome/retry evidence.
10. Do not complete a real member/operator login without explicit credential authorization.

## Task 15: Close independent release-audit blockers

**Files:**

- Modify: `src/lib/auth.tsx` and auth lifecycle tests
- Modify: `src/lib/hooks/useUserApiKey.ts`, the settings client/route, and focused tests
- Add: a typed server auth-outcome reporter and tests
- Modify: Plex, Apple, Google, and passkey terminal seams

1. Bound every provider network leg and logout with attempt-scoped cancellation; release shared guards after timeout, cancellation, unmount, or error.
2. Start the Plex total deadline before configuration/PIN setup, close its popup on abort, and keep the interactive WebAuthn ceremony outside the fetch timeout.
3. Make logout fail safe locally even when the server request times out; a later `/api/me` remains the source of server-cookie truth.
4. Scope Anthropic-key query data by provider subject and reject stale principal generations before any server mutation, cache write, or local credential removal.
5. Bind settings mutations to the expected authenticated subject so a cookie change cannot redirect an in-flight secret write or delete to another household member.
6. Emit exactly one typed, low-cardinality, redacted event for each terminal Plex, Apple, Google, and passkey outcome. Reuse the request ID, round elapsed time, and emit nothing for normal Plex pending polls.
7. Prove black-holed provider requests cannot wedge the login lock, a slow WebAuthn prompt is not timed out, logout clears local state on timeout, principal switching cannot transfer a key, and sentinel login artifacts never enter serialized events.
8. Re-run the complete matrix at the integrated commit and return the exact delta to the independent reviewers and Claude pane before deployment.

## Task 16: Record the future migration backlog

**Files:**

- This design document
- Future milestone/issue tracker chosen by the maintainer

- **L2 — Passkey recovery:** design multiple passkeys, last-credential protection, and separately verified recovery.
- **L3 — Auth detection:** attach low-cardinality alerting and credential-free availability synthetics to the new auth outcome contract.
- **L4 — Single-origin auth:** prove proxy Host/scheme preservation, then plan canonical `/api/*` routing and the SameSite migration.
- **L5 — Hardened lifecycle:** roll out report-only then enforced CSP, narrow native CSRF bootstrap exemptions to an explicit device-pair contract, and add Firefox/WebKit auth smoke coverage.
- **L6 — Session-store decision:** reassess server-side session revocation only after recovery, alerting, and single-origin work.
- **Ongoing deployment contract:** keep Apple/Google variables contract-tested across root and self-host Compose/examples before either provider is enabled.
