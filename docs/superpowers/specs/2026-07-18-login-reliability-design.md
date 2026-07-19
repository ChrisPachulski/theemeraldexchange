# Login Reliability and Security Design

**Status:** Implemented; final verification and production rollout in progress

**Date:** 2026-07-18

**Owners:** The Emerald Exchange maintainers
**Scope:** Web login, session bootstrap and expiry, Plex polling, auth throttling, provider/bootstrap authorization, passkey registration, deployment configuration, and auth operations

## Executive decision

The login incident is not a cryptographic failure. It is a control-plane reliability failure caused by a polling client and an IP-keyed limiter whose normal operating envelopes overlap.

The work is split into three deliberately separate layers:

1. **Incident repair:** make Plex polling single-flight and backoff-aware; raise the shared-IP abuse backstop; confirm every cookie-setting login through `/api/me`; distinguish a real 401 from a transient API outage; and make the active provider explicit in UI state.
2. **Immediate authorization hardening:** decouple first-owner claimability from provider configuration, close the Google-only fall-open path without creating another owner lockout, and make invite redemption plus passkey persistence atomic.
3. **Future architecture:** converge the SPA and API onto one browser origin, make passkeys the primary login with recovery and multiple credentials, add strict CSP, and only then reconsider server-side sessions if the household-scale threat model warrants them.

The first two layers are to be implemented and verified independently so an authZ change cannot obscure whether the production login incident is fixed.

## Evidence and confirmed failure

### Production evidence

The production container logs contain the exact failure sequence:

- A Plex login began polling at `2026-07-15T20:39:06Z`.
- A second login behind the same public client address began at `20:40:29Z`.
- The SPA polls every 1.5 seconds, or roughly 40 requests per minute per login.
- Production enables trusted client-IP headers and applies a 60-request/minute `check` bucket to that shared address.
- The combined flows received `429 rate_limited` at `20:41:03.677Z` and `20:41:04.130Z`.
- The current container otherwise recorded 167 successful Plex checks, proving that Plex PIN exchange and the authentication core operate normally outside the collision.

This is deterministic: two normal household attempts demand roughly 80 checks/minute from a bucket that permits 60.

### Browser reproduction

Live browser inspection confirmed the compounding client defects:

- The polling loop is an async `setInterval`; a slow check can overlap the next check.
- A `429` is treated as a terminal generic 4xx failure even though the server provides `Retry-After`.
- Network and 5xx poll failures are silently retried until the five-minute deadline, with no bounded degraded state.
- A transient or malformed `/api/me` response is treated like a logged-out session; only 401 should have that meaning.
- Provider endpoints return a user and set a cookie, but the SPA trusts the response without proving that the browser accepted and returns the cookie.
- One global pending state causes Plex copy to appear during passkey work and disables every login method.
- Two copies of the public sign-in block mirror the same error, amplifying a single failed attempt.

### Independent review consensus

The local code audit, two delegated reviews, and the user-requested Claude pane independently converged on the same incident design. The existing focused auth suite was green (308 auth-related tests in the Claude review and 165 tests in the locally selected core set), which explains why the problem escaped: tests cover route logic and sequential mock polls, not two normal attempts sharing a production limiter or a real cookie round-trip.

The reviews also found two latent product defects outside the production incident:

- A Google-only installation is considered unbootstrapped, so a verified Google identity can fall through as allowed without a member or invite.
- An Apple-only installation is considered bootstrapped solely because Apple is configured, so the setup-token claim window closes before an owner exists.

The same review confirmed a crash window in normal passkey registration: invite redemption/member creation commits before credential persistence. If credential persistence fails, an invite can be consumed and a member can be left without a usable passkey.

A final backend pass found four more defects and each was checked against the source rather than accepted from review alone:

