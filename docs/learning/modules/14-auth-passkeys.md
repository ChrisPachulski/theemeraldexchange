
# Teaching Dossier — WebAuthn Passkeys (theemeraldexchange)

---

## 1. WHAT

A **passkey** is a way to log in without a password. When you register, your device (phone, laptop, security key) generates a pair of mathematically-linked numbers: a **private key** that never leaves the device, and a **public key** that the server stores. When you log in, the server sends a random puzzle called a **challenge**; your device solves it using the private key to produce a **signature**, and the server verifies that signature using the public key it already has. If the signature checks out, you're in. The server never stored a secret — there is nothing to steal from a database breach, and nothing to phish because the private key never crosses the network. This codebase uses the WebAuthn (FIDO2) standard, wired up via the `@simplewebauthn/server` library on the backend and `@simplewebauthn/browser` on the React frontend. A passkey user is assigned a self-owned identity called a `local:<ulid>` sub — no Plex account, no Apple ID required.

---

## 2. WHY

**Why passkeys instead of passwords?**

Traditional passwords create a credential store on the server — a table of hashed secrets that, if exfiltrated, can be cracked offline. They also require users to remember and reuse secrets across sites, which enables credential stuffing. Two-factor auth is an improvement but still relies on a shared secret (TOTP seed or SMS code) living somewhere stealable.

Passkeys eliminate the liability chain entirely:

- The server stores **only the public key** — a public key is designed to be seen by anyone; it is useless for signing in without the corresponding private key.
- The private key **never leaves the authenticator hardware** (Secure Enclave on iPhone, TPM on Windows Hello). It cannot be exported, copied, or phished.
- The challenge is **single-use and server-generated** — a replay attack cannot reuse a captured signature because the next challenge will be different.
- **No passwords to breach.** Even if the `webauthn_credentials` table is dumped, an attacker has a list of public keys, credential IDs, and display names — none of which can be used to sign in.
- **No phishing surface.** The browser binds the signature to the exact origin (`rpID`). A fake login page on `evil.com` cannot collect a signature that will verify against `theemeraldexchange.com`.

Why-chained summary: passwords lead to breach risk + phishing risk + reuse risk. Passkeys break all three chains at once.

**Why keep the shared authZ gate?** A valid passkey proves *identity*, not *permission*. The members allowlist (invite codes, revocation) is the permission layer. Separating them means: (a) revoking a user in the members table instantly locks them out even though their passkey signature is cryptographically valid; (b) a registration that fails the invite check leaves zero orphan data — no member row, no stored credential.

---

## 3. MAP

**Key files:**

| File | Role |
|------|------|
| `server/routes/passkey.ts` | HTTP surface — 4 endpoints, rate-limiting, glues authN to authZ |
| `server/services/webauthn.ts` | Ceremony engine — challenge store, `@simplewebauthn/server` wrappers, credential persistence |
| `server/migrations/server/0004_webauthn.sql` | Schema — `webauthn_credentials` + `webauthn_challenges` tables |
| `server/services/ulid.ts` | Mints `local:<ulid>` sub identities (26-char Crockford Base32) |
| `server/auth.ts` | Rate-limit enforcement (`enforceAuthRateLimit`, `enforceAuthIdentityRateLimit`) + `authorizeOrRedeem` shared gate |
| `src/components/auth/PasskeyButtons.tsx` | React UI — "Sign in with passkey" + first-time setup form |
| `server/services/webauthn.test.ts` | Unit tests (mocks `@simplewebauthn` crypto, real temp SQLite) |

---

### Registration ceremony — step by step

```
Browser                         Server (routes/passkey.ts)        Service (webauthn.ts)
  |                                        |                              |
  |-- POST /register/options ------------->|                              |
  |   { handle: "Chris" }                  |-- beginRegistration(handle) ->|
  |                                        |     1. newLocalSub()  -> "local:01J..."
  |                                        |     2. generateRegistrationOptions()
  |                                        |        (rpName, rpID, userID=sub bytes,
  |                                        |         residentKey:'required')
  |                                        |     3. putChallenge('register', ...)
  |                                        |        stores: challenge, pending_sub, handle
  |                                        |        returns: opaque challengeId (16 rand bytes)
  |<-- { options, challengeId } -----------|
  |                                        |
  |  [OS prompts Face ID / Touch ID]       |
  |  device signs options.challenge        |
  |  with NEW private key                  |
  |                                        |
  |-- POST /register/verify -------------->|
  |   { challengeId, response,             |-- verifyRegistration(challengeId, response)
  |     inviteCode, deviceLabel }          |     1. takeChallenge() -- fetch+DELETE (single-use)
  |                                        |     2. verifyRegistrationResponse() -- checks:
  |                                        |        * signature over expected challenge
  |                                        |        * origin matches webauthnOrigins
  |                                        |        * rpID matches
  |                                        |     3. returns { sub, handle, credential }
  |                                        |        (NOT persisted yet)
  |                                        |
  |                                        |-- authorizeOrRedeem(sub, inviteCode, ...)
  |                                        |   (SHARED gate -- same as Plex/Apple)
  |                                        |   if !allowed -> 403, NO credential written
  |                                        |
  |                                        |-- persistCredential(sub, credential, label)
  |                                        |   writes to webauthn_credentials
  |                                        |-- setSessionCookie(..., auth_mode:'local')
  |<-- { ok:true, user }------------------|
```

