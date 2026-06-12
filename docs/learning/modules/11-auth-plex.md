
# Teaching Dossier: Plex OAuth PIN-flow Authentication

---

## 1. WHAT

When a visitor clicks "Sign in with Plex" on The Emerald Exchange, the app does not ask them to type a username or password. Instead it uses Plex's PIN flow — a form of delegated authentication. The browser opens a small Plex popup window where the visitor proves who they are to Plex directly. Meanwhile, the app keeps asking Plex "has this visitor finished?" every 1.5 seconds. Once Plex says yes, it hands back a short-lived token that the backend uses to look up who the person is. The backend then decides whether that person is allowed into this specific app (not just anyone with a Plex account — only people on the owner's invite list or Plex server share). If they pass, the backend writes an encrypted session cookie to the browser that acts as a 30-day pass; no password, no database of credentials, no emails to verify. The session cookie is opaque — even if someone copies it out of DevTools, they cannot read what's inside it.

---

## 2. WHY

**Why no homegrown passwords?**
Passwords require a registration flow, a "forgot password" email infrastructure, secure hashing (bcrypt/argon2), and vigilance against credential-stuffing attacks. This is an App-Store-bound homelab app whose intended audience already has Plex accounts. Delegating identity to Plex (and Apple) means the app never holds a password — a stolen database backup leaks no credentials. The design document calls this a "one-way door": once an auth gate is established, there is no going back without invalidating every existing session.

**Why does the browser create the PIN, not the server?**
In the original implementation the backend called `POST plex.tv/api/v2/pins` server-side and then redirected the user to the Plex auth page. Plex's "Security Alert" feature logs the IP address of whoever creates the PIN — it appeared in the user's Plex security dashboard. Because the PIN was created from the server, every visitor saw the *server's* home IP (and therefore the owner's home address and geolocation) in their own Plex account's security alert page. The fix: the *browser* creates the PIN directly at plex.tv. Now plex.tv logs each visitor's own IP. The backend's only involvement is fetching the same PIN by ID to see if the user authorized it — that fetch does not trigger a new "Security Alert" entry.

**Why JWE (encrypted JWT) for the session cookie, not a plain signed JWT?**
The session payload includes the user's Plex auth token so that admin routes (e.g. "list who's shared on this Plex server") can call plex.tv on the user's behalf without storing a long-lived owner credential in environment variables. A *signed* JWT (JWS) only proves the payload hasn't been tampered with — the payload is still base64-readable. Anyone who copies the cookie out of browser DevTools or a proxy log would be able to extract the Plex token and call plex.tv as that user. A JWE *encrypts* the payload with AES-256-GCM, derived via HKDF from the server's `SESSION_SECRET`. The cookie is opaque ciphertext even to a network attacker who can read it.

**Why chain these decisions together?**
The result is a trust hierarchy: Plex (or Apple) proves *who you are*; the members allowlist decides *whether you're allowed*; the JWE session stores *both* securely in an opaque cookie; the per-request reconcile in `sessionGate.ts` catches *after-the-fact* revocation so a 30-day cookie doesn't outlive a revoked share.

---

## 3. MAP

### Key files

| File | Role |
|---|---|
| `server/auth.ts` | Hono router: `GET /api/auth/plex/config`, `POST /api/auth/plex/check`, `POST /api/auth/logout`, `GET /api/me` |
| `server/plex.ts` | Pure plex.tv API client: `checkPin`, `getUser`, `listResources`, `probeResources`, `signOut` |
| `server/session.ts` | JWE session cookie lifecycle: `createSession`, `verifySession`, `setSessionCookie`, `readSession` |
| `server/services/membership.ts` | AuthZ facade: `memberStatus` (allowed / revoked / not_member) |
| `server/services/sessionGate.ts` | Per-request reconcile: re-checks plex.tv every 15 min using the stored Plex token |
| `server/services/members.ts` | Write side: `addMember` (called by auto-admit) |
| `src/lib/auth.tsx` | React `AuthProvider`: `signIn()` function owns the full browser-side PIN flow |

### PIN flow, step by step

