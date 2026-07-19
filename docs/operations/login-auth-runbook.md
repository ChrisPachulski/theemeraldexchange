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

Authorization is separate from authentication. Normal login requires an immutable `ADMIN_SUBS`
entry, an active member row, invite redemption, or the explicit configured-Plex-server share
path. Provider configuration and fresh-install state never grant access. First ownership uses the
host-protected setup-token passkey ceremony.

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

## Rollout and rollback signals

Rollback is warranted for a new `/api/me` revalidation loop, provider-success/session-confirmation
false negatives, limiter saturation below the documented envelope, a setup state that is neither
owned nor claimable, or any unredacted login artifact. Database migrations are forward-only; do
not edit an applied migration or restore a database without the normal backup workflow.

## Best-in-class roadmap

1. Route `/api/*` through the canonical web origin. Prove forwarded host/scheme first, then use a
   host-only `SameSite=Lax` cookie and remove browser CORS from the auth path.
2. Make passkeys primary: allow multiple named credentials per member, prevent removal of the
   final credential, and add recovery through a separately verified provider or owner-issued,
   short-lived recovery grant.
3. Add explicit idle and absolute session expiry, renew after privilege changes, and mark every
   session-bearing response `Cache-Control: no-store`. Introduce server-side session state only
   if browser-wide revocation or a materially shorter stolen-cookie window justifies it.
4. Roll out CSP in report-only mode, inventory Apple/Google/WebAuthn/worker/media dependencies,
   then enforce it with `object-src 'none'`, `base-uri`, and `form-action` restrictions.
5. Keep Chromium virtual-authenticator coverage and add small Firefox/WebKit login smoke tiers.
6. Replace broad originless native-bootstrap exemptions with one explicit device-pair contract.