**Key ordering insight:** authZ (`authorizeOrRedeem`) runs **between** `verifyRegistration` and `persistCredential`. If the invite is invalid, the server verified the crypto but wrote nothing. No orphan credential, no orphan member.

---

### Login ceremony — step by step

```
Browser                         Server (routes/passkey.ts)        Service (webauthn.ts)
  |                                        |                              |
  |-- POST /login/options ---------------->|                              |
  |   {}  (no username needed!)            |-- beginLogin() ------------->|
  |                                        |     1. generateAuthenticationOptions()
  |                                        |        allowCredentials:[] -> discoverable
  |                                        |     2. putChallenge('login', ...)
  |<-- { options, challengeId } -----------|
  |                                        |
  |  [OS shows: "Use passkey for           |
  |   theemeraldexchange.com?"]            |
  |  device signs challenge with           |
  |  existing private key for this site    |
  |                                        |
  |-- POST /login/verify ----------------->|
  |   { challengeId, response }            |-- verifyLogin(challengeId, response)
  |                                        |     1. takeChallenge() -- single-use consume
  |                                        |     2. lookup credential by response.id
  |                                        |        (the credential_id the device sent)
  |                                        |     3. verifyAuthenticationResponse()
  |                                        |        checks: signature, challenge, origin,
  |                                        |        rpID, counter (replay detection)
  |                                        |     4. bump counter in DB
  |                                        |     returns { sub }
  |                                        |
  |                                        |-- isMember(sub) -- revocation check
  |                                        |   valid signature + revoked member -> 403
  |                                        |-- setSessionCookie(...)
  |<-- { ok:true, user } ------------------|
```

**Discoverable credentials:** `allowCredentials: []` means the server does not say which credential to use — the device itself knows which resident keys it has stored for this `rpID` and offers them to the user. This is "usernameless login" — no username field needed.

**Counter / replay detection:** every time a credential signs, the device increments an internal counter. The server stores the last-seen counter and rejects any assertion where `newCounter <= storedCounter`. This catches cloned authenticators.

---

## 4. PREREQUISITES

Before this makes full sense, a student needs:

**Public/private key cryptography (ELI5):**
Imagine a padlock you can hand out unlocked copies of (the public key). Anyone can snap one onto a box to seal it. But only you have the key that opens it (the private key). In WebAuthn the "box" is a message — your device seals the challenge with its private key (creates a signature), and the server opens/verifies it with the public key it has on file. If the signature opens, only the real private key could have made it.

**What the browser does:**
The browser is the middleman between your React code and the operating system's authenticator. `@simplewebauthn/browser` calls `navigator.credentials.create()` (registration) or `navigator.credentials.get()` (login) — these are standard Web APIs that route to the OS. The OS prompts Face ID, Windows Hello, or a security key. The browser never touches the private key; it just passes the signed response back to JavaScript.

**Base64url encoding:**
Cryptographic byte arrays (keys, challenges, signatures) cannot travel in JSON as raw binary. Base64url is a text encoding — you will see it everywhere as the `id` and `response` fields in the WebAuthn JSON objects.

**Session cookies:**
After the ceremony succeeds, the server writes an `eex.session` cookie so subsequent requests know who you are. The passkey is only used at login time; everything after that is the session. (See `server/session.ts`.)

**SQLite transactions:**
`takeChallenge()` does a SELECT + DELETE inside a single transaction. Without this, two simultaneous requests could both read the same challenge row before either deletes it — making the challenge reusable, which defeats replay protection.

---

## 5. GOTCHAS & WAR STORIES