```
BROWSER (React SPA)                      BACKEND (Hono)             PLEX.TV
─────────────────────────────────────────────────────────────────────────────
1. User clicks "Sign in with Plex"

2. SPA opens a blank popup window.

3. SPA fetches GET /api/auth/plex/config  ─────────────────────────►
                                          Returns { clientId, product }
                                          ◄─────────────────────────

4. SPA POSTs directly to plex.tv:
   POST https://plex.tv/api/v2/pins?strong=true
   X-Plex-Client-Identifier: <clientId>  ─────────────────────────────────►
                                          Returns { id: 12345, code: "xyz" }
                                          ◄───────────────────────────────
   (plex.tv logs the VISITOR's IP here, not the server's)

5. SPA navigates the popup to:
   https://app.plex.tv/auth#?clientID=<clientId>&code=xyz
   User signs in to Plex in the popup.
   Plex attaches an authToken to pin 12345.

6. SPA starts polling every 1500ms:
   POST /api/auth/plex/check { pinId: 12345 }   ─────────────────►
                                          checkPin(12345) polls plex.tv/api/v2/pins/12345
                                          Returns { status: "pending" } if not yet authorized
                                          ◄─────────────────────────
   (loop)

7. After user approves in popup:
   POST /api/auth/plex/check { pinId: 12345 }   ─────────────────►
                                          checkPin returns pin.authToken = "abc..."
                                          getUser("abc...") → { id, username, email, thumb }
                                          namespacedSub = "plex:494190801"
                                          roleFor(username, sub) → "admin" or "user"
                                          authorizeOrRedeem(sub, ...) → allowed: true/false
                                          If not allowed + plexServerId: isOwnerServerMember?
                                            If yes → addMember(...) → allowed = true
                                          setSessionCookie: JWE({ sub, username, role,
                                            auth_mode: "plex", plexAuthToken: "abc..." })
                                          _primeSessionGateCache(sub, "member", ...)
                                          Returns { status: "authorized", user: {...} }
                                          ◄─────────────────────────
   SPA closes popup, sets user state, sets signInState = "idle".
```

**On every subsequent protected request** (e.g. `GET /api/me`):
- `readSession(c)` decrypts the cookie → gets the Session object.
- `reconcileSession(session)` in `sessionGate.ts` calls `memberStatus(sub)` (allowlist check, cheap, synchronous), and every 15 minutes calls `probeResources(plexAuthToken)` to re-verify the user still has access to the Plex server. A definitive plex.tv 401/403 returns null (logs user out); a network error keeps them in (fail-open on transient outages).

---

## 4. PREREQUISITES

A beginner needs to understand these concepts before this module makes sense:

1. **HTTP cookies** — what `Set-Cookie`, `HttpOnly`, `Secure`, `SameSite` do; why HttpOnly means JavaScript cannot read the cookie value.

2. **What OAuth/delegated auth means** — the difference between "prove to me who you are" (the app asking the user) vs "prove to plex.tv who you are, and tell me" (delegated). The app never sees the user's plex password.

3. **JWT structure** — the three base64url-separated parts (header.payload.signature/ciphertext). Know that JWS signs, JWE encrypts.

4. **HKDF key derivation** — a deterministic function that turns a secret string into a fixed-length cryptographic key; same secret always produces the same key; used so the session key is derived from `SESSION_SECRET` but is not the raw secret.

5. **AES-256-GCM** — symmetric encryption that also authenticates (if the ciphertext is tampered with, decryption fails). This is what makes the JWE cookie both confidential and tamper-proof.

6. **Same-origin policy and CSRF** — why a `POST` to `/api/auth/plex/check` is safer than `GET` for a cookie-setting endpoint: a cross-origin page cannot trigger a credentialed POST (CSRF middleware checks the `Origin` header), but it *can* trigger a cross-origin `GET` via an `<img>` tag.

7. **React Context + hooks** — `AuthProvider` wraps the entire app tree and shares auth state; `useAuth()` is the hook that reads it from any child component.

8. **Hono routing** — `new Hono()`, `app.get(path, handler)`, `app.post(path, handler)`, what `c.json(...)` does, how sub-routers mount onto a parent via `app.route(prefix, subRouter)`.

---

## 5. GOTCHAS & WAR STORIES

### The plex.tv v1/v2 identifier mismatch

Plex has two identifier spaces that confusingly share similar names:

- **`clientIdentifier`** (from `/api/v2/resources`): the globally unique identifier plex.tv assigns to a *server*. This is what `PLEX_SERVER_ID` in the backend's env is set to. It is stable, a long hex string like `ad782b5e...`.
- **`machineIdentifier`** (from a local PMS `/identity` endpoint): the identifier the *local* Plex Media Server process knows about itself. On this homelab, that was `fb8fe974...` — a *different* string.

