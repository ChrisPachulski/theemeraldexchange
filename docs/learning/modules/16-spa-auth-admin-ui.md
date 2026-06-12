
# SPA Auth + Admin UI — Teaching Dossier

## 1. WHAT

Theemeraldexchange is a React web app that lets users log in via three providers (Plex PIN, Apple Sign-In, WebAuthn passkeys) and admins manage household members/invites/devices on a settings screen. The UI components (buttons, forms, modal dialogs) drive backend flows that grant session cookies; the app stores auth state in React Query and enforces role-based gating at the UI layer, while the server performs the *real* trust boundary checks.

## 2. WHY

**The Plex PIN is created client-side in the browser because** plex.tv records the IP of the code-generator, not the backend. If the backend generated the PIN on the user's behalf, plex.tv would log the backend server's IP/hostname (a privacy leak that exposed the home network). By moving PIN generation to the browser, the code now comes from the user's own device, so plex.tv records their public IP instead. This stopped leaking the internal home IP.

**Why Apple Sign-In is separate**: Apple's SIWA SDK runs in the browser (it opens a popup), authenticates the user, and returns a JWT to the frontend. The frontend then POSTs that JWT to the backend to validate and mint a session.

**Why WebAuthn passkeys are client-side**: Passkey registration and login both use the browser's native WebAuthn API (geolocation/biometric) — the backend only validates the signed challenge afterward.

## 3. MAP

Key files (SPA auth + admin):

```
src/components/auth/
  ├─ AppleSignInButton.tsx:16–57      [SIWA button + SDK runAppleSignIn()]
  ├─ PasskeyButtons.tsx               [Register/login passkey buttons]
  ├─ UserMenu.tsx                     [Session state, admin gate]
  ├─ InvitesPanel.tsx                 [Admin: send invites]
  ├─ DevicesPanel.tsx                 [Admin: revoke device tokens]
  ├─ appleSdk.ts                      [Apple SDK initialization]
  └─ ApiKeySettings.tsx               [User API key mgmt]

src/lib/auth.tsx:1–100                [Auth context, useAuth() hook, session methods]
src/lib/api/base.ts                   [HTTP client, cookie transport]

server/
  ├─ plex.ts:52–87                    [checkPin() polls plex.tv, no server-side PIN creation]
  ├─ session.ts:1–100                 [Session JWE encryption, eex.session cookie]
  └─ routes/device.ts:88–140          [GET /api/auth/plex/pin/:pinId, polls checkPin]

server/routes/
  ├─ passkey.ts                       [WebAuthn challenge/verify, POST /auth/passkey/*]
  ├─ adminInvites.ts                  [POST /admin/invites, invite + membership gate]
  └─ devices.ts                       [GET/DELETE /devices, device token management]

server/middleware/
  ├─ auth.ts                          [requireAdmin, requireAuth, gate checks]
  └─ csrf.ts                          [CSRF token validation on POST/DELETE]

server/services/
  ├─ membership.ts                    [memberStatus() — invite/member allowlist check]
  └─ internalPrincipal.ts             [Session identity resolver from sub]
```

**Login flow walkthrough (Plex PIN):**

1. User clicks "Sign In with Plex" button in the SPA
2. Frontend calls `runAppleSignIn()` or equivalent Plex init → fetches `/api/auth/plex/config` to get `plexClientId`
3. Frontend creates PIN directly at `plex.tv/api/v2/pins?strong=true` (client-side, NOT backend); gets `{ id, code }`
4. Frontend displays QR code; user scans with phone, logs into plex.tv
5. Frontend polls `GET /api/auth/plex/pin/{pinId}` every 1000ms (hits `server/routes/device.ts:88`)
6. Backend calls `checkPin(pinId)` (`plex.ts:59`), which polls plex.tv API
7. Once user scans & approves in plex.tv, Plex API returns `{ authToken }` in the poll response
8. Frontend receives `authToken`, POSTs to `POST /api/auth/session` (`server/session.ts`) with authToken
9. Backend calls `getUser(authToken)` to get identity, checks `memberStatus(sub)` (`membership.ts`), mints `eex.session` JWE cookie (`session.ts:createSession`)
10. React Query invalidates, `useAuth().user` re-populates, UserMenu renders with role, admin UI gates trigger

Admin gate (UI layer, not trust boundary):