- The runtime and TypeScript `AuthMode` allow `google`, but migration `0003_members_invites.sql` constrains `members.auth_mode` to `plex`, `local`, or `apple`. A first Google login with an invite therefore reaches a database constraint failure and returns 500. Route tests miss it because they mock invite persistence.
- The native-bootstrap CSRF exemption accepts a cookieless request from a hostile browser `Origin`. CORS can hide the response but does not prevent the state-changing request from reaching a cookie-setting login endpoint, so a previously anonymous browser is exposed to login CSRF/session fixation.
- Native bearer reconciliation ignores the `role='admin'` stored by first-owner passkey claim even though cookie reconciliation honors it, producing contradictory authorization after pairing.
- A DB-backed owner can revoke their own or the last active administrator row. The revoked row still counts toward the old bootstrap predicate, so setup does not reopen and the installation can become permanently ownerless.

## Design principles and invariants

The implementation must preserve these invariants:

1. Only an explicit `/api/me` 401 means "anonymous." Network errors, malformed responses, timeouts, 429s, and 5xx responses mean "session state unavailable."
2. A provider response is not a completed browser login until `/api/me` returns the corresponding session identity.
3. At most one Plex check request may be in flight for a login attempt.
4. Ending or replacing an attempt must cancel its timer, abort its request, close its popup when applicable, and make late responses inert.
5. Ordinary household concurrency must not consume an abuse budget.
6. Every rate-limit layer must still leave an abuse ceiling: per PIN, per trusted client address, and global.
7. Provider configuration is not proof that an installation has an owner.
8. A new passkey member must end with both the redeemed membership and credential, or with neither.
9. No logs, telemetry, URLs, or client storage may contain invite codes, provider tokens, WebAuthn assertions, session cookies, or raw identities.
10. Existing production sessions must not require migration or forced sign-in for the incident repair.
11. A request carrying an `Origin` header must pass the browser-origin policy even when it is cookieless; native bootstrap exemption is originless only.
12. Every runtime auth mode must be representable in the durable member schema and exercised through a real migrated database.
13. Cookie and bearer reconciliation must derive administrator role from the same durable policy.
14. An administrator may not revoke their own identity or the final active administrator.
15. Provider configuration, a Plex server identifier, and an ordinary member row are not proof that a server has an owner. Only an administrator bootstrap identity, durable administrator row, or completed claim closes first-owner setup.
16. A protected browser request may announce session expiry only for the edge-auth envelope `401 unauthenticated`. A `403`, an upstream provider `401`, or an internal-service authentication failure must never log the browser out.
17. Expiry announcements from React Query, imperative fetches, focus/pageshow revalidation, and other tabs share one coalesced signal. One stale session must cause one bounded `/api/me` confirmation, not a request storm.
18. Remote logout, revocation, or expiry clears protected query data and provider discovery state before another account can observe it.
19. First-owner source policy evaluates the trusted end-client address before a reverse proxy's loopback socket. Forwarded headers are accepted only in a topology that prevents direct clients from forging them; the setup token remains mandatory in every topology.

## Considered approaches

### A. Raise the current limiter only

Change 60/minute to a larger number and leave the 1.5-second interval and client state unchanged.

This would stop the observed two-user collision, but overlapping requests, terminal 429 handling, cookie ambiguity, and false logged-out states would remain. A future cadence change could recreate the failure. Rejected as incomplete.

### B. Harden the current auth model in place

Repair the polling state machine and limiter envelope, add session confirmation and explicit failure states, preserve the existing JWE/session/authZ architecture, and separately harden claim and passkey transactions.

This is the selected immediate approach. It fixes the proven failure without migrating identities, credentials, cookies, or deployment topology.

### C. Replace the login/session architecture now

Move immediately to a same-origin proxy, rotating refresh tokens, and a server-side session service.

The same-origin direction is desirable, but doing it inside the incident repair changes DNS/proxy behavior, cookie semantics, CSRF posture, WebAuthn RP derivation, and deployment. Server-side sessions add still more state without addressing the immediate polling bug. Rejected for the incident; retained as staged future work.

## Incident repair design

### Plex polling state machine

The Plex flow becomes a single completion-scheduled loop. `setInterval` is removed.

