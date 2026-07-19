# Login and authentication runbook

This is the operator contract for browser login, native pairing, session truth, and the
owner-controlled members allowlist. It deliberately contains no credential values, provider
subjects, invite codes, PINs, cookies, or example bearer tokens.

## What “logged in” means

A provider response is not browser-session truth. Plex, Apple, Google, and passkey flows may set
the encrypted HttpOnly cookie, but the SPA commits the identity only after a credentialed
`GET /api/me` returns the same namespaced subject.

Only an explicit `/api/me` `401` means anonymous. A timeout, network failure, `429`, `5xx`, HTML
fallback, or malformed JSON means the session is unavailable and should offer Retry. It must not
flash the public sign-in screen.

Every credential-setting provider network leg is bounded and belongs to one attempt-scoped abort
signal. Non-interactive setup and verification legs have a 15-second request timeout; Plex checks are
also bounded by the five-minute total attempt deadline. Timeout, cancellation/replacement, unmount, and
sign-out release the shared login guard; none may leave all provider controls disabled until a reload.
The interactive operating-system WebAuthn ceremony is not subject to the network timeout. Logout clears
local protected state even when its server request times out, then a later `/api/me` reconciles the
server cookie.

Authorization is separate from authentication. Normal login requires an immutable `ADMIN_SUBS`
entry, an active member row, invite redemption, or the explicit configured-Plex-server share
path. Provider configuration and fresh-install state never grant access. First ownership uses the
host-protected setup-token passkey ceremony.

`ADMIN_SUBS` is an immutable environment-level authority and takes precedence over a database
member revocation on every login/session surface. To remove one, delete the exact sub from
`ADMIN_SUBS`, restart or redeploy so policy reloads, then revoke any remaining member row. The
durable ownership marker keeps setup closed; it does not preserve the removed administrator role.

## Lost owner credential recovery (break glass)

Use this only when setup is already sealed and no active administrator credential can authenticate.
It does not reopen first-owner setup, and the setup marker or migration tables must never be edited as
a recovery shortcut.

1. Take the normal server database and deployment-configuration backup before changing authority.
2. Choose a configured provider identity whose cryptographic/provider proof the owner can still
   complete. Establish its exact namespaced subject (`plex:`, `apple:`, or `google:`) from a controlled
   provider/operator source; never derive it from a display name or email and never paste it into logs or
   tickets. A lost passkey identity is intentionally absent: without its credential it cannot prove the
   existing `local:` subject, and a fresh registration creates a different subject.
3. Add only that exact subject to `ADMIN_SUBS` in the deployment source of truth, then use the normal
   guarded restart/deploy so policy reloads. Do not enable remote setup or resurrect a setup token.
4. Complete that provider login and verify `/api/me` reports the expected administrator, setup remains
   `claimable:false`, and exactly one correlated `authorized` auth outcome is emitted.
5. From the recovered administrator session, create and test a replacement through the normal
   member/invite/passkey workflow. Invite redemption creates a `user`; there is no database-role promotion
   endpoint.
6. Add the replacement's now-known exact subject to `ADMIN_SUBS` while retaining the original break-glass
   subject, then guarded-deploy and verify the replacement can authenticate as administrator with
   setup still sealed.
7. Only after that proof, remove the original subject in a second guarded deployment. Verify the
   replacement administrator again, then revoke any remaining row for the original subject. Never leave
   the deployment without at least one tested administrator authority.

If the exact provider subject cannot be established or no configured provider proof remains possible,
stop and restore through the normal backup/operator process; do not guess an identity or patch the live
database. The L2 recovery milestone replaces this manual path with multiple credentials and a separately
verified, short-lived recovery grant.

## Plex polling and rate limits

The browser owns one completion-scheduled poll loop per attempt. It waits 2.5 seconds after a
completed pending response, honors `Retry-After`, backs off bounded transient failures, and never
overlaps checks. Closing the popup keeps a short propagation grace window; cancellation and
replacement abort the old request and make late results inert.

| Scope | Limit | Expected use |
|---|---:|---|
| One PIN | 60/min | A healthy attempt uses about 24/min. |
| Trusted client address | 300/min | Household concurrency backstop. |
| Server global | 600/min | Resource ceiling across all clients. |

`rate_limited` is a local limiter response. `plex_rate_limited` is upstream Plex backpressure.
Both return `429` and a browser-readable `Retry-After`; neither is a terminal credential failure.

## Safe triage

1. Check `/api/health`, `/api/version`, and `/api/auth/methods` from the canonical browser origin.
2. Find the single boot row tagged `authentication posture`. Confirm provider booleans,
   same-origin/split-origin mode, trusted-header mode, allowed origins, and WebAuthn RP settings.
   `request-derived` means same-origin passkeys bind to the checked request host/origin;
   `configured` means the logged RP values are used. Any `invalid_origin` or `invalid_rp_id` is a
   configuration failure, not a harmless redaction.
3. Correlate terminal auth events by request id and provider/outcome. Never add PIN, invite,
   identity, IP, token, assertion, or cookie fields while debugging.