- `UserMenu.tsx`: checks `session?.role === 'admin'` from React state
- Shows "Settings" tab only if admin
- Server enforces on every admin endpoint: `middleware/auth.ts` calls `requireAdmin`, which checks session cookie + database role

## 4. PREREQUISITES

Before reading this dossier:

- **Cookie-based sessions**: understand how `HttpOnly` cookies work (cannot be stolen by JS, browser sends them on every request)
- **OAuth2 / OpenID Connect flow**: why third-party auth requires a backend to exchange tokens
- **React Query**: caching/invalidation of server state (`useQuery`, `invalidateQueries`)
- **HTTP status codes**: 401 (unauthenticated), 403 (authenticated but forbidden), 200 (success)
- **Trust boundary**: client code (JS, buttons, gating) is visible/bypassable; server auth is the real enforcer

## 5. GOTCHAS & WAR STORIES

**Client-side PIN generation ended a home-IP leak (commit d036f28):**
The old flow had the backend generate Plex PINs. Plex.tv recorded the backend's internal IP in logs as "device that created the PIN." When the user's household member logged in from outside the home network, they'd scan the PIN, and plex.tv would show the backend's internal home IP to the user. This was a privacy & security issue — home IP was no longer hidden. The fix moved PIN generation to the browser: `frontend → plex.tv → plex.tv records user's public IP, not server's private IP.` This is why the Plex login flow is special: it's the only provider that cares *where* the PIN was generated.

**UI gating is convenience, not security:**
The "Settings" tab only shows if `role === 'admin'` in React state. But a malicious user can open DevTools, set `role='admin'` in memory, and see the Settings UI. The UI doesn't actually *grant* permissions — the server does. Every admin endpoint is gated by `middleware/auth.ts`, which checks the session cookie and calls `memberStatus()` on the server. A fake role in React state doesn't bypass this.

Example: if user edits the React state to `role='admin'` and clicks "Send Invite," the POST to `/admin/invites` will hit the server, which will query the database for the user's actual role, and 403 if they're not admin. The UI gate prevents accidental clicks, not attacks.

**CSRF token is needed for cookie-based writes:**
Plex login, Apple Sign-In, passkey register/login, and admin actions (invites, device revoke) all POST data. The server enforces CSRF protection: `middleware/csrf.ts` requires an `X-CSRF-Token` header on unsafe methods (POST/DELETE). The frontend must read a token from a GET endpoint first (usually embedded in the page on first load or fetched separately). Forgetting this → 403 CSRF errors.

**Passkey registration is per-device:**
Each device (laptop, phone, desktop) stores its own passkey credential in the OS keychain. You can register multiple passkeys. Revoking one doesn't revoke others. The server stores the credential public key; login sends a signed challenge. If a device is lost, you must revoke its device token in the Settings UI to cut off its playback/API access.

**Session cookie expires; renewal is automatic:**
`eex.session` cookie has a TTL (e.g., 30 days). React Query polls a "healthcheck" or user endpoint to detect expiry. If the session is gone, `middleware/auth.ts` returns 401, React Query's `onError` clears auth state, and the UI shows the login screen again. There's no explicit "logout" button (though one could be added); closing the browser or clearing cookies works.

## 6. QUIZ BANK

**Q1: Walkthrough (application-level)**
A user logs in with a Plex PIN. Trace the request journey from "Click Sign In" to "Session cookie is set."
Where does the PIN generation happen, and why there?
What does the frontend poll, and how often?

**Answer:**
1. Click "Sign In with Plex" → frontend calls `createPlexPin()` 
2. `createPlexPin()` POSTs to `POST /plex/pin` (backend/plex-admin.ts)
3. Backend calls Plex.tv API, gets a PIN ID, stores it in cache, returns to frontend
4. Frontend polls `GET /plex/pin/{pinId}` every ~1000ms
5. User scans PIN with their phone, logs into plex.tv
6. Plex.tv updates the PIN record with an authToken
7. Frontend's poll sees the authToken, extracts it, POSTs to `POST /auth/session`
8. Backend validates authToken with Plex, mints session cookie `eex.session`, returns 200
9. React Query invalidates, UserMenu refetches user data, session is now active

PIN generation happens in the frontend (browser), not the backend. Why: Plex.tv records the IP of the device that created the PIN. If the backend created it, plex.tv logs the server's internal IP (a privacy leak). Browser generation means plex.tv sees the user's public IP.

