
# Teaching Dossier: Sign in with Apple + Device-Pair Bearer Flow

---

## 1. WHAT

Sign in with Apple (SIWA) and the device-pair bearer flow are the two ways a native iOS/tvOS/macOS client proves who it is to theemeraldexchange's backend. When a user taps "Sign in with Apple," Apple's servers produce a short-lived cryptographically-signed token called an identity token — a compact JWT. The backend receives this token, verifies the signature against Apple's public keys (fetched from the internet), confirms the token was minted for this specific app, and — if the user is invited — creates a session. For native apps, a cookie-based session is awkward (phones don't manage browser cookies reliably), so instead the backend mints a long-lived encrypted bearer token (a JWE) that the app stores securely in the device Keychain. Every future API request from the app includes this bearer token in an `Authorization: Bearer ...` header, and the backend decrypts it to identify the user without any cookie.

---

## 2. WHY

### Why a separate device flow at all?

Browsers manage cookies transparently and enforce `SameSite` rules. Native apps (iOS, tvOS) do not have a browser cookie jar. If the backend relied on cookies, the native app would have to manually carry and rotate cookies, and the `SameSite=None` cookies required for the Netlify-SPA-to-NAS-API split become useless in a URLSession context. A long-lived bearer JWE stored in the iOS Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` is the platform-idiomatic credential. The tradeoff: 180-day lifetime (vs. 30-day cookie) means revocation must be explicit — handled via the `device_token_revocations` table rather than natural cookie expiry.

### Why does SIWA verification pin each field? (why-chained)

**`algorithms: ['RS256']`** — Apple signs tokens using RSA with SHA-256. Without this pin, an attacker can craft a token with `"alg":"none"` (no signature required) or `"alg":"HS256"` and use the RSA public modulus as an HMAC secret — a well-documented attack class. Pinning to RS256 causes the jose library to reject anything else before touching the signature.

**`issuer: 'https://appleid.apple.com'`** — The `iss` (issuer) claim says who created the token. Without pinning it, a token from any JWT-issuing service could be replayed as a SIWA token. Pinning `iss` means only genuine Apple-minted tokens pass.

**`audience: env.APPLE_CLIENT_ID`** — The `aud` (audience) claim says which app the token was meant for. Without it, a token minted for a different developer's Apple app (or a different bundle ID) could be replayed here. If `APPLE_CLIENT_ID` is unset, the verifier fails closed and returns `not_configured` rather than verify against an empty audience (which would accept every token ever made by Apple for anyone).

**`exp` with 60s clock skew** — Apple identity tokens are short-lived (typically minutes). Enforcing expiry means a stolen token replayed hours later is rejected. The 60-second tolerance is tight enough to block replay while tolerating minor server/device clock drift.

**`nonce` (constant-time compare)** — A nonce is a one-time random value the client generates, hashes, and embeds in the SIWA request. If the returned token doesn't carry back that nonce, someone replayed an old token. The comparison is constant-time (same number of CPU cycles regardless of where the strings differ) to prevent timing oracle attacks that could leak whether a guess is getting "warmer."

**Sub taken only from the verified payload** — The client sends the raw JWT; after cryptographic verification passes, the `sub` claim is extracted from the verified payload and then re-validated through `parseSub`. The server never trusts a client-supplied subject string.

---

## 3. MAP

### Key files

| File | What it does |
|------|-------------|
| `server/services/appleAuth.ts:125` | `verifyAppleIdentityToken` — the SIWA verifier; all five pins happen here |
| `server/auth.ts:469` | `POST /api/auth/apple` — receives the identity token, calls the verifier, runs the authZ gate, sets a session cookie |
| `server/routes/device.ts:48` | `POST /api/auth/device/poll` — the pairing endpoint; exchanges a Plex PIN for a bearer JWE |
| `server/session.ts:192` | `mintDeviceToken` — encrypts device claims into a JWE via the Rust `emerald-contracts` crate |
| `server/session.ts:272` | `verifyDeviceToken` — decrypts and validates a bearer JWE |
| `server/middleware/deviceTokenAuth.ts:46` | `tryBearerAuth` — the per-request bearer extraction and validation called by every protected route |
| `server/middleware/auth.ts:39` | `loadReconciledSession` — tries Bearer first, falls back to cookie; this is where the two auth paths merge |
| `server/middleware/csrf.ts:61` | `requireSafeOrigin` + `isBearerOnly` — the CSRF gate that exempts bearer-only requests |
| `server/routes/devices.ts:102` | Self-service device management (`/api/devices/self`) |
| `server/routes/devices.ts:175` | Admin device management (`/api/admin/devices`) |
| `server/migrations/server/0002_device_tokens.sql` | DB schema: `device_tokens` + `device_token_revocations` tables |

### Pairing sequence (Plex-based device pair)

```
Native app                     Backend                    plex.tv / Apple
    |                             |                             |
    |-- GET /api/auth/plex/config  -> { clientId, product }     |
    |                             |                             |
    |-- POST plex.tv/api/v2/pins?strong=true                   |
    |   (app uses clientId)        |       <- { id, code }     |
    |                             |                             |
    | show `code` to user, user visits plex.tv/link             |
    |                             |                             |
    |-- POST /api/auth/device/poll                              |
    |   { pinId, device_id, device_name, device_platform }     |
    |                             |-- checkPin(pinId) -------> plex.tv
    |                             |                  <- authToken if authorized
    |                             |-- getUser(authToken) -----> plex.tv
    |                             |                  <- user.id, username
    |                             |-- authorizeOrRedeem()       |
    |                             |   (invite/members gate)     |
    |                             |-- mintDeviceToken()         |
    |                             |   (JWE with 180d TTL)       |
    |  <- { status:'authorized', token (JWE), server_id }      |
    |                             |                             |
    | App stores token + server_id in Keychain                  |
    |                             |                             |
    |-- POST /api/any-protected-route                           |
    |   Authorization: Bearer <JWE>                             |
    |                             |-- tryBearerAuth()           |
    |                             |-- verifyDeviceToken()       |
    |                             |-- reconcileDeviceToken()    |
    |  <- 200 (normal response)   |                             |