4. For repeated local `429`s, identify the limiter scope. Normal two-user polling must fit below
   the client backstop. For `plex_rate_limited`, confirm the SPA waits for `Retry-After`.
5. If a provider reports success but the UI refuses entry, inspect the subsequent `/api/me`
   status. A `401` means the cookie was not established; transient statuses mean reachability or
   split-origin cookie/CORS configuration.
6. If passkeys fail before the OS prompt, compare the exact browser origin with
   `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGINS`. WebAuthn requires HTTPS except for localhost.

Expected redactions cover inbound legacy login query fields, outbound Plex PIN URLs, Sentry
events/breadcrumbs, and cascade-revocation bookkeeping. A raw provider subject or login artifact
in logs is a security incident, not acceptable diagnostic context.

The `auth_outcome` event is a closed operational contract: provider, phase, terminal outcome,
low-cardinality reason/scope when applicable, request id, and rounded elapsed milliseconds only. Normal
Plex pending polls intentionally emit no outcome event. Exactly one event is expected for an authorized,
denied, invalid, rate-limited, or transient terminal request; free-text context and
identity-derived correlation fields are forbidden.

No paging or threshold alert is attached to `auth_outcome` yet; the events are forensic until the L3
auth-detection milestone lands. Until then, inspect them after every auth incident and production auth
rollout rather than assuming they are actively watched.

Per-member settings caches include the provider subject in their internal cache key. Secret-setting
mutations also carry an expected-sub binding that the authenticated route checks before writing or
deleting, so a shared-device account switch cannot redirect an in-flight migration to the next member.

## Deployment configuration

Both root and published self-host Compose files pass the same provider/authz inputs:
`ADMINS`, `ADMIN_SUBS`, Plex client/server ids, Apple and Google client ids plus enable guards,
the emergency unscoped-Plex boot flag, all WebAuthn RP fields, and `SETUP_ALLOW_REMOTE`. The Plex
flag only permits a Plex-configured production process to boot without a server id; it never
overrides a member/provider gate. Remote first-owner claim stays off by default. Enable it only to
claim through a trusted remote tunnel, and return it to `0` afterward; the one-time setup token is
still mandatory. Contract tests fail when an input consumed by the backend disappears from a
Compose surface or its environment example.

The root Cloudflare topology trusts `CF-Connecting-IP`/`True-Client-IP` because the backend is
loopback-only and reachable through cloudflared; first-owner setup resolves those headers before
the private container socket, so a public visitor stays public and is blocked. Self-host does not
trust forwarded headers by default, so a client cannot spoof a private address. The supported
Tailscale Serve profile remains inside the allowed `100.64.0.0/10` private set. Tailscale Funnel
is not a supported first-claim path: use a proxy with an unambiguous trusted client-IP header or
the short-lived `SETUP_ALLOW_REMOTE=1` override, then return it to `0`. Setup does not consume
`X-Forwarded-For` because neither deployment defines a validated proxy-hop chain.

Plex is optional in the NAS preflight; `PLEX_SERVER_ID` is validated only when a
`PLEX_CLIENT_ID` is configured. Test-only server helpers are excluded from both the Docker build
context and the curated NAS rsync payload, so authentication fixtures cannot enter a production
image or host tree.

Self-host serves the SPA and API from one origin by default. The owner deployment remains split
origin until its edge routes `/api/*` through the canonical web host; it therefore requires an
exact `ALLOWED_ORIGINS` list and uses the cross-site cookie posture reported at boot.

In that owner topology, `/api/version` may report `schemas.exchange: {"present":false}` because the
recommender database volume is deliberately mounted only into `exchange-recommender`, not the backend
that serves the version probe. Treat recommender container health and its own migration verification as
authoritative; this field is not the server/auth migration state.

## Rollout and rollback signals

Rollback is warranted for a new `/api/me` revalidation loop, provider-success/session-confirmation
false negatives, limiter saturation below the documented envelope, a setup state that is neither
owned nor claimable, or any unredacted login artifact. Database migrations are forward-only; do
not edit an applied migration or restore a database without the normal backup workflow.

## Best-in-class roadmap

- **L2 — Passkey recovery:** allow multiple named credentials per member, prevent removal of the final
  credential, and add recovery through a separately verified provider or owner-issued, short-lived
  recovery grant.
- **L3 — Auth detection:** alert on sustained low-cardinality `denied`, `rate_limited`, and `transient`
  outcomes, and keep a credential-free login/session-confirmation synthetic. Pending polls and identity
  fields stay out of event and alert dimensions.
- **L4 — Single-origin auth:** route `/api/*` through the canonical web origin. Prove forwarded
  host/scheme first, then use a host-only `SameSite=Lax` cookie and remove browser CORS from the auth path.
- **L5 — Hardened lifecycle:** add idle and absolute session expiry, renew after privilege changes, mark
  session-bearing responses `Cache-Control: no-store`, enforce CSP after a clean report-only period, add
  Firefox/WebKit smoke tiers, and replace broad originless native-bootstrap exemptions with one explicit
  device-pair contract.
- **L6 — Session-store decision:** introduce server-side session state only if browser-wide revocation,
  device inventory, or a materially shorter stolen-cookie window justifies it.