Frontend polls `GET /plex/pin/{pinId}` with a 1000ms interval (typically 30–60 polls before timeout).

---

**Q2: Admin gating (trust boundary)**
A logged-in user opens DevTools and changes their React state from `role='user'` to `role='admin'`. They see the "Settings" tab and click "Send Invite." Will the invite send successfully?

**Answer:**
No. The UI gate is *not* a trust boundary. The server enforces access control on `POST /admin/invites` via `middleware/auth.ts`. Even if the frontend shows the Settings tab and accepts the form, the backend will:
1. Receive the POST request
2. Read the `eex.session` cookie
3. Call `memberStatus()` to look up the user's actual role in the database
4. See `role='user'`
5. Return 403 Forbidden

The UI gate is a UX convenience (don't show inaccessible buttons). Real permission checks happen on the server.

---

**Q3: Passkey registration (browser API)**
A user clicks "Register Passkey" on their laptop. Describe what happens in the browser without touching the backend. Then, what happens when they log in on a different device (phone) with the same passkey?

**Answer:**
On the laptop (registration):
1. Frontend calls `navigator.credentials.create({ publicKey: challenge })` (WebAuthn API)
2. Browser shows "Register your fingerprint/face" dialog
3. User completes biometric authentication
4. Browser generates a keypair, stores the private key in the OS keychain (encrypted by biometric), returns the public key + attestation
5. Frontend POSTs the public key to `POST /auth/passkey/register` (server/routes/passkey.ts)
6. Backend stores the public key in the database, linked to the user's account

On a phone (login):
The user cannot use the same passkey. Passkeys are per-device. The private key lives in the phone's keychain, not the laptop's. To log in on the phone, the user must either:
- Register a new passkey on the phone
- Use a different login method (Plex PIN, Apple Sign-In)
- Use a "cross-device passkey" flow (if the browser/Plex supports it), where the phone scans a QR code on the login screen and approves the login, but this requires backend support

---

**Q4: CSRF protection on POST /admin/invites**
A user is logged in and visits a malicious website. That website's JS auto-submits a form to `POST /admin/invites` to invite a victim email. Why doesn't this succeed?

**Answer:**
1. The malicious website cannot read the user's `eex.session` cookie (it's HttpOnly, cross-origin)
2. However, the browser will *send* the cookie automatically on the POST (same-site policy, unless SameSite=None)
3. The server receives the POST with a valid session cookie
4. But `middleware/csrf.ts` checks for `X-CSRF-Token` header (server/middleware/csrf.ts:30)
5. The malicious website's form POST has no such header (CORS blocks custom headers on cross-origin requests)
6. Server returns 403 CSRF Token Mismatch

The user's legitimate browser tab CAN POST to `/admin/invites` because:
- It sends `eex.session` cookie (same-origin, automatic)
- It includes `X-CSRF-Token` header (fetched from the page at load time, or from a GET endpoint)

---

**Q5: Apple Sign-In flow**
Explain why Apple Sign-In requires the backend to validate a JWT, even though the browser can see and decode the JWT.