Each attempt owns:

- a monotonically increasing attempt generation;
- one timeout handle;
- one `AbortController` for the active request;
- the popup reference;
- a five-minute absolute deadline;
- consecutive transient-failure count; and
- the timestamp at which the popup was first observed closed.

The next check is scheduled only after the prior response has been completely handled.

| Result | Behavior |
|---|---|
| `200 pending` | Reset transient failures; schedule after 2.5 seconds. |
| `200 authorized` | Stop/abort/close; confirm via `/api/me`; then commit the user to UI state. |
| `403` | Stop and show the mapped authorization denial. |
| `429` | Parse `Retry-After`, clamp it to a safe finite range, and resume after the larger of 2.5 seconds or the requested delay. Do not present a terminal login error. |
| Other 4xx | Stop and show a typed retryable failure. |
| Network error or 5xx | Exponential backoff from 2.5 seconds, capped at 15 seconds. After four consecutive failures, stop with an explicit service-unavailable message and retry affordance. |
| Popup closes | Continue for the existing 10-second propagation grace period; then stop as cancelled. |
| Five-minute deadline | Stop with an expired-attempt message. |

An abort caused by cleanup is not reported as a user-facing network error. Every async continuation checks its attempt generation before mutating state.

### Rate-limit envelope

The `/plex/check` body remains capped at 1 KiB and is parsed before applying the identity-aware rules, allowing the valid integer PIN to be part of the first and only limiter evaluation.

| Bucket | New limit | Purpose |
|---|---:|---|
| Per PIN | 60/minute | Primary runaway-attempt guard. A healthy 2.5-second poll uses about 24/minute. |
| Per trusted client address | 300/minute | Abuse backstop. Roughly twelve concurrent healthy household attempts fit without collision. |
| Global | 600/minute | Server-wide resource ceiling. |

The per-client bucket is retained. Removing it would let a single source randomize PINs until the shared global ceiling harms every user. Non-polling Apple, Google, and passkey limits remain unchanged.

`Retry-After` remains mandatory on a rejected request. Rate-limit logs record only the auth operation, bucket scope, request ID, and delay—never the IP, PIN, invite, token, or identity.

### Session probing and login confirmation

Session reads are centralized behind one parser and retry policy.

The parser requires:

- a successful JSON response;
- an object-shaped `user`;
- string `sub` and `username`; and
- role equal to `admin` or `user`.

An HTML SPA fallback with status 200 therefore becomes a typed unavailable state rather than an anonymous session.

The policy uses at most three attempts for transient network, timeout, malformed-body, 429, or 5xx failures, with short bounded backoff. A 401 is never retried and immediately means anonymous. Each request has a finite timeout.

Initial bootstrap states are explicit:

- `checking`: no login or dashboard decision yet;
- `authenticated`: render the dashboard;
- `anonymous`: render the public sign-in experience; and
- `unavailable`: render a branded error explaining that the library could not be reached, with Retry.

After Plex, Apple, passkey login, or passkey registration reports success, the SPA calls the same session reader. It commits the session only when `/api/me` returns the expected subject. If the cookie is absent or cannot be confirmed after bounded retries, the UI reports that sign-in completed but the session could not be established, instead of briefly rendering an identity that protected requests cannot use.

### Provider-aware UI state

The sign-in state records the active provider (`plex`, `apple`, `passkey-login`, or `passkey-register`) along with phase and error. Login operations remain serialized because they all write the same browser session cookie, but each control renders progress copy only for its own provider.

Plex attempt cleanup is centralized. A future provider-switch affordance can safely call that cleanup; this incident patch does not make two cookie-setting ceremonies run concurrently.

The duplicated hero/footer blocks may both offer entry points, but a single attempt must not produce misleading provider labels. Error rendering is deduplicated where both blocks are simultaneously visible.

### Browser session lifecycle and protected requests

Session truth is reconciled across tabs with `BroadcastChannel`, focus, and `pageshow` (including back/forward-cache restoration). Notifications carry no identity or credential. Remote logout and expiry invalidate the current attempt generation, clear protected caches, and defer provider discovery until the anonymous state is settled.