**The ADMIN_SUBS lockout:**
Early in development, the backend added an `ADMIN_SUBS` env var in `docker-compose.yml` to hardcode the owner's Plex sub as an admin. A deployment that forgot to pass this var through meant the owner could not log in even with a valid session — they passed all AuthN but the authZ check saw no admin sub. The lesson: env vars that gate access must be smoke-tested on every deploy, and there should be a recovery path (in this case, a known good `docker-compose.yml` with the var set).

**authZ BEFORE persistCredential (or you get orphan credentials):**
The current code deliberately runs `authorizeOrRedeem` before `persistCredential`. An earlier sketch had it the other way. If you verify the attestation, write the credential, then check the invite, a failed invite leaves a stale credential row with no member — future attempts to register again with the same device would fail with a unique-constraint violation on `credential_id`. The fix: always gate before persisting.

**Single-use challenges are transactional:**
`takeChallenge()` does SELECT + DELETE in one SQLite transaction. A naive implementation that reads first and deletes second has a race window on concurrent requests (rare but real under load tests). If you ever refactor the challenge store to a different backend, keep the atomicity.

**`residentKey: 'required'` vs `'preferred'`:**
The code uses `residentKey: 'required'` so that credentials are stored on-device as resident keys (enabling usernameless/discoverable login). If a user's security key is too old to support resident keys, registration will fail. Changing this to `'preferred'` allows older keys but then login requires a username to hint which credential to use. The trade-off is documented in the service source.

**`allowCredentials: []` is the usernameless signal:**
Passing an empty array to `generateAuthenticationOptions` tells the authenticator "offer whatever you have for this rpID." Passing a non-empty array would restrict the ceremony to specific credentials — useful if you want to confirm a specific device but breaks the "just tap your phone" UX.

**Counter = 0 on synced passkeys (iCloud, Google Password Manager):**
The `backed_up` column in `webauthn_credentials` flags credentials synced across devices (e.g., iCloud Keychain). Many synced passkey implementations set counter = 0 and never increment — the counter replay-detection logic must tolerate `newCounter === 0` without flagging a clone. `@simplewebauthn/server` handles this already but it is worth knowing when reading counter logic.

**Rate-limiting is dual-bucket — per-identity, not just per-IP:**
`enforceAuthIdentityRateLimit` keys on the credential ID (login) or handle (register options), not just the client IP. This matters because the tunnel (`cloudflared`) terminates TLS — `TRUST_CLIENT_IP_HEADERS` is off by default, so all requests look like they come from the same IP. Without the identity bucket, credential stuffing against `/login/verify` would be un-rate-limited. The per-identity bucket blunts targeted attacks regardless of IP diversity.

---

## 6. QUIZ BANK

**Q1.** The challenge table has a `ceremony` column with a CHECK constraint (`'register'` or `'login'`). `takeChallenge` passes the expected ceremony as a parameter. What attack does this prevent — and what would go wrong without it?

**A1.** Without it, a challenge minted for `/register/options` could be replayed at `/login/verify`. An attacker could initiate a registration (getting a fresh challenge), then inject that challenge ID into a login attempt, potentially bypassing the stricter registration authZ path. The ceremony column ensures a register-ceremony challenge is rejected at the login verify endpoint.

---

**Q2.** Walk through what happens when a user registers with an invalid invite code. Which DB rows are written, which are not, and at what point does the 403 fire?

**A2.** `verifyRegistration` is called first — it reads and deletes the challenge row (it is consumed), then cryptographically verifies the attestation and returns `{ sub, handle, credential }`. Then `authorizeOrRedeem` is called. If the invite is invalid, `!authz.allowed` is true and the handler returns 403 immediately. `persistCredential` is never called, so no row is written to `webauthn_credentials`. No member row is written either. The only side effect is the challenge row being consumed — which is correct (a failed attempt should not leave a reusable challenge).

---

**Q3.** A user registers their iPhone. Six months later their account is revoked in the admin panel (member row deleted/revoked). They still have the passkey on their phone. What happens when they try to log in?

**A3.** The login ceremony completes successfully up through `verifyLogin` — the signature is cryptographically valid and `verifyLogin` returns `{ sub }`. But then `isMember(sub)` is called. With the member row revoked/absent, `isMember` returns `null`. The handler returns `403 access_revoked`. The passkey itself is not deleted from `webauthn_credentials` — the authZ layer is the enforcement point, not the credential store.

---

**Q4.** `beginLogin` passes `allowCredentials: []`. A student suggests "we should pass the credential IDs from the DB so we only accept known credentials." What would change about the UX, and why does the current design choose empty instead?