The v1 membership check (before the current implementation) called the local PMS `/identity` endpoint to discover the server's ID, then compared it to what plex.tv returned. It never matched. A server that had been registered differently from its local self-report would fail the membership check silently, denying all users. The fix: `PLEX_SERVER_ID` is now set *manually* in the operator's env by reading the `clientIdentifier` from the `/api/v2/resources` call (which returns what plex.tv actually thinks the server is). The local machineId is completely ignored.

Diagnostic: the "discovery aid" path in `/plex/check` (lines 422-431 of `server/auth.ts`) exists precisely for this — if `PLEX_SERVER_ID` is not set, the backend returns `discoveredServers` in the login response so a first-time operator can copy-paste the right ID into their env.

### The home IP leak (and why client-side PIN creation is the fix)

This is documented in the code comment at `server/auth.ts:3-10` and `server/plex.ts:52-56`. Original code: backend called `POST plex.tv/api/v2/pins`. Plex attributes that PIN creation to the requester's IP. Because the backend is a homelab server behind a static home IP, plex.tv recorded that IP on every user's "Security Alert" page under "Recent Sign-Ins." Anyone who signed into the app could see the owner's home IP and rough geolocation. The SPA-side PIN creation (added later) moves that attribution to the visitor's own browser. The backend only polls by PIN ID — plex.tv does not record a new security event for a PIN poll.

### Revoke wins — a Plex share does not re-admit a revoked member

In `server/auth.ts:401`: the Plex-server-share auto-admit (`isOwnerServerMember`) only fires when `memberStatus(namespacedSub) === 'not_member'`. If a user's row exists and is revoked, `memberStatus` returns `'revoked'` — a different value — so the auto-admit branch is skipped and they get a 403. An explicit revoke (admin deleted them from the members table) takes permanent precedence over a continued Plex share. Plex share is not the same as app access; it is only the *initial grant mechanism*, not an ongoing auth right.

### Why POST (not GET) for the check endpoint

If `/api/auth/plex/check` were a GET, an attacker could embed `<img src="https://app.theemeraldexchange.com/api/auth/plex/check?pinId=99999">` on a malicious page the victim is visiting. If the attacker had already authorized pinId 99999 in their own Plex account, the victim's browser would make that GET (with the victim's session cookie), and the backend would overwrite the victim's session cookie with the attacker's identity — session fixation. POST + `requireSafeOrigin` (which checks `Origin` header against the allowed domain) blocks this because browsers will not automatically send credentialed cross-origin POSTs.

---

## 6. QUIZ BANK

**Q1.** A new user signs in with Plex, is on the owner's Plex server share, but `memberStatus` returns `'revoked'` for their sub. Do they get in? Explain precisely which code path handles this.

**A1.** No. In `server/auth.ts` around line 401, the auto-admit branch checks `memberStatus(namespacedSub) === 'not_member'`. A revoked sub returns `'revoked'`, not `'not_member'`, so that condition is false and the auto-admit code does not run. `allowed` remains false and the handler returns `403 { status: 'denied', reason: 'no_invite' }`. Revoke is unconditional.

**Q2.** The operator deploys a new instance and forgets to set `PLEX_SERVER_ID`. A user signs in with valid Plex credentials. What does the response body from `POST /api/auth/plex/check` look like, assuming they are in `ADMIN_SUBS`?

**A2.** `authorizeOrRedeem` checks `memberStatus` which short-circuits to `'allowed'` for `ADMIN_SUBS` without any DB read. The auto-admit block is never reached (the outer `if (!allowed && env.plexServerId ...)` is false because `env.plexServerId` is falsy). A session cookie is minted. The response is `{ status: 'authorized', user: {...}, discoveredServers: [{ name, id, owned }, ...] }` — the `discoveredServers` array is populated from `listResources` because `PLEX_SERVER_ID` is unset. This is the "discovery aid" to help the operator find the right ID to copy into env.

**Q3.** Why is the Plex auth token stored inside the JWE session cookie instead of in a database table keyed by session ID?

**A3.** The cookie-session design is stateless — no server-side session store. The Plex token is needed on every call to `probeResources` in `sessionGate.ts` for per-request membership reconciliation. Putting it in a database would add a DB read on every protected request just to retrieve the token, plus a session-id lookup. Storing it in the JWE keeps the architecture stateless: the cookie IS the session, and it is opaque (AES-256-GCM-encrypted) so even an attacker with a copy of the cookie cannot extract the Plex token.

**Q4.** The `_primeSessionGateCache` call at the end of a successful `/plex/check` sets the sub's membership status to `'member'` in the in-process cache. What would happen on the very first `/api/me` request after login if that prime call did not exist?