**Answer:**
The frontend can *decode* the JWT (it's not encrypted, just Base64+signature), but it cannot *verify* the signature. The signature was created with Apple's private key (secret); only Apple's public key can verify it. The public key is published on Apple's servers and must be fetched securely.

If the backend didn't verify, a malicious actor could:
1. Decode the JWT (visible)
2. Edit the `sub` (user ID) to someone else's ID
3. Re-encode and send to the backend

The backend calls Apple's `/auth/token` endpoint to validate the signature, ensuring the JWT came from Apple and wasn't tampered with. Only then does it trust the `sub` and mint a session.

---

**Q6: Device token vs. session cookie**
Explain the difference between a `eex.session` cookie and a "device token" (as seen in DevicesPanel.tsx). Why does the system use both?

**Answer:**
- **Session cookie** (`eex.session`): Minted after login (Plex/SIWA/passkey). HttpOnly, sent automatically on every request. Expires after ~30 days. Used by the browser to make API calls on behalf of the logged-in user.
- **Device token**: A long-lived, opaque credential issued to a native app (iOS, Android, macOS) or an API client that can't use cookies (no browser). Generated via `POST /auth/device` with a session cookie. Allows the native app to call `/api/playback`, `/api/media` without a browser cookie.

Why both?
- **Security**: Native apps can't use HttpOnly cookies (no web context). Device tokens allow them to prove identity. Each device can be revoked independently in Settings.
- **Flexibility**: A user can have multiple devices (phone, tablet, TV). Each gets its own device token. Revoking one (e.g., a lost phone) doesn't affect the others.

## 7. CODE-READING EXERCISE

**Guided walk: How a Plex login flows through the codebase**

Start with `src/lib/auth.tsx` and trace the auth context. You'll see the auth module owns the `useAuth()` hook, which has methods like `plexSignIn(authToken, ...)`.

1. **Read `src/lib/auth.tsx` (lines 1–120):**
   - Find `type AuthContextType` → lists methods like `plexSignIn`, `appleSignIn`, `registerPasskey`
   - Find `const AuthContext = createContext(...)` — this is the SPA's auth store
   - Read the `plexSignIn` method: it POSTs the authToken to `POST /api/auth/session`, handles 403s, invalidates React Query
   - Note the `onError` hook: a 401 clears auth state and shows the login screen

2. **Open `src/components/auth/AppleSignInButton.tsx` (lines 16–57):**
   - The component imports `useAuth()` and calls `appleSignIn()` when clicked
   - It calls `runAppleSignIn()` from `appleSdk.ts`
   - `runAppleSignIn()` invokes the Apple SDK popup (`window.AppleID.auth.init()` and `.signIn()`)
   - On success, it receives an `identityToken` (a JWT from Apple)
   - It passes that to `appleSignIn(identityToken, nonce, inviteCode)` (the auth context method)
   - The method POSTs to `POST /api/auth/apple` with that JWT

3. **Jump to backend: `server/routes/device.ts` (lines 20–140):**
   - Find the route handler for `GET /api/auth/plex/pin/:pinId`
   - This is called `device` router in the main app (see `server/app.ts` for router registration)
   - Line 88: calls `checkPin(pinId)` (a plex.tv API client call)
   - Look at `checkPin` — it's imported from `server/plex.ts`

4. **Check `server/plex.ts` (lines 52–87):**
   - **Key insight**: Line 52–56 explain why PIN creation is NO LONGER server-side
   - "PIN CREATION NO LONGER HAPPENS SERVER-SIDE" — it's the client's job
   - `checkPin()` (lines 59–87) only *polls* plex.tv to see if the user scanned
   - It fetches `https://plex.tv/api/v2/pins/{pinId}` with the public `clientId`
   - When `data.authToken` is present (line 83), the user has authorized
   - Returns the token to the frontend

5. **Frontend polls and exchanges:** (back in `src/lib/auth.tsx`)
   - Once the PIN poll returns an authToken, `plexSignIn(authToken, ...)` POSTs to `POST /api/auth/session`
   - The backend (see step 6) validates and mints a cookie

6. **Server-side session creation: `server/session.ts` (lines 1–100):**
   - Look at `type Session` (line 64): contains `sub` (user ID), `username`, `role`, `auth_mode`
   - Find `createSession(...)` method (should be around line 110+; read further if needed)
   - It creates a JWE (encrypted JWT) with the session data
   - Calls `setCookie(COOKIE_NAME, jwe, ...)` to write `eex.session` as HttpOnly
   - The cookie carries the user's Plex token and role so admin routes can act on their behalf

7. **Admin gate check: `server/middleware/auth.ts`**
   - Find `requireAdmin` middleware
   - It reads the session from the JWE cookie
   - Checks `session.role === 'admin'`
   - If not, returns 403

**Checkpoint: Trace the 403 denial path**
1. Edit React state to `role='admin'` (fake admin)
2. Click "Send Invite"
3. Frontend POSTs to `POST /admin/invites` with the form data
4. Server receives the request, reads the `eex.session` cookie, decrypts the JWE
5. Calls `requireAdmin` middleware
6. The JWE contains the real `role='user'` from the database
7. Middleware checks `role === 'admin'` → false
8. Returns 403 Forbidden

**This proves the server gate is the real trust boundary.**

**Live verification**:
- Open DevTools → Application → Cookies → filter `eex.session`
- It shows HttpOnly, Secure, SameSite flags ✓
- Try copying its value; it's unreadable (encrypted JWE)
- The browser *cannot* decrypt it; only the server can
- Therefore, no client-side fakery can spoof admin role

---