**A4.** Passing specific credential IDs makes the browser ask "which of these specific credentials do you want to use?" and requires knowing the user's identity first (to query their credential IDs), which reintroduces a username field. The current empty-array approach is discoverable-credential / usernameless login: the authenticator scans its resident keys for any that match the `rpID` and presents them. The UX is "tap your phone, done." The trade-off is that the server only discovers the credential's owner *after* the signature (by looking up `response.id` in the DB), not before — which is fine because that DB lookup is itself the authN step.

---

**Q5.** The `persistCredential` call allows multiple credential rows per `sub`. Why does the schema allow this, and what UX capability does it enable?

**A5.** A single user (`local:<ulid>` sub) can own multiple passkeys — an iPhone passkey, a laptop Touch ID passkey, and a physical YubiKey. `credential_id` is the primary key; `sub` is not unique. The `device_label` ("Chris's iPhone") lets the UI list all a user's registered devices so they can manage or revoke individual credentials without losing all access.

---

**Q6.** The test file mocks `@simplewebauthn/server` but uses a real temporary SQLite database. Why not mock the DB too?

**A6.** The crypto functions require a real authenticator device to produce valid responses — they cannot be called in a unit test without a hardware key. Everything the module *owns* — the challenge store (insert, single-use consume, TTL expiry), credential persistence, counter bumping, error branches — runs against real SQLite to prove the SQL is correct. Mocking both would only test that the module calls functions in a certain order, not that the data model works.

---

## 7. CODE-READING EXERCISE

**Goal:** Trace the full login ceremony from a browser click to a session cookie, touching every layer.

**Open these files side-by-side:**
1. `src/components/auth/PasskeyButtons.tsx`
2. `server/routes/passkey.ts`
3. `server/services/webauthn.ts`
4. `server/migrations/server/0004_webauthn.sql`

**Step 1 — The click.**
In `PasskeyButtons.tsx`, find the `onClick` handler for "Sign in with a passkey". It calls `passkeyLogin()` from `useAuth()`. Note that the browser will call `@simplewebauthn/browser`'s `startAuthentication`, which calls `navigator.credentials.get()` under the hood.

**Step 2 — Options endpoint.**
In `passkey.ts`, find `passkey.post('/login/options', ...)`. What does it call from `webauthn.ts`, and what two things does the service generate and return?

**Step 3 — The challenge store.**
In `webauthn.ts`, find `putChallenge`. Look at the INSERT statement. Cross-reference `0004_webauthn.sql` — confirm the column names match. Now find `takeChallenge`. Why is it wrapped in `db.raw.transaction()`? What would happen if SELECT and DELETE were two separate calls?

**Step 4 — Verify endpoint.**
Back in `passkey.ts`, find `passkey.post('/login/verify', ...)`. Trace: (a) rate-limit check, (b) `verifyLogin` call, (c) `isMember` check. For step (c), ask yourself: if `verifyLogin` returns a sub successfully but `isMember(sub)` returns `null`, what HTTP status is returned and why?

**Step 5 — The counter.**
In `webauthn.ts` inside `verifyLogin`, after `verifyAuthenticationResponse` succeeds, find the UPDATE statement. What field is updated? Read the comment in `0004_webauthn.sql` for the `counter` column. Explain in one sentence why bumping this counter on every login makes a stolen device snapshot useless.

**Step 6 — Session.**
After `verifyLogin` and `isMember` both pass, `setSessionCookie` is called with `auth_mode: 'local'`. Why does the route set `auth_mode: 'local'` rather than `'passkey'`?

**Answers to check yourself:**

- Step 2: `beginLogin()` — generates `options` (a challenge + rpID config for the browser) and a `challengeId` (an opaque server-side lookup key).
- Step 3: The transaction ensures the row is fetched and deleted atomically. Two simultaneous requests without a transaction could both read the same challenge, allowing a single challenge to be used twice.
- Step 4: HTTP 403 with `{ error: 'access_revoked' }`. A valid cryptographic proof of identity does not grant access if the authZ layer (the members allowlist) says the user is not active.
- Step 5: `counter` is incremented. If someone clones a credential (copies the key material), the clone's counter is behind the server's last-seen counter — the next login from the clone is rejected because `newCounter <= storedCounter`.
- Step 6: `auth_mode` describes the identity namespace, not the mechanism. A `local:` sub is always a passkey user by definition — the mode `'local'` is correct and sufficient. Using `'passkey'` would be redundant.

---