All protected API wrappers preserve the HTTP status and typed error code. React Query and locally caught imperative requests feed one debounced expiry notifier. The notifier accepts only `status === 401` with the edge-auth `unauthenticated` code. Upstream Sonarr, Radarr, Plex, recommender, and media-core authentication failures are normalized at their server proxy boundary so they remain integration failures, not browser-session events.

This design deliberately revalidates rather than immediately destroying local state: the expiry signal asks `/api/me` for bounded confirmation, and only a confirmed anonymous result clears the session. A transient control-plane failure remains the explicit unavailable state.

### Operational visibility

Structured auth events must answer these questions without exposing sensitive data:

- Which provider and phase failed?
- Was the terminal server-observable outcome authorized, denied, invalid, rate-limited, or transient?
- Which limiter scope rejected the request?
- How long did the attempt take?
- Which request ID correlates the event with the existing access log?

Normal Plex pending polls emit no auth-outcome event: they are non-terminal, occur about 24 times per
minute per healthy attempt, and would turn an operational signal into noise plus a PIN-correlation side
channel. Client-only cancellation and expiry likewise remain browser lifecycle state rather than being
invented as server outcomes.

The service should emit a boot-time auth posture summary containing booleans and effective public configuration only: enabled providers, `serveSpa`, trusted-client-header mode, normalized allowed origins, WebAuthn RP ID, and WebAuthn origins. Secrets and raw administrator identities are excluded.

The same provider and WebAuthn inputs must pass through every supported Compose surface and appear in the production environment template. A contract test compares the environment consumed by `env.ts` with the root and self-host deployment surfaces so a provider cannot be enabled in source but silently absent in production.