```

For SIWA (web or future native Apple-signed login), the device sends `identityToken` to `POST /api/auth/apple` instead of polling a Plex PIN. The verification runs through `verifyAppleIdentityToken`, then converges on the identical authZ gate and sets a **cookie** session (not a bearer JWE — that pairing happens separately via the device poll flow).

---

## 4. PREREQUISITES

A beginner needs to understand these before this material will stick:

**What a JWT is** — A JSON Web Token is a compact, URL-safe string with three dot-separated parts: `header.payload.signature`. The header says which algorithm was used; the payload carries claims (who, for whom, when it expires); the signature proves the payload wasn't tampered with. Anyone can read the header and payload (they're just base64-encoded), but only someone with the right key can produce a valid signature.

**Public-key signatures (ELI5)** — Imagine a padlock that has two keys: one key (the private key) can only lock it; a different key (the public key) can only open it. Apple keeps the locking key secret and locks (signs) each identity token. The backend has the unlocking key (Apple's public key), fetches it from `https://appleid.apple.com/auth/keys`, and uses it to verify the lock hasn't been tampered with. You can freely share the unlocking key — knowing it doesn't let you forge new locks. RS256 is the specific algorithm Apple uses (RSA with SHA-256 hashing).

**What a JWE is** — A JSON Web Encryption token, like a JWT but encrypted. The payload is not readable by anyone without the right decryption key. The device bearer token is a JWE: it's encrypted with an AES-256-GCM key derived from `DEVICE_TOKEN_SECRET` (a server-side secret). Contrast with Apple's identity token which is a plain JWT (signed but not encrypted — Apple's payload is intentionally readable; only the signature needs protecting).

**What CSRF is** — Cross-Site Request Forgery: a hostile web page tricks your browser into making a request to a different site, and your browser helpfully includes any stored cookies for that site. The defense in this project is checking the `Origin` header, which the browser always sets on cross-origin requests. Bearer tokens are immune: the browser never auto-attaches an `Authorization` header, so a forged cross-origin page can't ride a victim's bearer token.

**The invite/members gate** — theemeraldexchange is invitation-only. Proving identity (SIWA signature valid, Plex PIN redeemed) is not sufficient. The user must also be in the `members` table or provide a valid `invite_code`. Both the SIWA route and the device poll route run this identical check after identity is confirmed.

---

## 5. GOTCHAS & WAR STORIES

**The CSRF Origin-gate 403'd every device write (commit b3b692c)**

The backend uses session cookies with `SameSite=None` because the Netlify SPA and the NAS API live on different origins. That makes the cookies attachable by any cross-site request — a classic CSRF vector. The fix was a global `requireSafeOrigin` middleware that checks the `Origin` header on all state-changing methods (POST/PUT/PATCH/DELETE).

The war story: when native iOS/tvOS app writes were first wired up, they all returned 403. The app correctly sent `Authorization: Bearer <JWE>` with no cookie. But the CSRF middleware ran before the auth middleware and rejected the request for missing/wrong `Origin` — it had no idea the request was bearer-authenticated and therefore safe.

The fix (`server/middleware/csrf.ts:38`, the `isBearerOnly` function) exempts requests that carry a Bearer token AND no Cookie header. The security argument: CSRF exploits browser auto-attachment of cookies. A request with no cookie has no ambient credential to forge. A browser page cannot set `Authorization: Bearer` automatically — it requires explicit JavaScript. So if there's no cookie, there's no CSRF vector, and the Origin check is moot. The critical detail: a request carrying BOTH a bearer and a cookie is still gated — the cookie remains a CSRF vector even if the bearer is also present.

**PIN creation happens on the device, not the server**

An earlier design created the Plex PIN server-side. This caused plex.tv's security alert confirmation page (the one shown to users at `plex.tv/link`) to display the NAS's home IP address and geolocation, leaking the server's home network location to every user who paired a device. The fix is documented in `server/routes/device.ts:1-31`: the app fetches `clientId` from the backend, creates the PIN directly against `plex.tv` from the device, and only sends the resulting `pinId` to the backend. plex.tv attributes the PIN to the device's IP, not the NAS's.

**Apple only sends email on the first authorization**

SIWA's `email` claim is only present in the identity token on the user's very first sign-in. On subsequent sign-ins, `email` is absent from the payload. The backend handles this in `appleAuth.ts:188`: `email` is read if present but never required. The stable identifier is `sub` (the Apple user identifier, a string like `000000.abc123.1234`), not the email.

**`alg=none` is a real attack class, not theoretical**

JWT libraries that don't pin algorithms have historically accepted tokens with `"alg":"none"` — meaning "no signature required, trust the payload." The jose library defends against this automatically but only if you explicitly pass `algorithms: ['RS256']` to `jwtVerify`. The pin is one line of code but without it the entire SIWA verification is hollow.

**Device token revocation is tombstone-only — the audit trail is preserved**

When a device is revoked (self-revoke, logout-everywhere, or admin revoke), the `device_tokens` row is NOT deleted. An INSERT is made into `device_token_revocations`. This means `last_seen_at`, `issued_at`, and `device_name` remain available for forensics even after the token is dead. The verifier's 4-step check order (JWE decrypts, claims valid, `device_tokens` row exists, jti NOT in `device_token_revocations`) means a restored-from-backup token (whose jti was wiped from the DB by a data-dir wipe) also fails step 3.

---

## 6. QUIZ BANK

**Q1.** A user's Apple identity token has `"alg":"HS256"` in the header and a valid-looking signature. The backend calls `verifyAppleIdentityToken`. What happens and why?

**A1.** The call to `jwtVerify` throws `JOSEAlgNotAllowed` because the verifier pins `algorithms: ['RS256']`. `classifyJoseError` maps this to `invalid_signature`, and the route returns a 401. The attack being blocked is an HS/RS confusion: HS256 uses a symmetric key, and an attacker could use Apple's RSA public key (which is, by definition, public) as the HMAC secret to produce a "valid" HS256 signature over a forged payload.

**Q2.** An iOS app sends `POST /api/movies/123/feedback` with `Authorization: Bearer <valid JWE>` and no `Cookie` header, but without an `Origin` header. Will this succeed or return 403?

**A2.** It will succeed. The CSRF middleware's `isBearerOnly` function returns `true` (Bearer present, no Cookie). The middleware calls `next()` without checking Origin. The rationale: CSRF exploits browser-auto-attached cookies. No cookie means no CSRF vector. Browsers never auto-attach `Authorization` headers.

**Q3.** The device poll endpoint returns `{ status: 'pending' }` repeatedly and never returns `authorized`. The Plex PIN was created successfully and the user has authorized it on plex.tv. What is the most likely root cause?

**A3.** The app probably created the Plex PIN with a different `X-Plex-Client-Identifier` than the `clientId` returned by `GET /api/auth/plex/config`. The backend polls the PIN using `env.plexClientId`; if the PIN was created with a different identifier, `checkPin` either 404s or returns a PIN that never appears authorized to this server. The fix is to always fetch `clientId` from the config endpoint first, then use that same value when calling `plex.tv`.

**Q4.** A device was paired 90 days ago and is currently active. The server admin wipes the database (`data-dir wipe`). The device tries to make a request with its stored bearer JWE. What happens at each step of the 4-step verification?

**A4.** Step 1 (JWE decrypts): succeeds — the encryption key is derived from `DEVICE_TOKEN_SECRET` which survives the DB wipe. Step 2 (claims valid): succeeds — the claims inside the JWE are structurally valid. Step 3 (`device_tokens` row exists): FAILS — the DB was wiped, so the jti no longer has a row. `verifyDeviceToken` returns `null`. The app gets a 401 and must re-pair.

**Q5.** A user signs in with Apple and immediately signs in again from a second device. The second sign-in's identity token payload has no `email` field. Is this a problem?

**A5.** No. Apple only returns `email` on the first authorization. The backend reads it with a conditional (`typeof payload.email === 'string' ? payload.email : undefined`) and treats it as optional. The stable identifier is `sub`, which is always present. The route derives a display name from the email local-part only as a best-effort label, not as a security-critical identifier.

**Q6.** A native app that authenticated via device bearer token calls `GET /api/me`. The response says `username: "Chris's iPhone"`. The user's actual Plex username is `cujo_253`. What happened and is this a bug?

**A6.** This is intentional. Device tokens do not carry a Plex auth token (they can't — the pairing flow only verifies Plex identity, it doesn't give the server a permanent Plex credential for that user). In `deviceTokenAuth.ts:29`, `deviceSessionToSession` sets `username: reconciled.device_name` as a proxy display label. The `sub` (e.g. `plex:494190801`) is the stable identity; `device_name` is advisory chrome used where the UI wants to show "who is this."

---

## 7. CODE-READING EXERCISE

### Guided walk: `server/services/appleAuth.ts`

Open `/Users/cujo253/Documents/theemeraldexchange/server/services/appleAuth.ts`.

**Step 1 — Read lines 1–41 (the module-level comment block).**
This comment describes what the module does and, crucially, what it does NOT do. Identify the sentence that draws the line between authentication (authN) and authorization (authZ). Why is it important that this module stops at identity and defers the "is this user allowed in?" question to a different layer?

**Step 2 — Read lines 48–72 (constants and JWKS setup).**
Find `createRemoteJWKSet`. This is a function from the `jose` library that fetches Apple's public keys from `https://appleid.apple.com/auth/keys`. Notice it is called ONCE at module load, not once per request. What problem would occur if it were called once per request? Look at `cooldownDuration: 30_000` — what attack does this parameter defend against?

**Step 3 — Read lines 84–89 (`appleAudience`).**
This function reads `APPLE_CLIENT_ID` from the environment. Trace what happens when it returns `null`. Jump to line 131–132 in `verifyAppleIdentityToken`. What does the code return when `audience` is null? Why is "fail closed" the correct behavior here rather than "fail open with a warning"?

**Step 4 — Read lines 125–159 (`verifyAppleIdentityToken`, up to the catch block).**
The three-part structural check on lines 136–142 happens before any cryptography. Why? What does it save?

Now read the `jwtVerify` call on lines 146–155. Find the four options passed in: `issuer`, `audience`, `algorithms`, `clockTolerance`. For each one, articulate out loud (or on paper): what specific attack or failure mode does this option defend against?

**Step 5 — Read lines 160–168 (nonce check).**
The comment says "Constant-time compare." Read `constantTimeEqual` at lines 221–226. Why does the function return `false` immediately if `ab.length !== bb.length` — why not pad them to equal length and compare? (Hint: what does padding reveal?)

**Step 6 — Read lines 170–184 (subject extraction).**
Note that `rawSub` comes from `payload.sub` — the payload of the signature-verified JWT. The function then prepends `apple:` and calls `parseSub`. What would happen if the code trusted a `sub` value sent directly in the request body instead? Why does putting `parseSub` re-validation here matter?

**Step 7 — Read lines 196–217 (`classifyJoseError`).**
This function maps jose's internal exception classes to the project's own error taxonomy. Notice `TypeError` on line 215 — why does a network TypeError get classified as `jwks_unavailable` rather than `malformed_token`? Look back at `auth.ts:503`: how does the route use this distinction to choose between a 401 and a 503?

**Synthesis question:** After reading the whole file — the verifier's contract is "never throws, always returns a typed result." What is the benefit of this design for the route handler in `auth.ts` compared to a design where the verifier could throw?

---