**A4.** `sessionGate.reconcileSession` would check the in-memory cache and find no entry for the sub. It would then call `probeResources(plexAuthToken)` to re-verify membership against plex.tv — a network round-trip. This is a wasted call: we *just* verified membership milliseconds ago during login. The prime call seeds the cache with a fresh `'member'` status and the current timestamp, so the first `/api/me` request hits the cache (TTL 15 minutes) and skips the redundant plex.tv probe.

**Q5.** The SPA polls `/api/auth/plex/check` every 1500ms with the pinId. Why does the SPA use `window.setInterval` (in the browser) rather than the backend doing the plex.tv polling and pushing a result?

**A5.** Three reasons visible in the code: (1) the backend is stateless — there is no mechanism to associate an ongoing backend-side polling loop with a specific client connection (no WebSockets or SSE in this flow); (2) polling on the client means the backend only does work when the client asks (no wasted server threads for users who close the popup immediately); (3) the client can directly detect `popup.closed` and bail out immediately without the backend knowing — a backend-driven push would need a separate event channel for that signal.

**Q6.** A user was added via a Plex server share (auto-admit, `invitedBy: 'plex:server-share'`) and then the owner removes them from the Plex server share. The user's `members` row still has `revoked_at = null`. On their next request, does `sessionGate.ts` sign them out?

**A6.** Not immediately — and not automatically. `memberStatus(sub)` returns `'allowed'` (the row exists and is not revoked). The `sessionGate` Plex revalidation (`probeResources`) only fires every 15 minutes; when it does, it checks whether the Plex auth token can still see the server in its resource list. If the share was removed, `listResources` returns a list without the server, the gate sees `not_member`, writes `not_member` to the cache, and returns null — the next request with that cookie gets a 401 and is signed out. Note: this also triggers `cascadeRevokeForSub` for any paired device tokens (tvOS/iOS). So the eviction happens eventually, within 15 minutes of the next request.

---

## 7. CODE-READING EXERCISE

### Walk through `POST /api/auth/plex/check` in `server/auth.ts`

Open `/Users/cujo253/Documents/theemeraldexchange/server/auth.ts` and read lines 352–461.

**Step 1 (lines 352–363): Rate-limit + input parsing.**
The handler runs two rate-limit checks before touching plex.tv. Find the two function calls. What are they checking? (Hint: one is global; one is per-pinId.) Why does it matter to rate-limit per-pinId separately?

**Step 2 (lines 366–367): Plex PIN check.**
`checkPin(pinId)` is called. Where is `checkPin` defined? (Look at the import at line 32.) What does it return when the user hasn't authorized yet, and what does the route return to the SPA in that case?

**Step 3 (lines 371–383): Identity extraction.**
Once a token exists, `getUser(pin.authToken)` returns the Plex user. Notice how `namespacedSub` is constructed: `plex:${user.id}`. Why the `plex:` prefix? (Hint: what would happen if Apple login also used a bare numeric ID?)

**Step 4 (lines 391–412): AuthZ gate — two layers.**
First, `authorizeOrRedeem` consults the members allowlist. If that fails (`!allowed`), a second check fires: `isOwnerServerMember`. Trace `isOwnerServerMember` to `server/plex.ts:listResources`. What does it return, and what is it compared against? (Check `env.plexServerId` — where does that value come from in production?)

**Step 5 (lines 401–411): Auto-admit guard.**
The auto-admit block has three conditions: `!allowed`, `env.plexServerId`, and `memberStatus(namespacedSub) === 'not_member'`. Why must all three be true before calling `addMember`? What breaks if the third condition is removed?

**Step 6 (lines 434–447): Session cookie mint.**
`setSessionCookie` in `server/session.ts` calls `createSession` which calls `new EncryptJWT({ ...payload }).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).encrypt(hkdfKey)`. What does `alg: 'dir'` mean in JWE? (Hint: it means no key-wrapping layer — the `hkdfKey` IS the content-encryption key directly.) What is `hkdfKey` derived from?

**Step 7 (lines 448-460): Response shape.**
The handler returns `{ status: 'authorized', user: {...}, discoveredServers?: [...] }`. When is `discoveredServers` non-null? What is a first-time operator supposed to do with that data?

**Putting it together:** Describe in one paragraph, in your own words, why this endpoint is a POST and not a GET, what happens when a revoked member tries to sign in with Plex, and why the session cookie is encrypted rather than just signed.

---