For first-owner source policy, the Cloudflare topology reads `CF-Connecting-IP` only when trusted-header mode is enabled and the backend is not directly reachable; Cloudflare documents that a Tunnel origin otherwise sees the `cloudflared` process address. Tailscale Serve remains a tailnet-private path and supplies anti-spoofed identity headers, while public Funnel is a different posture. See [Cloudflare Tunnel connectivity](https://developers.cloudflare.com/cloudflare-one/networks/connectivity-options/) and [Tailscale Serve identity headers](https://tailscale.com/docs/features/tailscale-serve#identity-headers).

## Immediate authorization hardening design

### Decouple claimability from provider configuration

The current `isAuthzBootstrapped()` concept carries two incompatible meanings:

1. whether normal login may fall open; and
2. whether first-owner setup-token claim is still available.

They must be separate predicates.

Normal login is fail-closed whenever a verified identity lacks `ADMIN_SUBS` membership or an active member row. Provider configuration never grants membership. Plex server-share auto-admission remains an explicit verified bootstrap path.

Owner claimability depends on durable administrator/ownership state, not enabled providers or ordinary membership:

- no claimed setup marker;
- no durable administrator member or currently configured administrator bootstrap identity; and
- no completed owner claim.

Therefore merely Plex-, Apple-, or Google-configured installs remain claimable by setup token until an owner exists, while direct provider login cannot fall open. A Plex server identifier and a server-shared user row do not close setup by themselves. An exact, stable `ADMIN_SUBS` bootstrap identity closes setup while configured. The legacy username-only `ADMINS` list does not: an `ADMINS`-only upgrade remains claimable until that administrator successfully proves its Plex identity and passes normal authZ, at which point the request seals the durable `setup_claimed_by` marker without changing the member role. Losing or removing the environment entry after a proven login cannot reopen setup, while the existing operator-controlled demotion/removal semantics remain intact. Configuration alone never writes ownership state, and a failed or authorized-but-denied login never seals it. Existing production is unaffected because it already has durable administrator rows.

Release notes must call out that any self-host relying on the old rowless provider fall-open behavior will need to claim the server, use verified Plex-server share admission, or receive an invite. A legacy `ADMINS`-only operator should sign in promptly after upgrade; boot may print a fresh setup token until that first authorized administrator request writes the marker and burns the token. That is an intentional closure of an authorization bypass, not a provider outage.

### Atomic passkey invite redemption

The normal invite-based registration path wraps `authorizeOrRedeem` and `persistCredential` in one outer database transaction, mirroring the first-owner claim path. Better SQLite transaction nesting is exercised explicitly because `redeemInvite` already owns an inner transaction/savepoint.

Required crash-window test:

1. issue a single-use invite;
2. verify a registration enough to reach persistence;
3. inject a credential-insert failure;
4. assert that the member row does not exist; and
5. assert that the invite remains usable.

The success and denial ordering tests remain: authentication proof first, authorization second, credential persistence last, session mint only after commit.

### Google member schema repair

Add a forward migration that rebuilds the `members` table with `google` in the `auth_mode` constraint. Do not edit migration 0003: existing databases have already recorded its checksum and would keep the old constraint.

The migration must preserve every column, active/revoked row, role, timestamp, and index behavior. Because the project migration runner gates `DROP TABLE`, the selected migration keeps the renamed pre-Google table as a recoverable backup and creates/copies into the corrected canonical table. A later maintenance migration may remove that backup only after the normal backup workflow is proven. Fresh databases and upgraded databases must both pass a real issue-invite → redeem-as-Google → member-read test.

### Browser-origin enforcement on native bootstrap paths

The native exception applies only when all are true:

- the request has no cookie;
- the request has no `Origin`; and
- the path is an enumerated native bootstrap path.

If `Origin` exists, the normal same-host/allowlist check runs. This preserves ordinary URLSession bootstrap while preventing a hostile web origin from using a cookie-setting provider endpoint. Cookie-bearing and bearer-plus-cookie requests remain gated as before.

### Consistent durable administrator policy

Bearer reconciliation uses the same exact-sub active member role fallback as cookie reconciliation after the environment policy is evaluated. A self-chosen username or handle still cannot grant administrator access.

Every successfully authenticated identity whose effective role is administrator—whether from `ADMIN_SUBS`, legacy Plex `ADMINS`, or an existing administrator row—must leave durable ownership evidence before its cookie or bearer token is minted. This is the one-way ownership seal: a stable configured sub or durable administrator row can prevent a competing setup claim, but identity proof plus normal authZ are required before the immutable setup marker is written. The marker does not promote or re-grant the member row, so removing a legacy `ADMINS` entry still demotes that member on the next request. A durable administrator row remains ownership evidence even when later revoked, so revocation cannot reopen first-owner setup.

Passkey login uses the same `memberStatus` authorization verdict as every provider, cookie reconciliation, and bearer reconciliation. A rowless identity can pass only through an exact `ADMIN_SUBS` match and must resolve to administrator before any session is issued; a missing ordinary member row, revoked row, or failed WebAuthn assertion remains denied.

Verified Plex-server share admission grants ordinary membership only. It always persists `role='user'`; legacy `ADMINS` is applied as removable runtime policy after final authZ, and a resulting administrator seals ownership before credential issuance. Removing `ADMINS` therefore demotes the session on the next reconciliation without reopening setup.

`ADMIN_SUBS` is an immutable environment-level authority and intentionally takes precedence over a database revocation on every surface. Removing a configured owner therefore requires removing the exact sub from `ADMIN_SUBS`, restarting/redeploying so policy reloads, and then revoking any member row. The durable ownership marker remains, so removing access cannot reopen first-owner setup.

Member revocation rejects:

- any immutable `ADMIN_SUBS` owner;
- the current caller's own sub; and
- a target DB administrator when it is the final active administrator across durable admin rows and unique `ADMIN_SUBS` identities.

The count and revoke decision must be transactional so two administrators cannot concurrently remove the final two. Re-inviting a revoked administrator preserves the stored administrator role unless a future explicit demotion feature is added.

## Verification strategy

### Unit and route tests

- Two different PINs from one trusted client address can each sustain normal polling without a 429.
- A single PIN is rejected after its 60/minute limit.
- A trusted client address is rejected only at the 300/minute backstop.
- The global 600/minute ceiling remains effective.
- `Retry-After` is present and parseable.
- Google-only configuration cannot admit an unlisted identity.
- Apple-only and Google-only installations remain setup-token claimable.
- Provider configuration does not itself prove ownership.
- `PLEX_CLIENT_ID` alone simultaneously leaves setup claimable and keeps normal Plex login fail-closed.
- Credential persistence failure rolls back invite usage and membership.
- A migrated database accepts and returns a Google member while preserving all pre-existing rows.
- A hostile browser Origin is rejected on every cookie-setting bootstrap endpoint even without a cookie.
- Originless native bootstrap remains allowed.
- DB-backed owner role is identical for cookie and bearer sessions.
- A proven `ADMIN_SUBS` or legacy `ADMINS` login seals the durable ownership marker without promoting its member row; removing the environment entry on restart does not reopen setup and preserves legacy demotion behavior.
- A failed provider proof never seals ownership, and a revoked administrator row keeps setup closed without granting access.
- Passkey, Plex, Apple, Google, cookie, and bearer surfaces agree on the shared member authorization verdict; a rowless ordinary passkey identity cannot be admitted.
- Plex-server share admission stores ordinary membership; a legacy `ADMINS` match seals at runtime, fails closed on marker-write error, and demotes after configuration removal while ownership stays closed.
- Self-revoke and last-admin revoke return conflict without changing the row.

### React/client tests

- No two Plex checks overlap when the first response is slow.
- A 429 schedules from `Retry-After` and does not render a terminal error.
- Transient 5xx/network failures back off and terminate after the bounded budget.
- A late response from a cancelled generation cannot sign the user in.
- A successful provider response is not rendered until `/api/me` confirms the same subject.
- Cookie rejection (`/api/me` 401 after provider success) produces actionable failure copy.
- Initial `/api/me` 401 renders sign-in.
- Initial `/api/me` 500, network failure, malformed 200, and timeout render unavailable with Retry—not sign-in.
- Provider-specific labels do not say Plex is pending during a passkey attempt.
- A protected `401 unauthenticated` from either React Query or an imperative request produces one coalesced expiry signal and one bounded `/api/me` confirmation.
- `403 unauthenticated`, `401` with another code, and normalized upstream authentication failures do not announce browser-session expiry.
- Remote logout, focus restoration, and BFCache restoration cannot retain protected query/provider state or resurrect an older login generation.

### Browser/integration tests

- A mocked popup flow exercises pending, Retry-After, authorized, and `/api/me` confirmation through the rendered app.
- A real self-host WebAuthn flow covers invite fragment handoff, fragment scrubbing, passkey registration, cookie session, `/api/me`, and single-use invite behavior.
- A post-deploy synthetic check verifies the canonical apex origin can perform a credentialed API round-trip without logging or storing a real credential.
- Live verification starts at least two simultaneous unauthenticated Plex PIN polls behind one address long enough to cross the old 60/minute threshold and confirms zero 429 responses.

Real operator/member login is not required for the synthetic checks and must not be performed without the operator's explicit credential authorization.

## Release risk register

| Risk | Preventive control | Release evidence | Residual action |
|---|---|---|---|
| Two household logins share one public IP | Single-flight 2.5-second polling plus PIN/client/global budgets | Concurrent-PIN route test and post-deploy two-flow synthetic | Alert on limiter scope; never solve by removing the client/global ceilings. |
| Provider says success but cookie is absent | Provider result is provisional until matching `/api/me` | DOM and rendered browser tests for every cookie-setting flow | Diagnose cookie/origin posture from the redacted boot row. |
| API outage looks like logout | Only explicit 401 is anonymous; bounded unavailable state otherwise | Network/5xx/malformed/timeout auth tests | Track unavailable outcomes separately from denied/expired outcomes. |
| Upstream credentials expire | Proxy upstream 401 as typed integration failure | Arr/media proxy route tests and client no-expiry tests | Show integration repair copy without clearing the browser account. |
| Cross-tab/focus bursts loop `/api/me` | One tokenless channel, attempt generations, shared debounce | Lifecycle and cross-source coalescing tests | Sample confirmation latency and superseded attempts. |
| Fresh install becomes ownerless or setup reopens | Stable `ADMIN_SUBS` intent blocks competing setup; successful effective-admin login seals an immutable ownership marker without changing role; revoked admin rows keep the door shut | Provider-configured, user-only, `ADMIN_SUBS`/legacy `ADMINS` login→config-removal, role-demotion, token-burn, and revoked-admin restart tests | Add an explicit owner-recovery grant in the passkey-recovery milestone. |
| Public proxy looks like loopback during owner claim | Trusted proxy client address precedes socket address | Public/private/spoofed-header route tests in both trust modes | Tailscale Serve remains private; Funnel/other public exposure requires explicit remote-claim posture. |
| Invite is burned without a credential | One outer database transaction | Injected credential-write failure rollback test | Preserve DB backup and migration checks before rollout. |
| Auth config exists in code but not deployment | Compose/template contract plus boot posture | Contract test over both Compose surfaces | Fail deployment before container recreation. |
| Split-origin drift breaks cookies/WebAuthn | Exact configured origins and RP validation | Canonical-origin CORS/CSRF/passkey synthetics | Remove the class through the L2 single-origin milestone. |
| A black-holed provider request wedges every login control | Attempt-scoped abort plus bounded fetch legs; Plex deadline includes setup | Never-settling fetch and second-attempt DOM regressions for every provider | Track timeout outcomes separately from credential denial. |
| A shared-device account switch races a secret mutation | Subject-scoped cache, generation/abort guard, and expected-sub server binding | Mid-migration principal-flip test proves no cross-principal write, cache update, or local deletion | Keep every future per-member mutation explicitly bound to its initiating principal. |
| Auth failures cannot be diagnosed safely | Closed structured outcome schema with request ID, rounded duration, and a strict field allowlist | Exactly-once/redaction tests across all terminal provider seams; pending polls produce no event | Alert on bounded outcome counts without adding identity or credential fields. |

## Rollout and rollback

1. Land the incident tests red, implement the polling/limiter/session/UI repair, and verify it independently.
2. Land the authorization, first-owner, passkey, deployment, and lifecycle hardening as separately reviewable slices; then rebuild and retest their integrated result from a clean process.
3. Create and verify a fresh production database snapshot before rollout. Record only its timestamp/file count, never identity rows.
4. Build and deploy through the repository's NAS-safe workflow; never run a raw compile in the NAS application path.
5. On boot, apply the forward-only Google auth-mode migration. It preserves the pre-migration members table as a recovery copy; do not edit the applied migration or treat application rollback as schema rollback.
6. Verify health, release identity, auth methods, cookie/CORS/CSRF posture, two-flow limiter behavior, session-unavailable behavior, migration state, and redacted container logs.
7. Watch redacted terminal auth outcome counts for at least one normal login window. Invalid credential-free synthetics may prove event shape; a real member/provider ceremony requires explicit operator authorization. Application rollback is code/config rollback; database restoration uses the normal backup workflow only.

Rollback triggers include new 401 loops, repeated session-confirmation false negatives, limiter saturation below the documented envelope, or a setup state that is neither claimable nor owned.

## Best-in-class future state

The immediate repair follows the current guidance in [NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html), [WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/), the [OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700.html), and the [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html). The staged roadmap is intentionally ordered so recovery and observability arrive before a larger session-store migration.

### 1. Single browser origin

Route `/api/*` through the canonical web origin or serve the SPA from the backend. This removes cross-origin cookies and CORS from browser auth, allows host-only `SameSite=Lax` cookies, simplifies same-host CSRF enforcement, and lets the WebAuthn RP derive from one canonical origin. Before migration, prove that the edge preserves the public Host and scheme.

### 2. Passkey-first with recovery

Support multiple credentials per member, credential naming/removal, recovery using a separately verified provider or owner-issued recovery grant, and clear last-credential safeguards. Keep Plex as an optional bootstrap/recovery provider rather than the only path.

Never merge identities from matching email/display-name claims alone. Linking a provider to an existing member requires a live authenticated session plus fresh proof from the provider (and step-up user verification for administrator identities). Recovery grants are single-use, short-lived, audience-bound, redacted, and cannot elevate role or bypass the durable members policy. Provider authorization-code flows use exact redirect matching, state/nonce, and PKCE S256; tokens remain server-side or in HttpOnly cookies rather than browser storage.

The WebAuthn design continues to require discoverable credentials and user verification, aligned with [Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/).

### 3. Session lifecycle hardening

Add explicit idle and absolute expiry policy, session renewal after privilege changes, `Cache-Control: no-store` on session-bearing responses, and lifecycle telemetry. These follow the [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

High-impact administrator actions (role/membership changes, recovery issuance, credential removal, and global sign-out) require recent user verification. Session and recovery telemetry records only opaque correlation identifiers and outcomes; it never contains provider assertions, credential IDs, invite/recovery material, or account subjects.

Server-side session generation/revocation should be introduced only if true browser-wide revocation, device inventory, or a shorter stolen-cookie window becomes a requirement. At household scale, the current per-request membership reconciliation already provides most of the authorization-revocation value.

### 4. Defense in depth

- Roll out a report-only CSP, inventory Apple/font/API/media/worker dependencies, then enforce `default-src`, `script-src`, `connect-src`, `object-src 'none'`, `base-uri`, and `form-action`.
- Restrict native cookieless CSRF bypasses to an explicit device-pair bootstrap contract rather than every matching auth path.
- Normalize allowed origins and fail fast at boot on internally inconsistent split-deploy WebAuthn configuration.
- Add provider variables to both Compose surfaces and environment examples, then contract-test them against the provider inputs consumed by `env.ts`.
- Add a small Firefox/WebKit auth smoke tier while keeping CDP virtual-authenticator tests Chromium-specific.
- Continue provider and identity throttling consistent with the [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

### Delivery milestones and exit criteria

| Milestone | Deliverable | Exit criteria |
|---|---|---|
| L1 — reliability baseline | The incident repair, cross-provider authorization symmetry, and ownership hardening in this release | Two same-address Plex attempts cross the former limit without local 429; every provider confirms through `/api/me` and the shared member verdict; full unit, integration, browser, configuration-contract, and production synthetic checks are green. |
| L2 — single-origin auth | Canonical `/api/*` proxy, host-only cookie, same-host CSRF, canonical WebAuthn RP | Forwarded host/scheme are proven; cross-origin auth CORS is removed; Lax-cookie and CSRF tests pass at the public origin; rollback is rehearsed. |
| L3 — passkey-first recovery | Multiple named passkeys, last-credential guard, separately verified recovery, credential inventory | Losing one authenticator cannot orphan an account; recovery cannot bypass membership or owner policy; backup/sync state is visible without treating it as proof of user verification. |
| L4 — hardened lifecycle | Idle/absolute expiry, privilege-change renewal, no-store responses, CSP enforcement, Firefox/WebKit smoke | Expiry/revocation is observable and bounded across tabs/devices; report-only CSP has zero unexplained violations before enforcement; all three browser engines pass the login smoke tier. |
| L5 — session-store decision | Evidence-based decision record, not an assumed rewrite | Add server-side sessions only if measured requirements demand browser-wide revocation, device inventory, or a shorter stolen-cookie window; otherwise retain the simpler encrypted-cookie model. |

## Out of scope for this incident

- Replacing JWE sessions with OAuth access/refresh tokens.
- Migrating existing identities or credentials.
- Running Apple/Google ceremonies with real user accounts.
- Redesigning the public walkthrough.
- Treating provider availability as authorization.
