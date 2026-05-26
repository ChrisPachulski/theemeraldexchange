# Cross-service compatibility contract (M1.5)

> **Status:** DRAFT for review. This document is the M1.5 deliverable. It
> freezes the wire-level shapes shared by Hono (M1), Rust services (M3+M4),
> the recommender (Python/FastAPI), and Apple clients (M2+M5). Nothing in
> M2 starts until this is locked.
>
> **Read first:**
> - `2026-05-25-apple-multiplatform-and-rust-pivot.md` § Cross-service
>   compatibility contract (the inventory that triggered this doc).
> - `2026-05-25-review-findings.md` Tier 7 (codex's blind-spot list — the
>   ones flagged as one-way doors live here).
>
> **Pending user call** (decisions deliberately left open in this draft):
> LICENSE, internal auth boundary, recommender data-model contradiction,
> telemetry posture. Each is captured in §4 / §8 / §11 / §15 with the
> trade-offs and what flips downstream depending on the answer.

## 1. Why this doc exists

After M2 ships a TestFlight build, **every wire shape the app encodes
becomes effectively immutable**. A 1-year `deviceToken` lives in
Keychain. An HMAC stream-grant token format is baked into both the
TypeScript signer and the Rust verifier. A `sub` claim with no prefix
gets persisted into watch-state rows that an Apple Silicon Rust
`media-core` will be reading in M3.

Changing any of those after distribution forces re-pairs, schema
migrations, or breaking server/app version gates. Cheap to change now
while M1 is the only consumer; expensive to change once Apps speak it.

This contract is the freeze. M1 code changes to match (§16) are
expected — that's the "1-2 weeks of work" line item in the
sequencing table.

## 2. M1 as-shipped baseline (the de-facto contract today)

Anything in this section is **what currently exists in `main`**. The
contract decisions below either ratify these shapes or call out
breaking deltas that must apply before M2.

### 2.1 Session cookie (browser, M1)

- File: `server/session.ts`.
- Format: JWE, `{alg: 'dir', enc: 'A256GCM'}`, key = `SHA-256(SESSION_SECRET)`.
- Cookie name: `eex.session`. HttpOnly, Secure in prod, SameSite=None in
  prod / Lax in dev.
- TTL: 30 days. Stateless — rotating `SESSION_SECRET` invalidates every
  live session.
- Payload: `{sub: string, username, role: 'admin'|'user', plexAuthToken?, verifiedPlexServerId?}`.
- `sub` value: Plex user ID as string (e.g., `"12345"`). **No namespace prefix.**

### 2.2 Stream-grant HMAC token (any client, M1)

- File: `server/services/iptvStreamToken.ts`.
- Format: `b64url(JSON.stringify({kind, resourceId, sub, exp})) + "." + b64url(HMAC-SHA256(secret, body))`.
- `kind`: `'live' | 'vod' | 'series' | 'catchup' | 'segment' | 'remux' | 'playlist'`.
- `resourceId`: stringly typed. For catchup, encodes `streamId|startUtc|durationMin`.
- `sub`: Plex user ID string. No prefix.
- `exp`: Unix seconds.
- **Signing key**: `env.sessionSecret` — the same secret as JWE session
  derivation. (See §5.4: this is a contract violation we want to fix in M1.5.)
- **No `jti`, no nonce, no `iss`, no `server_id`.**
- `JSON.stringify` byte ordering follows V8 insertion order of the object
  literal in `signStreamToken`: `{kind, resourceId, sub, exp}`. This order
  is spec-mandated by ECMA-262 for non-integer string keys (ES2015+) and is
  deterministic within any conforming JS engine. **However, it is not
  portable to Rust**: `serde_json::to_string` serialises struct fields in
  declaration order (not insertion order), so the HMAC bytes diverge when the
  Rust verifier in M3 reconstructs the signed payload. Canonical JSON
  (RFC 8785 alphabetical key order) is required for cross-language
  portability — see §5.1.

### 2.3 Concurrency session record (M1)

- File: `server/services/iptvConcurrency.ts`.
- `SessionKind` (the *tracker* kind, not the *token* kind): `'live' | 'vod' | 'series' | 'catchup' | 'remux'`.
- **`'remux'` is a dual-membership kind**: it appears in both `StreamKind`
  (token) and `SessionKind` (tracker). It is emitted as a token kind by
  remux endpoints — `server/routes/iptv.ts` lines 412 and 519 both call
  `signStreamToken({kind:'remux',...})`, and `rewriteRemuxManifest` mints
  per-segment remux tokens. The concurrency tracker simultaneously records
  a `SessionKind = 'remux'` entry on the same code path.
- **`'segment'` and `'playlist'` are token-only**: the tracker has no slot
  for them because they don't correspond to user-visible playback sessions.
  HLS segment fetches are sub-operations of an existing session; playlist
  grants are a URL delivery mechanism, not a separate concurrency consumer.
- M1.5 normalises the documentation of these relationships (§5.3); it does
  **not** remove `'remux'` from `StreamKind`.

### 2.4 Migrations on disk

- `iptv.db`: `server/migrations/iptv/0001_init.sql`. One file. Migrator
  applies in order, tracks applied versions in (TBD — resolved by §7.1's
  `schema_migrations` convention; D8 applies it).
- `exchange.db` (recommender): `recommender/migrations/000N_*.sql`,
  five files through `0005_iptv_kinds.sql`. Migrator: Python.

### 2.5 Identity at the edges

- Plex PIN OAuth → `sub = <plex_user_id_as_string>` everywhere.
- `iptv_favorites.sub`, `iptv_watch_history.sub`, JWE `sub`, HMAC token
  `sub` — all the same string, all unprefixed.

### 2.6 Recommender ↔ iptv data flow

Two independent paths today, both in production:

1. **Cross-DB join** (the only path `available_on` badges actually use):
   `server/migrations/iptv/0001_init.sql` defines `iptv_title_link
   (iptv_kind, iptv_id, tmdb_kind, tmdb_id)`. `server/services/iptvSync.ts`
   populates it on every catalog sync. `server/routes/suggestions.ts`
   `tagIptvAvailability` reads it to add `'iptv'` to `available_on[]`.
2. **Per-source title rows**: `recommender/workers/iptv_ingest.py`
   pulls `GET /api/iptv/export/recommender`, upserts mybunny VOD/series
   into `exchange.db.titles` under kinds `iptv_vod` / `iptv_series` via
   migration `0005_iptv_kinds.sql`. **These rows are not currently consumed
   by `available_on` badge logic.** They sit in the table for use by the
   ranker via `kind`-aware retrieval, but nothing reads them as IPTV
   specifically.

This is the contradiction codex flagged. See §9.

### 2.7 Health / version surface

- `GET /api/health` → `{ok: true}`. No version. No schema state.
- `GET /api/iptv/health` → `{expiresAt, maxConnections, activeConnections, status}` (Xtream upstream status only).
- **No `/api/version` exists today.** Required before M2 ships (§12).
- `GET /api/iptv/export/recommender` is secret-gated by header
  `x-iptv-export-secret` matched against env `IPTV_RECOMMENDER_EXPORT_SECRET`.
  No session auth. Permanently returns 403 if the env var is unset (the guard
  is `!env.IPTV_RECOMMENDER_EXPORT_SECRET || secret !== env.IPTV_RECOMMENDER_EXPORT_SECRET`).
  Response shape: `{vod: [...], series: [...]}` (verbatim from
  `server/routes/iptv.ts:935`). The Python `iptv_ingest.py` worker consumes
  this exact shape. **Contract status of this endpoint is conditional on §9
  outcome** — Resolution A deletes the endpoint; Resolutions B/C/D require
  it to remain stable.

---

## 3. External auth token (device JWE for M2+ apps)

The M2 apps need a long-lived bearer token that survives in iOS/tvOS
Keychain. M1 cookie sessions don't apply.

### 3.1 Decision: format

| Option | Pros | Cons |
|---|---|---|
| Re-use the JWE shape from §2.1 with `aud: 'device'` | Lowest blast-radius change. One verifier path in Hono. | Same secret protects both 30-day cookies and 1-year device tokens. Compromise scope inflates. |
| New JWE with separate signing secret (`DEVICE_TOKEN_SECRET`) | Key separation. Independent rotation. Device-token revocation = rotate one secret without forcing browser re-auth. | Two secrets to operate. Two verifier paths. |

**Decision: separate secret.** Keychain-resident long-lived tokens are
a meaningfully different threat surface than a 30-day cookie. A single
secret means rotating it because a phone was compromised would also log
out every browser — operationally painful, so rotation becomes
theoretical. The threat-isolation value of key separation is only
realised if the secrets are kept distinct at runtime.

**Boot-time guard (required):** The server MUST verify on startup that
`DEVICE_TOKEN_SECRET`, `SESSION_SECRET`, and `STREAM_TOKEN_SECRET` are
all pairwise distinct. If any two of these values are equal, the server
MUST refuse to start and emit a fatal log:

```
FATAL: DEVICE_TOKEN_SECRET and SESSION_SECRET must be different values.
Shared secrets defeat key-separation. Set distinct secrets in your
environment and restart.
```

Apply the same check for every pair. This guard runs once at boot in
`server/env.ts` alongside the existing env validation logic.

**Note on session cookie `aud` asymmetry:** Device tokens carry
`aud: 'device'` (§3.2 below). Session cookies intentionally omit `aud`;
key separation is the discriminator between the two token types. Do not
add `aud: 'cookie'` to existing cookies without a migration plan
equivalent to §8.2 — naively adding it would invalidate every live
30-day session.

### 3.2 Decision: claims

Locked claims:

```
{
  "sub":       "plex:<plexUserId>" | "local:<localUserId>" | "apple:<appleSubject>",
  "aud":       "device",
  "iss":       "eex",
  "jti":       "<ulid>",
  "server_id": "<server uuid v4, stable per install>",
  "auth_mode": "plex" | "local" | "apple",
  "role":      "admin" | "user",
  "device": {
    "id":       "<client-generated ulid, stored in Keychain>",
    "platform": "<string>   // advisory: 'tvos' | 'ios' | 'ipados' | 'macos'"
  },
  "iat": <unix>,
  "nbf": <unix>,   // == iat at mint; for clock-skew gate symmetry with §5.7
  "exp": <unix>    // iat + 180 days, hard cap (see §3.5)
}
```

Claim-by-claim rationale:

- `sub`: namespace-prefixed per §8. Locked. `auth_mode` MUST match the
  `sub` prefix (`plex:` → `'plex'`, `local:` → `'local'`,
  `apple:` → `'apple'`).
- `aud: 'device'`: lets the verifier reject cookie-shaped tokens
  presented as bearer. Locked.
- `iss: 'eex'`: locked.
- `jti`: ULID. Used for revocation (§3.4) and registration (§3.5). Locked.
- `server_id`: the self-hosted server's stable UUID, generated on first
  boot (§12.3), stored in `server_state` table. On validation the server
  checks `token.server_id == own server_id` and rejects tokens issued
  by a different install (honest 401; app re-pairs). Locked from day one
  even though v1 is single-server.
- `auth_mode: 'plex' | 'local' | 'apple'`: the auth provider used at
  mint time, matching the `sub` prefix. Lets the app render the correct
  re-auth UI without an extra round trip. **`'both'` is eliminated** —
  it had three incompatible interpretations and was undefined behaviour
  waiting to be implemented inconsistently across Swift and Hono.
  Server-side config (which providers are enabled) lives in
  `/api/version`, not in the token.
- `role: 'admin' | 'user'`: mirrors the session cookie role claim
  (§2.1). Required so the device-token verifier can gate admin-only
  endpoints without an additional DB lookup on every request. A token
  minted without `role` cannot be upgraded to carry it without re-pair —
  this is a one-way door; include it from day one.
- `device.id`: client-generated ULID, stored in Keychain, used as the
  stable device identity key in the `device_tokens` registration table
  (§3.4). Locked.
- `device.platform`: open `string`. Advisory valid values:
  `'tvos' | 'ios' | 'ipados' | 'macos'`. Validators MUST warn on
  unknown values but MUST NOT reject the token. A closed enum in the
  contract would require a Rust/Swift verifier update the moment any
  non-Apple client is introduced; an open string costs nothing at mint
  and preserves forward compatibility.
- `device.name`: **NOT in the JWE.** Moved server-side to the
  `device_tokens` registration table (§3.4). The token's mint-time name
  may be supplied by the client in the pairing request body and written
  into that table; it is NOT embedded in the encrypted payload. Mutable
  display metadata does not belong in an immutable bearer token — a user
  who moves an Apple TV from the living room to the bedroom cannot
  rename it without re-pairing if the name is locked in the JWE.
- `device.app_version`: **NOT in the JWE.** Removed for the same
  reason. The installed version goes stale on every app update. Source
  it from a request header (`X-App-Version: <semver>`) and persist
  server-side in `device_tokens.last_seen_version` (updated on each
  authenticated request). This gives the operator "Devices" admin view
  the *current* version, not the mint-time version. Version gating is
  already handled via `MIN_CLIENT_VERSION` and `426 Upgrade Required`
  (§12.2) — the token-embedded version is redundant for gating and
  harmful as display data.
- `iat`, `nbf`, `exp`: standard RFC 7519 claims. `nbf == iat` at mint.
  Adding `nbf` aligns with the stream-token shape (§5.2) and allows the
  verifier to reuse the same clock-skew gate logic across both token
  types without custom `iat`-based special-casing.

### 3.3 Decision: algorithm

- `alg: 'dir'`, `enc: 'A256GCM'`. Symmetric, key derived via
  HKDF-Extract+Expand (RFC 5869, SHA-256) over `DEVICE_TOKEN_SECRET`
  with `info = Buffer.from('eex/device-token/v1')`:

  ```typescript
  import { hkdfSync } from 'node:crypto';
  const key = hkdfSync('sha256', env.deviceTokenSecret, '', 'eex/device-token/v1', 32);
  ```

  This is the recommended derivation. The same HKDF pattern is
  recommended for the session-cookie key derivation in `session.ts`
  (D-row in §16; converts the plain SHA-256 call to HKDF). The verifier
  change is backward-compatible with tokens minted under the old plain
  SHA-256 derivation **if and only if** both derivation changes land in
  the same release — the raw SHA-256 key and the HKDF-derived key for
  the same secret are different bytes, so an old token cannot be
  decrypted by the new verifier. Co-deploy the derivation change with a
  key rotation (new `DEVICE_TOKEN_SECRET` value); all existing tokens
  remain valid under `kid: 'device-v1'` until they expire, new tokens
  use `kid: 'device-v2'` per §3.6.

  Plain SHA-256 is not cryptographically broken for a high-entropy
  secret, but HKDF provides formal domain separation via the `info`
  parameter. Use HKDF for all new code; do not introduce a third
  derivation pattern.

- **Reject asymmetric (`RSA-OAEP` / `ECDH-ES`)**: there is only one
  issuer (this server) and one verifier (Hono under §4 Option A). The
  asymmetric advantage — public verification without secret distribution
  — only pays off when Rust media-core independently verifies device
  tokens (§4 Option B). If the §4 decision ever reverses to Option B,
  revisit this section: `ECDH-ES` with per-token ephemeral key wrapping
  the CEK becomes attractive when the verifier secret must cross a
  process boundary. Under Option A, `dir` is strictly correct.

### 3.4 Decision: revocation

**Schema (two tables, both in `server.db`** — NOT `iptv.db`, so that the IPTV_DISABLED insurance build per §13.3 still has device-token machinery available**):**

```sql
CREATE TABLE device_tokens (
  jti              TEXT PRIMARY KEY,
  sub              TEXT NOT NULL,
  device_id        TEXT NOT NULL,
  device_name      TEXT NOT NULL,      -- mutable; updated via admin UI
  platform         TEXT NOT NULL,
  issued_at        TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  last_seen_at     TEXT,               -- updated on every authenticated request
  last_seen_version TEXT               -- from X-App-Version header
);

CREATE TABLE device_token_revocations (
  jti        TEXT PRIMARY KEY,
  revoked_at TEXT NOT NULL,
  reason     TEXT NOT NULL
);
```

A row is inserted into `device_tokens` on every token mint (during the
PIN pairing flow). The `device_name` column is the authoritative,
mutable display name — update via `PATCH /api/admin/devices/:jti` or
the user-facing rename UI. It is NOT sourced from the JWE (§3.2).

**Verifier check order (all must pass):**

1. JWE decryption succeeds (kid lookup → key resolution → `jwtDecrypt`
   per §3.6).
2. `jti` NOT present in `device_token_revocations` (in-process cache
   lookup, O(1)).
3. Row EXISTS in `device_tokens` for this `jti` (confirms the token was
   issued by this server, not forged; also allows `last_seen_at` update).
4. `exp` not passed (standard claim check).
5. `server_id` matches own server's UUID (§12.3).

If step 2 fails → `401 {"error":"token_revoked"}`.
If step 4 fails → `401 {"error":"token_expired"}`.
If step 5 fails → `401 {"error":"server_mismatch"}`.
Server errors in the verification path → `503 {"error":"server_error"}`.
The app uses these codes to show the correct UX (re-pair screen, expiry
prompt, or retry spinner).

**In-process revocation cache:**

Replace all bloom-filter language from the draft. A bloom filter is
wrong for this use case: false positives produce a silent permanent
lockout with no user-recoverable path (the PIN re-pair flow itself
requires a valid session on another device), and the set size is
trivially small (dozens to low-hundreds of revoked `jti` values over the
lifetime of a household install). A `Set<string>` loaded at module init
is O(1) lookup with zero false-positive risk:

```typescript
// In deviceTokenMiddleware.ts module scope
let revokedJtis: Set<string> = new Set(
  db.prepare('SELECT jti FROM device_token_revocations').all().map(r => r.jti)
);

export function invalidateRevocationCache(): void {
  revokedJtis = new Set(
    db.prepare('SELECT jti FROM device_token_revocations').all().map(r => r.jti)
  );
}
```

`invalidateRevocationCache()` is called synchronously after every
`INSERT INTO device_token_revocations` that goes through Hono's own
write path. better-sqlite3 is synchronous; the rebuild takes <1ms on a
set of this size. **External writes** to `device_token_revocations`
(operator `sqlite3` shell, incident recovery) take effect only after a
server restart — document this in the operator guide.

**Operator "Devices" admin surface:**

- List view: `SELECT dt.*, dtr.revoked_at FROM device_tokens dt LEFT JOIN device_token_revocations dtr ON dt.jti = dtr.jti` — shows active and revoked devices with the authoritative mutable `device_name`.
- Revoke button per row → `POST /api/admin/devices/:jti/revoke` → inserts into `device_token_revocations`, calls `invalidateRevocationCache()`.
- Rename inline → `PATCH /api/admin/devices/:jti` → updates `device_tokens.device_name` only; no token change required.
- "Sign out everywhere" button → `DELETE /api/devices` (user-facing,
  cookie or device-token auth, sub inferred from session) → batch-inserts
  every `jti` for the caller's `sub` into `device_token_revocations` with
  `reason = 'logout_all'`, calls `invalidateRevocationCache()`.

**Device self-revoke on logout:**

`DELETE /api/devices/self` (device-token auth) → inserts the calling
token's `jti` into `device_token_revocations` with `reason = 'logout'`,
calls `invalidateRevocationCache()`.

**Plex cascade revocation:**

The device-token path does NOT reuse `reconcileSession`. `reconcileSession`
operates on cookies and has no knowledge of `device_tokens` rows or
multi-token enumeration. A separate function `reconcileDeviceToken(jti,
sub)` is required:

```
1. Look up sub via device_tokens WHERE jti = ?
2. If sub starts with 'plex:', call Plex membership check (same
   HTTP call as reconcileSession's Plex revalidation).
3. If Plex says the user is no longer a member:
   a. SELECT jti FROM device_tokens WHERE sub = ? (all tokens for this sub)
   b. INSERT all found jti values INTO device_token_revocations
      with reason = 'plex_membership_revoked'
   c. Call invalidateRevocationCache()
   d. Return { ok: false, reason: 'access_revoked' }
4. Otherwise return { ok: true, session }
```

The device-token verifier middleware must pass the validated `jti` and
`sub` to `reconcileDeviceToken`. Without this, the Plex cascade revocation
described in the draft is aspirational text with no implementation path
— `reconcileSession` today only clears the cookie, it does not write to
`device_token_revocations`.

**Recovery note for operator:** If a device is locked out and the user
has no other authenticated device to initiate the PIN re-pair flow, the
operator recovery path is: `DELETE FROM device_token_revocations WHERE
jti = '<jti>';` from the SQLite shell, then restart the server to flush
the in-process cache. Document this in the operator guide.

### 3.5 Decision: rotation policy

- Tokens are immutable. Rotation = revoke + re-pair via the PIN flow.
- **Hard cap: 180 days.** Replaces the 365-day value in the draft.

  Threat-model rationale: the primary failure mode for a household
  streaming device is a stolen Apple TV left in a drawer after
  replacement. At 365 days a valid token on that device has a 12-month
  blast radius; at 180 days it is 6 months. The re-pair flow is a
  60-second PIN entry — not a meaningful friction increase for a user
  who is actively using the device. The 180-day cap is also aligned
  with Apple MDM's 180-day maximum device enrollment token validity for
  non-user-enrolled devices.

  Plex's permanent legacy tokens were the subject of CVE-2025-69414
  (CVSS 8.5). Jellyfin and Emby both default to indefinite tokens.
  This contract takes a deliberately stricter position — one that has
  real teeth only because it is paired with the `jti` revocation
  infrastructure in §3.4. A long TTL without a revocation table is a
  design smell; 180 days with per-`jti` immediate revocation is
  defensible.

- **No silent extension, no refresh tokens.**

- **Re-pair trigger (app responsibility):**
  The app MUST inspect `exp` in the stored device token on every
  foreground activation. If `now > exp - 30d` (i.e., within the final
  30 days of the 180-day window, which is at the 150-day mark), the app
  shows a non-blocking banner prompting re-pair during normal use. If
  `now >= exp`, the app blocks navigation with a full re-pair screen
  before any server call. The server does NOT push expiry warnings; the
  app is the authority on its own stored token's `exp`.

  Exact re-pair UX (sheet vs banner, dismissibility, mid-playback
  behavior) is deferred to the M2 UX spec. What is locked here is the
  server/app responsibility boundary: expiry detection is client-side,
  expiry enforcement is server-side (token rejected on `exp` check in
  §3.4 verifier).

- **Re-pair flow:** PIN-based, identical to initial pairing. The app
  displays the pairing PIN/URL in-app. Server issues a new device token
  and a new `device_tokens` row; app replaces the old Keychain item.
  The app MAY send `DELETE /api/devices/self` to insert the old `jti`
  into revocations immediately; if it does not, the old token expires
  naturally at its `exp`.

### 3.6 Decision: key ID

- `kid` header on the JWE: `"device-v1"`. Locked.
- Future rotation: introduce `"device-v2"` with a new `DEVICE_TOKEN_SECRET`
  value and re-derived HKDF key; verifier accepts both for the overlap
  window, rejects `"device-v1"` post-cutover.

**Critical implementation note — `jose` symmetric multi-key pattern:**

The naive single-key pattern from M1's `session.ts`:

```typescript
const { payload } = await jwtDecrypt(token, key);  // DOES NOT WORK FOR KID ROTATION
```

`jwtDecrypt` accepts a single `KeyLike` or `Uint8Array`. For symmetric
`dir`/A256GCM it does NOT iterate multiple keys the way `jwtVerify` can
accept a JWK Set for asymmetric algorithms. A developer copying
`session.ts` verbatim for device tokens will produce a verifier that
silently returns `JWEDecryptionFailed` on any token minted with a
different `kid` — logging out every device on rotation day with no
diagnostic trail.

The verifier MUST use the following pattern:

```typescript
import { decodeProtectedHeader, jwtDecrypt } from 'jose';

const keyMap = new Map<string, Uint8Array>([
  ['device-v1', hkdfDeriveKey(env.deviceTokenSecretV1, 'eex/device-token/v1')],
  // add 'device-v2' here when rotating:
  // ['device-v2', hkdfDeriveKey(env.deviceTokenSecretV2, 'eex/device-token/v2')],
]);

async function decryptDeviceToken(token: string) {
  const { kid } = decodeProtectedHeader(token);
  const key = keyMap.get(kid ?? '');
  if (!key) throw new JWEInvalidError(`unknown kid: ${kid}`);
  return jwtDecrypt(token, key);
}
```

Step-by-step:
1. Call `decodeProtectedHeader(token).kid` to extract the `kid` BEFORE
   attempting decryption — this is a cheap base64url decode, not a
   crypto operation.
2. Look up `kid` in a `Map<string, KeyMaterial>`.
3. If `kid` is absent from the map, reject immediately with a clear
   error. Do NOT attempt to iterate all keys — that would allow `kid`
   enumeration attacks.
4. Pass the resolved key to `jwtDecrypt(token, resolvedKey)`.

This reference implementation MUST land in §16 deltas (add a D-row for
the device-token verifier), not be left for an engineer to discover by
reading `jose` source. The M2 test-vector set (§13.1) MUST include a
`device-token-kid-rotation.json` vector: a `device-v1`-kid token and a
`device-v2`-kid token that both decrypt correctly with their respective
keys.

### 3.7 Keychain storage requirements (Apple platforms)

All device token Keychain items on Apple platforms MUST be stored with
the following attributes. These are hard requirements, not
recommendations.

**Accessibility attribute:**

```swift
kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
```

`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` is the only correct
choice for this use case:

- `kSecAttrAccessibleWhenUnlocked` is **forbidden on tvOS**. tvOS has
  no conventional lock/unlock cycle — the device transitions to
  screensaver rather than a locked state. Keychain items stored with
  `WhenUnlocked` accessibility may be inaccessible during background
  refresh and at boot before first foreground interaction, causing
  silent auth failures that are extremely difficult to diagnose.
- The `ThisDeviceOnly` suffix prevents migration: items are encrypted
  with the device's hardware UID and do not appear in iCloud backup
  restores. Restored devices must re-pair. This is intentional (§3.5).
- `kSecAttrAccessibleAfterFirstUnlock` (without `ThisDeviceOnly`) is
  acceptable on iOS from a background-accessibility standpoint but
  allows iCloud Keychain migration on encrypted device backups. Do not
  use it — a restored device would receive the old token bound to a
  different physical device's `device.id`, producing stale registration
  state in `device_tokens` with no server-side detection.

**Biometric access control:**

```swift
// kSecAccessControlBiometryAny: NOT USED
```

Biometric access control (`kSecAccessControlBiometryAny`,
`kSecAccessControlBiometryCurrentSet`) is unavailable on tvOS hardware.
Apple TV has no biometric sensor. Setting biometric access control on a
tvOS Keychain item will cause the item to be permanently inaccessible.
Do not add biometric ACL to this item on any platform for consistency —
the token is a service credential, not a user-confirmable transaction.

**iCloud sync:**

```swift
kSecAttrSynchronizable: kCFBooleanFalse  // or omit entirely (defaults to NO)
```

`kSecAttrSynchronizable: kCFBooleanTrue` is **disallowed**. iCloud
Keychain migration would allow a restored device to receive a valid
token without going through the PIN pairing flow, bypassing the
`device_tokens` registration record and `last_seen_at` tracking. tvOS
silently ignores `kSecAttrSynchronizable: YES` — the attribute is
accepted without error but the item is never actually synced — making
any accidental iOS/macOS use of `YES` produce divergent behavior across
platforms.

Document in app UX copy: "If you set up a new device, you will need to
pair again."

**Multi-server Keychain key format:**

Each paired server MUST store its device token under a distinct Keychain
item. The `kSecAttrAccount` or `kSecAttrService` key for each item MUST
encode the server identity:

```
kSecAttrService = "eex.deviceToken"
kSecAttrAccount = "<server_id>"   // the UUID from /api/version
```

Apps that pair to multiple servers do NOT overwrite earlier items. Each
server's token is a discrete Keychain entry keyed by `server_id`. The
`server_id` comes from the `/api/version` response during the initial
pairing handshake (§12.1).

**Swift decryption hint:**

For `alg: 'dir'`, `enc: 'A256GCM'` tokens, use `CryptoKit.AES.GCM`
directly rather than a JOSE library. The JWE compact serialization is
five dot-separated base64url components; for `dir` there is no key
encryption step (component[1] is empty), making the structure trivially
parseable:

```swift
// Approximately 40 lines; no external dependency
func decryptDeviceToken(_ compact: String, key: SymmetricKey) throws -> [String: Any] {
    let parts = compact.split(separator: ".", maxSplits: 4, omittingEmptySubsequences: false)
    guard parts.count == 5 else { throw TokenError.malformed }
    // parts[0] = protected header (base64url)
    // parts[1] = encrypted key (empty for dir)
    // parts[2] = IV (base64url, 12 bytes for A256GCM)
    // parts[3] = ciphertext (base64url)
    // parts[4] = authentication tag (base64url, 16 bytes for A256GCM)
    let iv   = try base64URLDecode(String(parts[2]))
    let ct   = try base64URLDecode(String(parts[3]))
    let tag  = try base64URLDecode(String(parts[4]))
    let aad  = Data(parts[0].utf8)   // protected header is the AAD
    let sealedBox = try AES.GCM.SealedBox(nonce: .init(data: iv),
                                           ciphertext: ct,
                                           tag: tag)
    let plaintext = try AES.GCM.open(sealedBox, using: key,
                                     authenticating: aad)
    return try JSONSerialization.jsonObject(with: plaintext) as! [String: Any]
}
```

If a JOSE library is preferred for future algorithm agility, use
`airsidemobile/JOSESwift` >= 3.0.0 (tvOS 15.0 minimum deployment
target) or `beatt83/jose-swift`. Explicitly test the `dir + A256GCM`
combination with the vectors from §13.1 — this specific combination
requires verification against the library version in use.

---

## 4. Internal auth boundary [PICKED]

**Decision (2026-05-25): Hybrid D — signed-and-encrypted internal token, with the canonical crypto implementation in Rust (`emerald-contracts` crate per §17), called from Hono via N-API and from Python via PyO3.**

Rationale:
- **Defense in depth without OS-dependent code paths.** Option A's HMAC-signed header is the industry-standard pattern (6 of 7 comparable products); D adds a JWE confidentiality layer over A so the principal claim is encrypted on the wire. Same architecture as A, +6h cost, no Unix-socket or cert-rotation operational tax.
- **Cross-OS uniform.** Identical behavior on Linux / macOS / Windows / Docker / Synology / TrueNAS / Raspberry Pi. No `SO_PEERCRED` quirks, no mTLS-over-Unix-socket workaround for non-Linux hosts.
- **No multi-host lock-in.** Future split of services across machines (e.g., dedicated transcoder host) works with no rewrite — the auth wire format is HTTP-transportable.
- **Rust-canonical implementation.** All HMAC + JWE crypto code lives in the `emerald-contracts` Rust crate. Hono links via N-API (Node native module). Python links via PyO3. Single source of truth for the auth logic; the other languages are thin wrappers. Reuses the test-vector discipline §17 already plans.
- **B rejected** because the `plexAuthToken` telemetry exposure is the only true one-way door across all four options (see a4-oneway-door.md) and Rust never needs to authorize users without Hono in front in this topology.
- **C rejected** despite its theoretical elegance: OS-dependent code paths (Linux peer-cred vs macOS mTLS-fallback vs Windows quirks) defeat the cross-OS goal, cost is 2x A, and the multi-host lock-in is a real foreclosure.

Implementation cost: 27h baseline (D) + ~5–10h to wire N-API/PyO3 bindings to `emerald-contracts` = **~33–37h total**. The `emerald-contracts` crate itself is already in §16 D17.

Subtle hazard to mitigate: **AES-GCM nonce reuse is catastrophic** — if a developer hand-rolls the encryption path, the HMAC signing key becomes recoverable. Mitigation: use `josekit` (Rust) and `jose` (Node/TS) library defaults; do not implement AES-GCM directly. CI test vector at `tests/vectors/internal-principal.json` covers the round-trip and nonce-uniqueness assertions.

> **This is a one-way door.** Reversing the decision means rewriting
> media-core's auth layer mid-stream. Pick was locked 2026-05-25.

The rest of this section retains the Option A / B / C / D descriptions for audit-trail purposes; the chosen path is D. Section §16's D-row inventory updates accordingly: D-row for the JWE wrapping layer + N-API binding + PyO3 binding lands as part of the M1.5 implementation work.

---

### Option A — Hono is the only authenticator

Hono validates the device-token or session cookie at the edge, then
mints a short-lived internal principal assertion JWT signed with
`INTERNAL_PRINCIPAL_SECRET`, passing it as `X-Internal-Principal` to
Rust services on localhost. Rust validates the signature only — no JWE
decryption, no Plex reconciliation.

#### Option A: internal principal claim shape (locked)

```jsonc
{
  "iss":       "eex-hono",
  "sub":       "<namespaced per §8, e.g. plex:12345>",
  "role":      "admin" | "user",
  "auth_mode": "plex" | "local" | "apple",  // matches §3.2 device-token auth_mode (which dropped 'both' — server config-mode lives in /api/version, not in tokens)
  "server_id": "<stable server uuid, per §12.3>",
  "device_id": "<ulid | null>",              // null for browser/cookie sessions
  "req_id":    "<ulid>",                     // minted per Hono→Rust call; enables distributed-trace correlation across Hono → media-core → transcoder log lines
  "iat":       <unix>,
  "exp":       <unix>                        // iat + 60s
}
```

Why each field:

- `req_id` (ULID): correlates a single Hono-to-Rust call across both
  processes' logs. Without it, matching a Rust error to the Hono request
  that triggered it requires timestamp-bracketing — fragile under load.
- `device_id`: lets Rust log which device initiated a session. Also
  lets a stream be identified as originating from a device whose token
  is mid-revocation (the revocation happens in Hono, but Rust's audit
  trail can carry the device handle).
- `auth_mode`: lets Rust enforce provider-specific rules (e.g., a
  future "Plex-only" resource) without re-decrypting any JWE.
- `iat`: closes the replay window within the 60s validity period. `exp`
  alone does not.

A test vector for this claim shape must be added to
`tests/vectors/internal-principal.json` alongside stream-token and
device-token vectors. Both the Hono token-minting code and the Rust
verifier consume it.

#### Option A: multi-hop TTL policy

The internal principal is **single-hop by default**. Each Hono→Rust
call mints a fresh token with a 60s TTL. The 60s covers the slowest
realistic transcoder spawn observed in testing (~2–5s) with substantial
headroom.

If M4 introduces a Hono → media-core → transcoder chain, choose one of
these policies before M4 work begins — do not inherit the default:

| Policy | Mechanics | Trade-off |
|---|---|---|
| **Single-hop only** (recommended default) | Hono mints a fresh assertion for each direct Rust call. Media-core re-calls Hono for any downstream transcoder hop it needs to authorise. | Simplest trust model. Each hop is independently authorised. Adds one round-trip per transcoder invocation. |
| **Multi-hop with bumped TTL** | TTL raised to 120s. Downstream services accept upstream-minted assertions without re-minting. | Fewer round-trips. Wider replay window. Downstream services must trust the upstream's claim set without re-verification against Hono. |

Document the chosen policy here before M3 ships.

#### Option A: `INTERNAL_PRINCIPAL_SECRET` transport

The secret is shared between Hono and Rust on the same host. Three
delivery mechanisms, in order of preference:

| Mechanism | How | Risk surface |
|---|---|---|
| **Docker Compose `secrets:` block** (preferred) | Mount a file-mode-600 keyfile into both containers at the same path (e.g., `/run/secrets/internal_key`). Each process reads the file at startup. | Smallest leak surface. The secret is not an env var, not visible in `docker inspect`, not logged by Compose. |
| **Env var on both processes** | `INTERNAL_PRINCIPAL_SECRET=...` in the Compose `environment:` block. | Acceptable for single-host NAS deployments. Visible in `docker inspect`, process environment, and any logging of `env` output. Operator must never expose the env. |
| **Unix domain socket** | Hono and Rust communicate over `/run/eex/internal.sock`. mTLS or filesystem ACL is the trust boundary. `INTERNAL_PRINCIPAL_SECRET` is eliminated entirely — the socket handshake is the proof of identity. | Strongest posture for single-host NAS. Eliminates header-forgery risk on the network path. Adds mTLS cert management. See Option C hybrid below. |

Regardless of mechanism: `INTERNAL_PRINCIPAL_SECRET` must be a
dedicated secret, not derived from `SESSION_SECRET`,
`DEVICE_TOKEN_SECRET`, or `STREAM_TOKEN_SECRET`.

Network model requirement: the Rust service must not publish ports to
the host (no `ports:` in Compose, or ports bound to `127.0.0.1` only).
Hono and Rust must be on a named Docker network, not the default bridge.
"Containerised correctly" in the original draft is insufficient as a
security specification.

#### Option A: dev-mode bypass

Tests of M3 and M4 Rust services would otherwise require a running Hono
instance. To avoid a mandatory two-process dependency during development:

- Rust services accept an unsigned `X-Internal-Principal-Bypass: 1`
  header **only** when `RUST_ENV=development`.
- When the bypass is active, the request is treated as an authenticated
  `local:dev` principal with `role: admin`.
- Stripped from production builds via conditional compilation
  (`#[cfg(not(feature = "prod"))]` or equivalent).
- Alternatively: the test vector file `tests/vectors/internal-principal.json`
  includes a pre-signed assertion using a well-known test key
  (`INTERNAL_PRINCIPAL_SECRET=test-key-for-vectors`), usable in Rust
  unit tests without Hono running.

This is a quality-of-life note, not a one-way door. Document the chosen
approach before M3 starts.

#### Option A trade-off summary

**Advantages:** Simplest implementation. Single Plex-reconciliation path
(Hono only). Rust services are lightweight validators. Smallest audit
surface in the Rust binary.

**Disadvantages:** Requires an airtight network model — any process
that can reach the Rust service on localhost and forge the
`X-Internal-Principal` header with a valid signature bypasses auth
entirely. The security guarantee is only as strong as `INTERNAL_PRINCIPAL_SECRET`
secrecy and network isolation. If Rust services are ever exposed on a
non-localhost interface (misconfiguration, future multi-host deployment),
the entire auth boundary collapses.

---

### Option B — Rust services independently decrypt user JWEs

Hono passes the raw user device-token or session cookie to Rust. Rust
runs the same JWE decryption (A256GCM, key derived from
`SESSION_SECRET` or `DEVICE_TOKEN_SECRET`). Rust runs the same Plex
reconciliation logic ported from TypeScript.

#### Option B: the `plexAuthToken` leak

The M1 session cookie JWE payload (§2.1) includes `plexAuthToken?`
and `verifiedPlexServerId?`. The device JWE (§3.2) does not include
either field.

Under Option B, Rust independently decrypts both JWE shapes. This means:

- **Browser cookie sessions:** the JWE presented to Rust contains a
  live Plex auth token. Even if Rust discards it, the token lands in
  Rust process memory, appears in Rust error logs if the payload is
  logged on decode failure, and ends up in core dumps on process crash.
- **Device-token sessions:** the device JWE has no `plexAuthToken`
  field. No leak for Apple clients.

This creates an asymmetry: Rust must handle two JWE payload shapes
(cookie-shaped with `plexAuthToken`, device-shaped without) and treat
them differently. A single logging call — `tracing::debug!("{:?}", claims)` —
on the cookie-shaped payload logs a live Plex credential to disk.

**If Option B is chosen, the following constraint is mandatory and
must be CI-enforced, not left to code review:**

> The Rust `UserClaims` struct for cookie-session JWEs must not have
> fields for `plexAuthToken` or `verifiedPlexServerId`. Use
> `#[serde(skip)]` on any field that would capture these values, or use
> a selective deserialiser that extracts only `{sub, role, aud, exp,
> iat}`. This must be a struct-level constraint, not a runtime check.

Additionally: if M3 only ever serves device-token users (Apple clients
via §3), Rust can reject cookie-shaped JWEs entirely (`aud != 'device'`
→ 401) and never see the Plex token. The contract should state whether
Rust is required to accept browser-session JWEs at all in M3.

#### Option B trade-off summary

**Advantages:** Defence in depth. Rust services are independently
usable without Hono (future standalone M3 dev mode without bypass
pattern). Two independent implementations of auth provide mutual
verification.

**Disadvantages:** Doubles the attack surface for token verification
bugs. Two independent Plex reconciliation implementations that can
drift under load in non-obvious ways. Rust binary carries a full JWE
stack. Two JWE payload shapes that must be handled and sanitised
differently.

---

### Why this is your call

- **One-way door for M3 codebase.** Reversing means rewriting
  media-core's auth layer mid-stream.

- **Audit surface size, not license.** The original draft claimed
  Option A is friendlier to closed/proprietary licensing. That framing
  is a category error: both options have security-sensitive code in the
  same repo under the same license. The real argument for A is audit
  surface — the Rust binary's auth code is limited to one HMAC-verify
  call under A. Under B, Rust ships a full JWE stack with correct key
  derivation, which is more code and a larger correctness target
  regardless of license.

- **Telemetry (§15).** Under Option A, Rust never sees raw user
  identity claims — only opaque internal principals. A privacy win if
  you choose local-only or third-party crash reporting. Under Option B,
  Rust sees `sub`, `role`, and (for cookie sessions) `plexAuthToken`
  unless explicitly stripped.

---

### Hybrid options considered

Two architectures between A and B were evaluated and not dismissed:

**Hybrid C — mTLS over Unix domain socket (eliminates secret entirely)**

Hono and Rust communicate over `/run/eex/internal.sock`. Hono holds a
TLS certificate issued by a local CA whose key is embedded at build
time. Rust verifies the certificate chain before accepting any request.

- No `INTERNAL_PRINCIPAL_SECRET` to manage or rotate.
- Header forgery requires Hono's private key — eliminates the
  network-model dependency of Option A.
- mTLS on Unix sockets is supported by axum + rustls and Node.js's
  `tls` module.
- Operational cost: generate a local CA and embed the cert at install
  time. One-time setup, not ongoing ops.
- Internal principal claim shape (without the secret) remains valuable
  for audit: Rust still needs `req_id`, `device_id`, `auth_mode` in a
  signed header.

This is the strongest security posture for single-host NAS deployments.
Overkill for some operators; the contract notes it so a future hardening
pass can adopt it without a design re-do.

**Hybrid D — Signed-and-encrypted internal token (Option A + confidentiality)**

Same as Option A but the internal principal is a JWE (not a plain JWT).
Rust verifies the HMAC signature and decrypts the payload. A network
adversary who forges a valid signature cannot read or forge the encrypted
payload without the symmetric key.

- Adds ~0.1ms per request at A256GCM. Adds the `josekit` or `aes-gcm`
  crate to Rust. Not materially different from Option B's JWE cost for
  this path.
- The decrypted payload is still the internal principal, not the raw
  user JWE — Rust never sees `plexAuthToken`.
- Marginal benefit on a same-host network path; meaningful benefit
  if the internal network boundary is ever less controlled than expected.

---

**Recommendation (non-binding):** Option A. The defence-in-depth value
of B is real, but two independent Plex reconciliation implementations
is the worst kind of operational cost — only visible when they disagree
under load. The `plexAuthToken` leak under B for browser sessions is a
concrete risk requiring a CI-enforced struct constraint, not just a
convention. Option A with the locked claim shape above, file-mode-600
secret delivery, and proper Docker network isolation provides adequate
security for a single-operator self-hosted product.

If you want Rust services portable to non-Hono deployments in the
future, choose Option B — but add the cookie-payload strip constraint
before any Rust code is written.

**Decision impact downstream:** drives §5 (whether Rust verifies
stream-tokens at all or only Hono does), §6 (playlist token model),
§12 (whether `/api/version` is exposed by Rust services), §17
(`emerald-contracts` crate scope — `device_token` module is only
load-bearing under Option B).

---

## 5. Stream-grant HMAC token

The M1 token from §2.2 has five problems for M2: shared secret, non-canonical bytes, no replay
defence, an enum that drifts from the concurrency tracker, and a key-migration plan that leaves
the verifier unspecified. This section resolves all five.

### 5.1 Decision: byte canonicalization

**Canonicalization: fixed-template serializer (NOT RFC 8785 JCS).** Both stacks emit the byte
sequence:

```
{"exp":<int>,"iat":<int>,"jti":"<26-char ULID>","k":"<kind>","nbf":<int>,"rid":"<resourceId>","sub":"<sub>","v":1}
```

Rules:
- Integers serialized as bare decimal (no leading zeros, no decimal point, no exponent).
- Strings JSON-escaped via the minimal set: `\"`, `\\`, `\n`, `\r`, `\t`, `\b`, `\f`, and
  `\uXXXX` for control characters below U+0020. No other escaping.
- No whitespace anywhere in the byte string.
- Output encoding: UTF-8.

Rationale for fixed-template over JCS: the claim struct has exactly 8 keys, all fixed, all
present, no optional or nested fields. RFC 8785 JCS is the right tool when you need a general
canonical serializer for arbitrary JSON. For a frozen flat struct, a fixed-template function
eliminates the entire class of bugs JCS is meant to prevent (IEEE 754 number formatting,
unicode escape normalization, cross-runtime key traversal) while being auditable by inspection.

Reference implementations live in the Rust `emerald-contracts` crate and
`server/services/iptvStreamToken.ts`. Hand-author both from this spec. Do NOT use
`serde_json::to_string` or `JSON.stringify` to produce the HMAC input bytes.

**Rust verifier note:** the verifier MUST NOT use `serde_json::to_string` on the deserialized
claims struct to reconstruct the HMAC input. The correct flow is:
1. Base64url-decode the payload → parse JSON into a `Claims` struct (serde for field extraction).
2. Feed the struct fields into the hand-written canonical template function.
3. Compute HMAC over the resulting bytes.
4. Compare against the signature segment.

The deserialization step and the HMAC-reconstruction step are deliberately separate; merging them
via `serde_json::to_string(&claims)` will produce the wrong byte order.

**Payload confidentiality note:** the token payload is base64url-encoded JSON, not encrypted.
Confidentiality is not a property of this format. The HMAC provides integrity and authenticity
only. Operators should configure their reverse proxy to redact the `t=` query parameter from
access logs.

Test vectors in `tests/vectors/stream-token-canonical.json` (§13.1) are the ground truth for
both stacks. Both must independently produce identical bytes against the pre-authored vectors;
neither implementation is the authority — the spec is.

### 5.2 Decision: claim shape

The canonical byte order is alphabetical: `exp, iat, jti, k, nbf, rid, sub, v`. Any other
ordering in documentation is illustrative only. The byte template in §5.1 is the contract.

Claim semantics:

| Claim | Type | Notes |
|---|---|---|
| `exp` | integer (Unix seconds) | Expiry. Verifier rejects if `now > exp + 5s`. |
| `iat` | integer (Unix seconds) | Issued-at. |
| `jti` | string (26-char ULID) | Unique token ID. Alphanumeric-only; safe in the fixed template without escaping. |
| `k` | string (kind enum) | See §5.3. Fixed enum; safe in the fixed template. |
| `nbf` | integer (Unix seconds) | Not-before. Set equal to `iat`. Verifier rejects if `now < nbf - 30s`. |
| `rid` | string | Resource identifier. Stringly typed; for catchup encodes `streamId\|startUtc\|durationMin`. The `|` pipe character is not a JSON special character and is safe in the fixed template. |
| `sub` | string | Namespace-prefixed per §8 (provider-dispatching parser; see §8.3 for the exact per-provider patterns including the SIWA dot-separated format `apple:[0-9]{6}\.[0-9a-f]{32}\.[0-9]{4}`). Contains no JSON-escapable characters in the locked patterns. |
| `v` | integer | Contract version. Currently `1`. |

Short key names (`k`, `rid`) over long-form (`kind`, `resourceId`): these tokens appear in URLs
as query parameters; byte savings are meaningful on high-frequency segment and live URLs.

**Version rejection rule:** the verifier MUST reject any token where `v` is absent, non-integer,
or `v !== 1`. Return `401 { "error": "token_version_unsupported", "v_received": <value or null> }`.
When a new contract version is introduced, the verifier must be updated to gate on `v` explicitly.
There is no silent accept of unknown versions. Without this rule, the `v` field provides no
forward-compatibility guarantee.

Drop `kind` and `resourceId` long-form names from M1. Add `v`, `jti`, `iat`, `nbf`. Drop M1's
uncanonical `JSON.stringify` serialization. These are the D1 wire-breaking changes.

### 5.3 Decision: kind enum normalization

Stream-token `k` claim enum:

```
'live' | 'vod' | 'series' | 'catchup' | 'segment' | 'remux' | 'playlist'
```

Concurrency `SessionKind` enum:

```
'live' | 'vod' | 'series' | 'catchup' | 'remux'
```

Mapping:

- `'live'`, `'vod'`, `'series'`, `'catchup'`: dual-membership (token kind and tracker kind).
- `'remux'`: dual-membership. An AVPlayer-bound HLS remux session emits `kind: 'remux'` tokens
  for the manifest and per-segment URLs AND consumes a tracker slot. The concurrency tracker
  records `SessionKind = 'remux'` on the same code path. Both enums keep `'remux'`. Documented
  as dual to prevent enum drift; never remove from either enum independently.
- `'segment'`: token-only. The per-segment proxy issues short-TTL `'segment'` tokens. No tracker
  slot (segments are part of an existing remux session).
- `'playlist'`: token-only. The external-player M3U endpoint issues `'playlist'` tokens. No
  tracker slot.

The M1 contract draft incorrectly stated `'remux'` is tracker-only. M1 production code
(`server/routes/iptv.ts` lines 412, 519 and `rewriteRemuxManifest`) emits `kind: 'remux'` tokens
and verifies them at lines 630 and 681. The correct characterization is dual-membership. D4 in
§16 is documentation and comments only; it does NOT change either enum.

### 5.4 Decision: key separation

New env: `STREAM_TOKEN_SECRET`. Required, distinct from `SESSION_SECRET` and
`DEVICE_TOKEN_SECRET`.

**Boot-time distinctness check** (also in §3.1): the server MUST refuse to start if any two of
`SESSION_SECRET`, `STREAM_TOKEN_SECRET`, `DEVICE_TOKEN_SECRET` share the same value. Error
message must identify which pair collides. Same length and placeholder validation as
`SESSION_SECRET`. No silent degradation.

**Migration plan (split delta):**

- **D2a:** Add `STREAM_TOKEN_SECRET` env (required, distinct from `SESSION_SECRET`). Verifier
  tries `STREAM_TOKEN_SECRET` first; on HMAC mismatch only (not on payload parse errors or
  expiry), retries with `SESSION_SECRET` and emits a `WARN [stream-token] legacy-secret accepted`
  log. Signer always uses `STREAM_TOKEN_SECRET` from D2a forward.
- **D2b:** Drop the verifier fallback. Schedule no earlier than 90 days post-D2a deploy. The
  90-day gate is driven by the playlist-token TTL (§5.6): tokens in VLC/TiviMate caches may be
  up to 90 days old at time of D2b deploy. After D2b, all legacy-secret tokens hard-fail with
  `401 { "error": "token_invalid" }`.

Rationale: the M1 `checkToken` function in `server/routes/iptv.ts` is hardcoded to
`env.sessionSecret` for both signing and verification. The D2a migration must update both sign
and verify paths simultaneously. A sign-only migration would break all tokens already in the
field.

### 5.5 Decision: replay defence

**Replay defence by kind:**

- `segment`: single-use. `jti` written to `Map<jti, exp>` on first verify; subsequent
  presentations of the same `jti` are rejected with `401 { "error": "token_replay" }`. TTL-eviction
  sweep every 60 seconds purges entries whose `exp` is in the past.
- `live`, `vod`, `series`, `catchup`, `remux`: multi-use within token TTL. `jti` NOT tracked for
  replay. Legitimate clients re-issue tokens via grant on session restart; HLS players reuse one
  token across many manifest and segment fetches within a session. The `exp` check is the
  sole gate.
- `playlist`: persistent revocation. `jti` written to the `iptv_playlist_tokens` table (§6.2) on
  issuance. Verifier checks the table on every playlist request; a `revoked_at IS NOT NULL` row
  is a hard reject. The in-process map does not cover playlist tokens.

**Implementation:** plain in-process `Map<jti, exp>`, no bloom filter, zero false positives.
Map ceiling: approximately 10,000 entries at sustained peak (generous estimate for a
single-household server). On process restart, the segment cache empties; this is accepted for
short-TTL tokens (60s) where the restart window is smaller than the TTL in practice. Clients
re-grant if a segment 401 is received. The playlist table persists across restarts and is the
load-bearing revocation surface.

**Why not a bloom filter:** a bloom filter stores binary membership and cannot implement
"allow re-use within token TTL, reject after expiry." Its false-positive probability would
cause legitimate tokens to be rejected with no recovery path. At household scale, the memory
and latency saving versus a plain `Map` is immeasurable. A bloom filter is explicitly rejected.

**5xx-safe policy:** applies only to external replay-cache dependencies. This implementation
has no external cache dependency; the map is always present if the process is running.

### 5.6 Decision: TTL caps

| Kind | TTL | Rationale |
|---|---|---|
| `live` | 300s | Re-issued on heartbeat. |
| `vod` | 3600s | Long enough for a movie; client re-grants on resume. |
| `series` | 3600s | Same. |
| `catchup` | 3600s | Same. |
| `remux` | 300s | AVPlayer HLS remux; same playback path as live MPEG-TS. TTL matches `live`. |
| `segment` | 60s | Hot path; constantly refreshed by playlist proxy. |
| `playlist` | 90 days | Long-lived bearer-in-URL for external players (VLC, TiviMate). See §6. |

Note: the M1 shipped playlist token TTL is 30 days. The contract sets 90 days as the target.
This is an explicit delta (D12 in §16): update the playlist token TTL from M1's 30-day value to
90 days. Existing 30-day tokens issued by M1 remain valid until their `exp`. The D2b verifier
fallback removal must not be scheduled until 90 days post-D2a deploy, to cover any 30-day tokens
still in field players at the time of D2a deploy.

### 5.7 Decision: clock-skew tolerance

Verifier accepts tokens with `nbf - 30s <= now <= exp + 5s`.
Server-side time is authoritative; client clock is untrusted.

### 5.8 Decision: who verifies

- If §4 = Option A: only Hono verifies stream-tokens. Rust services receive an internal
  principal assertion plus a resource handle. The `stream_token` module in `emerald-contracts`
  is still required for test-vector CI validation (§13.1) even under Option A.
- If §4 = Option B: Rust services verify stream-tokens independently. `emerald-contracts` crate
  is load-bearing for live verification.

Regardless of §4 outcome, the canonical byte spec in §5.1 MUST round-trip identically between
TS sign and any verifier (TS or Rust). Test vectors in `tests/vectors/stream-token-canonical.json`
(§13.1) are the ground truth. A CI failure that does not produce a clear "token vector mismatch
at index N" message will be impossible to triage in a cross-language failure — §13.1 must specify
this reporting requirement.

---

## 6. Playlist tokens (long-lived bearer in URL)

The M1 strategy doc proposed `/api/iptv/playlist.m3u?t=<deviceToken-issued>`.
**That's a bad shape:** device tokens leak via logs, support bundles,
proxy access logs, error reports. Putting a 1-year bearer in a URL is
exactly the failure mode the device-token model is meant to avoid.

### 6.1 Decision: separate playlist token kind

Decision: separate playlist token kind. `k: 'playlist'` stream-token, 90-day TTL.
Bound to a single resource: `rid: 'iptv-channels-all'` (M1 currently emits
`rid: 'all'` — see D-row in §16 for the rename).

The M3U body contains **short-lived (300s) per-channel `live` tokens** generated
server-side on each playlist GET. M1 currently emits 30-day per-channel tokens
(see D-row in §16 — `server/routes/iptv.ts:284` `chTtl = 30 * 24 * 3600` must
change to 300s, otherwise the security argument below is fiction).

Honest framing of the leaked-URL threat:
- A leaked playlist URL is a **90-day renewable stream access grant** requiring
  one HTTP request every 5 minutes to refresh per-channel tokens.
- Mitigations: revoke via `iptv_playlist_tokens` table (§6.2); user-visible
  'Devices' UI per-token labels (below) let the operator scope-revoke.
- It is NOT a 5-minute leak. State this clearly.

Scope note: the M3U playlist covers **live channels only**. VOD and series entries
are excluded. External players access live channels only via M3U; VOD and series
require the native app. `rid: 'iptv-channels-all'` names this scope explicitly.

### 6.2 Decision: playlist token issuance and persistence

`POST /api/iptv/playlist/token` (cookie or device-token auth) →
`{url, expiresAt, jti, deviceName}`. The endpoint accepts `{deviceName: string}`
in the request body (operator-supplied label).

Persistent table `iptv_playlist_tokens (jti TEXT PK, sub TEXT, device_name TEXT,
issued_at TEXT, expires_at TEXT, revoked_at TEXT NULL)` in `iptv.db`.

Verifier: token signature valid → row exists in `iptv_playlist_tokens` with
matching `jti` → `revoked_at IS NULL` → `expires_at` > now. Note that the M1
endpoint already exists at `server/routes/iptv.ts:206`; the work is adding
persistence (`iptv_playlist_tokens` table + migration), the `device_name` column,
and the verifier read on every playlist GET.

Admin UI: 'External player M3U' panel listing live tokens by `device_name` with
per-row Revoke and a 'Revoke all' button. **Revoke is per-jti, not per-sub.** Two
household members with separate `device_name`s do not affect each other.

### 6.3 Decision: rotation policy

Rotation: 90-day TTL is final. **No silent auto-rotation.** When a token reaches
expiry, the operator manually issues a new one via the admin UI and pastes the
new URL into VLC/TiviMate.

Why not silent rotation: a paste-once VLC user accessing the old URL would either
keep working (rotation provides no security) or silently break (no path to receive
the new URL). Both are bad. Pick the simpler model.

UX: admin UI shows 'expires in N days' warning at 14 days remaining.

### 6.4 Apple ATS compliance for inner URLs

AVPlayer fetches per-channel URLs from the M3U body via `mediaserverd`, honouring
the app's ATS policy. Most upstream IPTV providers serve streams over plain HTTP.
Two viable resolutions:

1. **Server-side HTTPS proxy (RECOMMENDED).** Every per-channel inner URL is a
   `https://<eex-server>/api/iptv/stream/live/:streamId.ts?t=<live-token>` URL
   pointing at this server. The server fetches upstream over HTTP and streams to
   AVPlayer over HTTPS. M1 already implements this for in-app playback. Same URL
   shape for playlist tokens. No ATS exception needed.

2. **`NSAllowsArbitraryLoadsForMedia=YES` in app `Info.plist`.** Permits AVPlayer
   to fetch HTTP directly. Passes App Review but expands the app's threat surface.
   Reject unless option 1 is impractical.

**Locked: Option 1.** Inner URLs in the M3U MUST be HTTPS pointing at this
server's stream-grant URLs.

### 6.5 Alternative for TiviMate users: direct Xtream Codes credentials

TiviMate (the most popular external IPTV player on tvOS/Android-TV) supports
Xtream Codes API natively. Operators may prefer to expose the upstream Xtream
credentials directly to power users — bypasses the playlist token model entirely.

Trade-offs: (a) credentials are not revocable by this server (rotating them
requires upstream provider action); (b) the upstream sees the user IP directly
(no proxying); (c) does not consume `IPTV_MAX_CONCURRENT_STREAMS` slot (upstream's
own cap applies).

**Out of scope for M1.5 contract.** Document as a future opt-in operator UI
surface; not built.

## 7. DB migration contract

Three databases (`iptv.db`, `exchange.db`, `media.db`), three writer
languages by M3 (TS via better-sqlite3, Python via stdlib sqlite3, Rust
via sqlx). Shared discipline is mandatory.

### 7.1 Decision: shared migration table convention

Every DB has a `schema_migrations` table:

```sql
CREATE TABLE schema_migrations (
  version    INTEGER NOT NULL PRIMARY KEY,
  applied_at TEXT    NOT NULL,
  checksum   TEXT    NOT NULL    -- sha256 of LF-normalized .sql at apply time
);
```

- `version` is an integer extracted from the filename prefix
  (`parseInt("0001_init.sql".split("_")[0])` → `1`).
- `checksum` lets the migrator detect "this version was applied, but the
  file has been edited since" — a noisy bug class in long-lived projects.
- File naming: `NNNN_short_snake_case.sql`, where NNNN is zero-padded to
  4 digits. Already matches `0001_init.sql` / `0005_iptv_kinds.sql`.

**Migration from current state:** Hono's `_migrations` and Python's
`schema_migrations(filename)` are both legacy shapes. Each migrator gains
a bootstrap step executed before any migration apply:

- If `schema_migrations` exists **and** its first column is `version INTEGER`:
  use it as-is.
- Else if `_migrations` exists (Hono legacy — `id TEXT PRIMARY KEY, applied_at TEXT`):
  rename and backfill via legacy detection:
  `version = parseInt(id.split('_')[0])`, `checksum = sha256(LF-normalize(file_at_apply_time))`.
  Concretely: `CREATE TABLE schema_migrations ...`, `INSERT INTO
  schema_migrations SELECT CAST(substr(id, 1, 4) AS INTEGER), applied_at,
  sha256_of_file FROM _migrations`, `DROP TABLE _migrations`.
- Else if `schema_migrations(filename TEXT PRIMARY KEY)` exists (Python
  legacy): perform a SQLite table-rebuild (`CREATE TABLE
  schema_migrations_new`, `INSERT ... SELECT ...`, `DROP TABLE
  schema_migrations`, `ALTER TABLE schema_migrations_new RENAME TO
  schema_migrations`), backfilling `version` from
  `CAST(substr(filename, 1, 4) AS INTEGER)` and `checksum` from file
  content at backfill time.
- Else: create the new table.

This bootstrap runs on every migrator construction, before any migration
SQL is executed. It is idempotent — if the canonical table already exists,
it is a fast no-op.

**CRLF normalization for checksum:** migration `.sql` files are normalized
to LF line endings before SHA-256 computation. Hono (better-sqlite3) and
Python migrators both read the file, replace `\r\n` with `\n`, then hash.
Without this rule, a Windows developer's checkout produces different
checksums than a Unix CI checkout, breaking the consistency guard on first
cross-platform contributor. This is not theoretical: the sqlx production
bug (sqlx/issues/2659, reproduced in the OpenAI Codex Desktop incident in
2025) caused sqlx to refuse database opens because CRLF-checked-out `.sql`
files produced a different SHA-384 than what was stored at apply time on
Linux CI. Repo `.gitattributes` line:

```
*.sql text eol=lf
```

enforces filesystem-level consistency and is a hard requirement, not a
recommendation.

**Checksum mismatch behaviour: WARN, not fail.** On boot, if
`sha256(LF-normalize(file))` does not match the row's stored checksum, the
migrator emits:

```
WARN [migration] checksum mismatch on N: file may have been edited
```

and continues. Refusing to boot on edited-migration is dangerous: a
typo-fix commit on a comment breaks production for every operator.
Forward-only model accepts the risk. Boot-fail on checksum mismatch is
explicitly rejected.

### 7.2 Decision: schema-version API

`GET /api/version` (§12) returns per-DB schema versions:

```json
{
  "server": { "version": "0.5.0", "build": "<sha>", "min_client_version": "0.0.0" },
  "schemas": {
    "iptv":     { "present": true,  "current": 1, "applied_at": "..." },
    "exchange": { "present": true,  "current": 5, "applied_at": "..." },
    "media":    { "present": false }
  },
  "server_id": "<uuid>"
}
```

If a DB does not yet exist (e.g., `media.db` before M3 ships), `/api/version`
returns `{"present": false}` for that schema entry instead of
`{"current": 0}`. This distinguishes "not installed" from "installed at
version 0" — a real distinction once the multi-DB deployment is in progress
and one DB may legitimately be at version 0 after a bootstrap migration.

### 7.3 Decision: skipped-version migration path

Migrator applies all unapplied migrations in version order on every boot.
Already true today. No coalesced fast path needed: a user who has not
updated in 8 months runs every intervening migration sequentially.

**30s slow-migration warning is M1.5, not M2-era.** The migrator wraps
each `apply` call with a `Date.now()` timing block:

```ts
const t0 = Date.now();
raw.exec(sql);
const elapsed = Date.now() - t0;
if (elapsed > 30_000) {
  console.warn('[migration] applying %s took %dms, this may take several minutes', file, elapsed);
}
```

This timing scaffolding lands in M1.5 D8 — not deferred to M2. The
rationale: M1 `iptv.db` has 116k+ rows from a single Xtream provider sync
(50k channels, 15k VOD, 3k series, 48k series episodes). Table-rebuild
migration patterns — `CREATE TABLE new ... INSERT SELECT ... DROP TABLE ...
RENAME` — used for CHECK constraint changes (e.g., `0005_iptv_kinds.sql`
style) will cross the 30s threshold on NAS-class hardware (ARM Cortex,
spinning disk) at these row counts. The contract's prior claim that tables
are "in practice <10k rows" is false against the live database today.

The Python migrator already logs at INFO level when applying each file; the
TS migrator is silent. D8 adds `console.info('[migration] applying %s', file)`
before `raw.exec(sql)` as a minimum — one line, no threshold required for
the start-of-apply log.

### 7.4 Decision: rollback policy

**No automatic rollback.** SQLite + linear forward-only migrations.

**Recovery via backup tarball.**

**`POST /api/admin/backup` MUST exist** (new D-row in §16). On call: runs
`VACUUM INTO` on every DB (consistent snapshot under WAL), tars them with
a manifest of schema versions, streams response. Operator's responsibility
to retain. This endpoint is referenced in the strategy doc §13.4 but has
no implementation in M1 and is absent from the §16 delta table; it must
be added.

**Enforced backup-before-destructive:** migration files containing the
comment line `-- DESTRUCTIVE` (case-sensitive, on its own line) cause the
migrator to refuse to run unless `POST /api/admin/backup` was called within
the last 10 minutes. The timestamp of the last backup call is recorded in
`server_state`. The check is:

```
SELECT value FROM server_state WHERE key = 'last_backup_at';
-- if absent or older than 10 min: ABORT with log + exit(1)
```

The Jellyfin 10.11 catastrophe is the cautionary tale: the EF Core migration
that shipped in 10.11 ran automatically on first startup, was irreversible,
produced a ~66% fresh-install failure rate on point releases (10.11.1–10.11.5
required 100+ stabilisation fixes), and left databases in corrupted states
for users who had no prior backup. The root cause was an automatic,
irreversible transformation with no pre-flight gate. Backup must be a
**hard** constraint, not documentation.

Down-migrations remain out of scope. Self-host single-operator does not
need them.

### 7.5 Decision: TS ↔ Rust schema parity

`iptv.db` schema is owned by Hono today. **Stays Hono-owned in M3+.**
Rust media-core writes to `media.db`; never touches `iptv.db` or
`exchange.db`. Rust reads `iptv.db` via sqlx read-only pool. Schema parity
becomes "Rust must understand the schema Hono wrote" — easier than "two
writers must produce identical schemas."

**Test vector beyond DDL:** ship `tests/vectors/iptv-db-round-trip.json`
with row values written by TS and the expected sqlx `query_as!`
deserialization. The vector must cover at minimum:

- `is_adult INTEGER` → Rust `bool` (sqlx coerces 0/1 to false/true when
  the struct field is `bool`; this is correct but must be asserted, not
  assumed).
- `added_ts TEXT` → Rust `chrono::DateTime<Utc>` (TS writes
  `new Date().toISOString()` → `"2026-05-25T19:13:46.023Z"`; chrono parses
  this format correctly, including the milliseconds and `Z` suffix, but this
  must be a committed test fact, not tribal knowledge).
- Any future `BLOB` column → Rust `Vec<u8>` (no current instances, but the
  vector file pre-empts the drift).

Pure schema-snapshot tests (`tests/golden/iptv-schema-vN.sql`) miss
read-time interpretation drift. The round-trip test is the only gate that
catches "schema applies cleanly but deserialization panics at runtime."

`tests/vectors/iptv-db-schema.sql` in `emerald-contracts` remains in place
for DDL parity. The round-trip JSON vector is an addition, not a
replacement. Both run in CI.

---

## 8. Identity namespace

### 8.1 Decision: prefix from day one

`sub` values across all tokens, DBs, and APIs follow `<provider>:<provider_id>` where:

- `plex:<numeric_id>` — Plex user id. Plex uses positive integers. Pattern: `plex:(0|[1-9][0-9]*)` — no leading zeros (e.g. `plex:007` is rejected). Leading-zero exclusion is mandatory: any Rust `Sub` design that parses the id as `u64` cannot round-trip leading-zero forms through the §5.1 canonical serializer, so the validator rejects them at the wire boundary.
- `local:<ULID>` — local-auth user. Crockford Base32 ULID, 26 chars uppercase. Pattern: `local:[0-9A-HJKMNP-TV-Z]{26}`.
- `apple:<SIWA_sub>` — Sign in with Apple subject. SIWA returns dot-separated identifiers like `001126.d3c6971f4faa4ccd80027e3654fa404a.1616`. Pattern: `apple:[0-9]{6}\.[0-9a-f]{32}\.[0-9]{4}`.

The provider-specific patterns are stricter than a generic regex; they catch malformed inputs at parse time. Reference test vectors must include at least one SIWA value with dots.

Locked across: JWE session cookie, device JWE, HMAC stream token, `iptv_favorites.sub`, `iptv_watch_history.sub`, future `media_watch_state.sub`. Any `sub`-keyed column or field introduced after this migration is created with the namespace format from day one — no further backfill.

Provider prefix is always lowercase. `local:` ULIDs are stored and compared uppercase. `parseSub` trims leading/trailing whitespace before validation and throws `sub_invalid_format` if trimming was required (not silent pass-through).

### 8.2 Decision: M1 backfill

Backfill migrations (sequence-tied: must all land in the same release):

**A. iptv.db (`server/migrations/iptv/0002_namespace_sub.sql`)**:
```sql
UPDATE iptv_favorites      SET sub = 'plex:' || sub WHERE sub NOT LIKE '%:%';
UPDATE iptv_watch_history  SET sub = 'plex:' || sub WHERE sub NOT LIKE '%:%';
```

**B. exchange.db (`recommender/migrations/0006_namespace_sub.sql`)** — was missing from the draft:
```sql
UPDATE user_feedback   SET sub = 'plex:' || sub WHERE sub NOT LIKE '%:%';
UPDATE recently_shown  SET sub = 'plex:' || sub WHERE sub NOT LIKE '%:%';
UPDATE rec_log         SET sub = 'plex:' || sub WHERE sub NOT LIKE '%:%';
```

**C. feedback.json flat-file (`server/services/userFeedback.ts`)** — was missing from the draft:
One-time on-boot key-rename script: read all keys; for keys not containing `:`, copy value under `plex:<key>` and delete old key. Runs once per release at boot, gated by a `server_state` flag.

**D. Hono session/auth code**: `setSessionCookie`, `mintDeviceToken`, and the Plex PIN OAuth callback all prefix `sub` with `'plex:'` before persistence. New logins get prefixed sub from day one. **No existing JWE cookie needs decryption — `verifySession` rewrites unprefixed `sub` → `plex:<sub>` on read during the grace period (see below).**

`verifySession` rewrites legacy unprefixed `sub` → `plex:` in-memory for every request during the grace period. The cookie on disk is not re-encrypted; the rewrite re-applies on each request until the cookie expires or the user re-authenticates. Grace period is calibrated to the 30-day cookie TTL — sufficient to cover all M1 cookies in the wild. M2 device tokens are always minted with a prefixed `sub` from day one (the device token minting endpoint reads `session.sub` post-rewrite, guaranteeing a namespaced sub in all new device tokens regardless of cookie age); device tokens are not subject to the grace window. Drop the `verifySession` rewrite after one cookie TTL post-D7 (30 days).

**Stream-token grace path**: M1 HMAC stream tokens may still carry unprefixed `sub` if minted before the rollout. `checkToken` in `server/routes/iptv.ts` normalises: if `claims.sub` does not match `parseSub`, prefix with `'plex:'` and proceed. Any sub written from a normalised token (e.g., into watch history on heartbeat) is the prefixed form. Drop this normalisation in the same release as the cookie rewrite drop (one cookie-TTL post-D7).

### 8.3 Decision: parser/sanity guard

Helper `parseSub(s: string): {provider: 'plex'|'local'|'apple', id: string}`.

Implementation: provider-dispatching parser, not a single regex. Pseudocode:
```typescript
export function parseSub(s: string): {provider, id} {
  const colon = s.indexOf(':');
  if (colon < 0) throw new Error('sub_missing_namespace');
  const provider = s.slice(0, colon);
  const id = s.slice(colon + 1);
  if (provider === 'plex'  && /^(0|[1-9][0-9]*)$/.test(id)) return {provider, id};
  if (provider === 'local' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return {provider, id};
  if (provider === 'apple' && /^[0-9]{6}\.[0-9a-f]{32}\.[0-9]{4}$/.test(id)) return {provider, id};
  throw new Error('sub_invalid_format');
}
```

Used everywhere a `sub` is written or read. Identical implementation in Rust `emerald-contracts::sub::parse_sub` and Swift `EmeraldKit/Sub.parseSub`. Test vectors at `tests/vectors/sub-namespace.json` include at least 2 SIWA values with dots, 2 ULIDs (one all-uppercase, one with `0` and `O` correctly distinguished), and several invalid inputs (whitespace, full-width unicode, empty id, missing colon).

**Note on the previous draft's regex**: the draft proposed `^(plex|local|apple):[A-Za-z0-9_-]+$`. That regex excludes `.` (period), rejecting every real SIWA `sub`. This was a CRITICAL defect caught by the 22-agent review (2 independent agents); the provider-dispatching parser above is the fix.

---

## 9. Recommender data-model contradiction [PICKED]

**Decision (2026-05-25): Resolution A — keep the `iptv_title_link` join, drop the inert per-source `iptv_vod` / `iptv_series` rows from `exchange.db.titles`. Add local-first source-precedence resolution at the grant endpoint.**

**Precedence rule (applies at play-time, not at schema-time):**
1. Local-hosted source ALWAYS wins. Today that means Plex (M1). At M3+ it means media-core's local file library (which inherits this rank-1 status; Plex drops to rank-2 once media-core ships).
2. If the rank-1 source is unavailable (offline / returns 5xx / `MEDIA_LIBRARY_PATHS` empty on the host) AND a lower-precedence source has the title, fall back to the lower source automatically.
3. Order today: `media-core` (M3+) > Plex (Sonarr/Radarr-tracked) > IPTV (`iptv_title_link`) > future sources.
4. The grant endpoint (`POST /api/media/play/:kind/:id/grant` for M3+, and the M1 IPTV grant endpoints) implements the precedence + availability probe. The recommender / suggestions response returns the canonical TMDB row with an `available_on[]` array; the *order* in that array reflects the precedence rule.

Why A:
- **Cheapest by margin** (~12h vs 17h/11.5h/31h for B/C/D); single-load-bearing path; closest to shipped M1 code (single deletion migration `0006_drop_iptv_kinds.sql`).
- **§11 ships unchanged** (per r11-tombstone-design: VALID under A; SILENTLY WRONG under B; NEEDS-REWRITE under C; rebuilds under D).
- **Industry standard** — 6 of 8 surveyed systems use A or A-with-precedence (JustWatch, Reelgood, Trakt, Letterboxd, Radarr `MovieMetadata`/`Movie` split, Stremio Cinemeta). Stremio's documented B1 double-recommendation failure is direct precedent for what Resolution B produces.
- **M3 inheritance is clean**: media-core gets `media_title_link (file_id, tmdb_kind, tmdb_id)` in `media.db`. Hono fans out joins across `iptv_title_link` + `media_title_link` + Sonarr/Radarr state, applies the precedence rule, returns the canonical row with ordered `available_on[]`. No `kind='local_*'` rows in `exchange.db.titles`.

Trade-off accepted: IPTV-only titles (no TMDB match, ~5–10% of IPTV catalog) cannot appear in the ranked-suggestions feed. They surface in a separate "IPTV-only" carousel. Cold-start for IPTV-only is foreclosed by Resolution A and would only be preserved by B/C — both of which carry the always-on double-recommendation failure mode.

Subtle hazard to mitigate: when the rank-1 source goes offline mid-session (e.g., Plex Media Server crashes mid-playback), the player MUST NOT seamlessly downgrade to a lower source — that would silently change codec, quality, and progress-tracking attribution. Failure mode: surface "Plex unavailable, switch to IPTV?" as an explicit user action. New error code in the closed `reason` enum (§12.4): `'source_unavailable'` with payload `{available_alternatives: [...]}`.

The rest of this section retains the A/B/C/D analysis for audit-trail purposes; the chosen path is A.

### 9.1 The actual situation today

This deserves more nuance than the strategy doc gave it. **Both
data paths are wired in, but only the cross-DB join is consumed.**

- `iptv_title_link (iptv_kind, iptv_id, tmdb_kind, tmdb_id)` table:
  populated by `iptvSync.ts` on every 6h sync. Queried by
  `suggestions.ts` (`tagIptvAvailability`) to add `'iptv'` to
  `available_on[]`. **This is the path the badge feature actually uses.**
- `iptv_vod` / `iptv_series` rows in `exchange.db.titles`: populated by
  `iptv_ingest.py`. Sitting there. **Not currently read by any badge
  logic.** Ostensibly available to the ranker — but the ranker doesn't
  treat them specially today.

So the contradiction is real but lopsided: the join is the load-bearing
path; the per-source rows are inert.

### 9.2 Three resolutions

| Resolution | What changes | Cost | Risk |
|---|---|---|---|
| **A. Keep the join, drop the per-source rows** | Delete `iptv_ingest.py` worker, drop `iptv_vod`/`iptv_series` rows. Migration `0006_drop_iptv_kinds.sql` removes the kinds from the CHECK. | ~1 day. Single load-bearing path remains. | Loses the optionality of letting the recommender rank IPTV items directly. If the ranker ever wants IPTV-only suggestions, you have to re-add. |
| **B. Keep the per-source rows, drop the join** | Delete `iptv_title_link` and `tagIptvAvailability`. Move `available_on` logic to query `exchange.db.titles WHERE kind LIKE 'iptv_%' AND tmdb_id IN (...)`. | ~2 days. Crosses a service boundary (suggestions in Hono, titles in recommender). Adds latency. | Hono now depends on `exchange.db` for IPTV availability — extra cross-DB read on every suggestion render. |
| **C. Document both as canonical, draw a line** | `iptv_title_link` for **availability badges**. `iptv_vod`/`iptv_series` for **ranker input**. Build an integration test that asserts the two stay in sync. | Smallest immediate code change. Largest doc + test burden. | Drift is inevitable. The two paths run on different schedules (6h Xtream sync vs nightly recommender ingest). Stale-data window of up to 24h. |

### 9.3 What flips downstream depending on the answer

- **M3 media-core**: if the answer is **A**, media-core inherits the
  pattern: `media_title_link (file_id, tmdb_kind, tmdb_id)` in `media.db`,
  Hono fans out joins. If **B**, media-core writes `kind='local_*'`
  rows directly into `exchange.db.titles`. Locking now prevents a
  third pattern from emerging in M3.
- **Orphan handling (§12)**: A makes orphans (IPTV-only items with no
  TMDB id) trivially "no badge, no recommendation"; B requires explicit
  tombstone schema in `titles`.
- **Recommender Python ↔ Rust port** (post-M5): A means the iptv ingest
  worker stays Python forever. B means it eventually ports to Rust.

### 9.4 Recommendation (non-binding)

**Resolution A** — keep the join, drop the inert per-source rows.
Rationale: there's no current consumer of the per-source rows. Schrödinger's
data model is technical debt. The optionality argument ("the ranker
might want it later") is exactly the kind of speculative future
requirement the project rules say to avoid (CLAUDE.md: "Don't design
for hypothetical future requirements"). If/when the ranker wants IPTV-
specific input, re-add it at that point with a real use case.

But this is one-way for M3's data-model shape. Your call.

---

## 10. Identity namespace

Merged into §8 above. This number is preserved as a redirect to avoid renumbering downstream cross-references.

---

## 11. Availability-badge semantics for orphans

**This section's design is conditional on the §9 decision.** Under Resolution A, C, or D (link table is canonical, co-canonical, or the source-of-truth for the sync-event-driven backfill — see §9 D9 row), the design below applies as-is to `iptv_title_link`. Under Resolution B (per-source rows in `exchange.db.titles` are canonical), badge semantics are based on queries against `exchange.db.titles WHERE kind LIKE 'iptv_%'`; the orphan handling shifts to tombstones on `titles` rows with an equivalent `removed_at TEXT NULL` column and the same 14-day hard-delete window.

### 11.1 Decision: tombstones

Tombstone design:

- `iptv_title_link` gains `removed_at TEXT NULL` column (migration `0003_link_tombstones.sql`).
- `iptvSync.ts` no longer hard-deletes link rows when the underlying `vod`/`series` row disappears upstream. Instead: `UPDATE iptv_title_link SET removed_at = <now> WHERE ...`.
- `tagIptvAvailability` adds `AND removed_at IS NULL` to its filter. **A new partial index is required for performance**: `CREATE INDEX iptv_link_active_by_tmdb ON iptv_title_link(tmdb_kind, tmdb_id) WHERE removed_at IS NULL`. Without the partial index, query plans degrade as tombstones accumulate — the existing `iptv_link_by_tmdb` index covers `(tmdb_kind, tmdb_id)` but does not include `removed_at`, so SQLite cannot use it to satisfy the `removed_at IS NULL` filter efficiently.
- Hard delete after **14 days** of `removed_at IS NOT NULL` (revised down from the draft's 30 days). Justification: badge continuity only needs to cover typical re-catalog windows (provider re-uploads a series within days, not weeks). At ~1%/day upstream churn on a 20k-item catalog, 30 days means up to 30% of the link table is tombstones at steady state; 14 days holds tombstones to ~14% of the index pressure.
- **The contract's previous claim that tombstones protect watch history is removed.** `iptv_watch_history` has no FK to `vod` or `series` (confirmed against `server/migrations/iptv/0001_init.sql` lines 90–99: `item_id` is plain TEXT, no REFERENCES clause) and is unaffected by `vod`/`series` deletion; it already survives catalog deletes independently. The real value of tombstones is **badge continuity** — preventing a "now you see it, now you don't, now you see it again" UX flicker when an upstream item temporarily disappears and reappears in the next sync window.

Implementation note for `iptvSync.ts`: the M1 sync deletes `vod`/`series` rows by `fetched_at` mismatch **before** pruning link rows. After M1.5, tombstoned link rows point at already-deleted parent rows — they carry no navigable metadata beyond `tmdb_id`. Any future UI reading tombstoned rows (e.g., an admin "recently removed" view) must reconstruct metadata from `exchange.db.titles` via `tmdb_id`, not from the (gone) `vod`/`series` row.

### 11.2 Decision: live channels excluded from `available_on`

Live channels excluded from `available_on`: TNT doesn't map to a single TMDB title. The recommender returns TMDB-keyed items; live channels in `available_on` would clutter the badge.

The exclusion is structural, not just filtered: `iptv_title_link` is populated only with VOD/series (`iptv_kind IN ('vod','series')`); live channels have no rows in this table. No `removed_at` tombstone work applies to live channels.

If M6 introduces "this movie is airing on channel X at 8pm" via EPG matching, that is a separate field: `airing_soon: [{channel_id, start_utc, end_utc, title}]`. **Do NOT extend `available_on` with `'iptv-live'`** — pick the separate-field model now to prevent SPA renderer fan-out later. A title may legitimately appear in both `available_on: ['iptv']` (on-demand VOD) and `airing_soon` (scheduled air) simultaneously; these are orthogonal fields, not collisions.

### 11.3 Decision: orphans with no TMDB match

IPTV VOD/series without `tmdb_id`: no rows in `iptv_title_link`, no rows in any `titles` table. Invisible to the recommender. **Visible only in the IPTV browse tab's own views.** Correct behaviour; no badge work needed.

This is a provider-dependency, not a system error. Coverage gaps arise when the upstream provider omits or strips `tmdb_id` from their feed metadata. The sync explicitly skips `NULL` `tmdb_id` rows when building `iptv_title_link`.

**Add a sync metric**: `iptvSync.ts` logs `[sync] vod_without_tmdb: <count>` and `[sync] series_without_tmdb: <count>` per run. Catches upstream provider metadata degradation early — if the count spikes, badges will silently disappear for titles users know are available on IPTV.

---

## 12. Server / app version compatibility gates

Required before any TestFlight build. Locked.

### 12.1 Decision: `/api/version` endpoint

`GET /api/version` (public, no auth). Response:

```json
{
  "server": {
    "version": "0.5.0",
    "build": "<git-sha>",
    "min_client_version": "0.0.0"
  },
  "schemas": {
    "iptv":     { "current": 1 },
    "exchange": { "current": 6 },
    "media":    { "present": false }
  },
  "server_id": "<uuid_v4>"
}
```

**Removed `api_versions` array**: the draft proposed `["v1"]` implying path-prefixed versioning (`/api/v1/...`) that does not exist in M1. The compatibility model is plain semver comparison between `server.version` and the app-side `MIN_SERVER_VERSION` constant + reverse for `min_client_version`. No path-prefix versioning until and unless M2+ demands it. If we add it later, this section gains an `api_versions` field; the current omission is honest.

**Tiered detail** for privacy-conscious operators: a `EEX_VERSION_ENDPOINT_MINIMAL=1` env flag reduces the response to `{server: {version}, server_id}`, dropping `build` and `schemas`. Documented in operator runbook. Default: full response for self-host-on-LAN, minimal for public-tunnel deployments.

**`schemas.media.present: false`** is the explicit signal that `media.db` does not yet exist (M3 placeholder). A `{ "current": 0 }` shape is ambiguous — it cannot be distinguished from "installed at schema version 0." The `{ "present": false }` form is machine-readable and does not require Hono to open or query a database that has not been created. When M3 ships `media.db`, this key changes to `{ "current": <version> }`.

### 12.2 Decision: app-side gates

App→server: every request carries header `X-Eex-App-Version: <semver>`. Server compares against `MIN_CLIENT_VERSION` env (default `0.0.0`).

App first-connect:

- GET `/api/version`. If `server.version < <app's MIN_SERVER_VERSION>`: show 'Please update your server'.
- If any request returns 426: show 'Please update via App Store'.

**Bump policy**: `MIN_CLIENT_VERSION` is bumped ONLY when a server release contains a breaking change that older clients cannot tolerate (token format break, removed endpoint, response shape change). Non-breaking releases do not bump it. Bumping is an explicit decision in the release PR, not automatic on every release. Failure mode of over-eager bumps: every Keychain-token user is locked out simultaneously.

**Comparison semantics**: semver comparison (not lexicographic). `semver.gte` or equivalent — `"0.10.0" > "0.9.0"` must hold. Document the algorithm or use a semver library.

**Transition window policy**: when `MIN_CLIENT_VERSION` is bumped, coordinate the server deployment and the App Store submission so the server holds the bump until the app update is approved and available. A server release that bumps `MIN_CLIENT_VERSION` before the new app is available in the App Store produces a forced-lockout window of 24-48 hours for users who have not yet updated. Document this as a release checklist step.

### 12.3 Decision: `server_id` introduction

`server_id` is generated on first boot via `crypto.randomUUID()` (Node built-in, no dependency). Stored in **`server.db`** (new — see §16 D-row) in a `server_state(key TEXT PK, value TEXT)` table. Returned by `/api/version`. Embedded in every device token (§3.2).

**Not in `iptv.db`** — the IPTV_DISABLED insurance build (§13) still needs a `server_id` to mint device tokens. A general-purpose DB carries server identity, secrets state, and similar cross-cutting state.

Token validation: `token.server_id == own server_id` → accept. Mismatch → reject with `401 { error: 'server_identity_mismatch', expected: <own>, received: <token's> }`.

**Backup/restore behaviour** (the draft had this inverted):

- **Restore from backup of THIS install**: backup tarball includes `server.db` and thus the original `server_id`. Restoring preserves identity. Tokens keep working. Correct behaviour.
- **Fresh install** (data directory deleted or never existed): new `server_id` generated. All previously-issued tokens reject. App re-pairs via PIN flow. Honest 401.
- **Restore backup of a DIFFERENT install**: if an operator imports `server.db` from another EEX deployment (e.g., a migration from old NAS to new), they inherit that install's `server_id`. Document as 'this is the way to preserve pairings across hardware moves; back up the full data dir, not just iptv.db'.

**Operational requirement**: `server.db` MUST be stored on a volume-mounted path. A container boot that generates a new `server_id` because the data volume was not mounted is a catastrophic operational error that silently revokes all device tokens. Verify docker-compose volume mounts cover `SERVER_DB_PATH` before shipping any TestFlight build.

**Clone/duplicate install risk**: if an operator copies the data directory to a second machine (e.g., dev vs prod NAS), both servers will share the same `server_id`. Tokens become ambiguous. Document that `server_state.server_id` must be regenerated (`DELETE FROM server_state WHERE key='server_id'` + restart) when intentionally cloning an install for a distinct deployment.

### 12.4 Decision: HTTP status codes for version incompatibility

HTTP status codes:

- **Client too old for server** (server requires newer client): `426 Upgrade Required`, body `{ error: 'client_too_old', required_version: '<min client version>', current_version: '<received>' }`. Per RFC 7231 §6.5.15, include `Upgrade: eex-app/<min version>` response header.
- **Server too old for client**: `503 Service Unavailable`, body `{ error: 'server_too_old', required_version: '<min server version expected by client>', current_version: '<server's version>' }`. The client uses this to surface 'please update your server' UI.

Both responses use a **closed `reason` enum** (locked here, must not extend without a contract bump): `'server_too_old' | 'client_too_old' | 'server_identity_mismatch' | 'token_version_unsupported' | 'token_expired' | 'unauthenticated' | 'access_revoked'`. Swift `Decodable` can switch-exhaust on this enum. Test vector `tests/vectors/error-reasons.json` lists all locked values.

**Rationale for 503 (not 426) on server-too-old**: RFC 7231 §6.5.15 defines 426 as the server refusing to perform the request until the *client* upgrades its protocol. Using 426 for "server too old" inverts the semantic — in that case the client is the one demanding higher-capability server behaviour. 503 correctly expresses "I cannot serve this right now," and the body shape communicates the specific reason. The `Upgrade` header on the 426 response is required by RFC 7231 §6.5.15; without it the response is non-conforming.

### 12.5 Decision: Keychain key shape for multi-server

Apple-side multi-server: distinct Keychain items per paired server, using iOS-idiomatic service/account split (matches §3.7):

```
kSecAttrService = "eex.deviceToken"
kSecAttrAccount = "<server_id>"   // the UUID from /api/version
```

EmeraldKit's `loadDeviceToken(serverID:)` API takes `server_id` as parameter and resolves to the `(kSecAttrService, kSecAttrAccount)` pair. M2 v1 supports one paired server at a time, but the Keychain key shape is locked from day one so multi-server in M2.x does not require a breaking EmeraldKit API change. Do NOT use a dot-concatenated single key (e.g., `eex.deviceToken.<server_id>`) — service/account split is the iOS convention and what `Security.framework` is optimised for.

---

## 13. CI contract gates

Required to ship before M2 starts.

### 13.1 Test vectors

Test vectors live at **`<repo-root>/tests/vectors/`** (locked). Hono reads relative to the Hono build's CWD; Rust `emerald-contracts` reads via `env!("CARGO_MANIFEST_DIR").join("../../tests/vectors/")`; Swift via Xcode resource bundle.

**Required vector files** (all hand-authored from spec, not generated from one implementation):

- `tests/vectors/stream-token-canonical.json` — list of `{claims_input, canonical_bytes_hex, hmac_hex_with_test_key}`. Derived from §5.1 fixed-template spec, NOT from `JSON.stringify` or `serde_json::to_string`. Each fixture includes the byte string explicitly so that any implementation can be checked without writing canonicalizer code first. Edge cases: UTF-8 multi-byte rid/sub strings, integer claims at unix-second boundaries, max-length ULID jti.
- `tests/vectors/device-token-claims.json` — JWE plaintexts for sample claim shapes, all 3 `auth_mode` (`plex` | `local` | `apple`) × 3 representative `platform` values (`tvos` | `ios` | `ipados`).
- `tests/vectors/sub-namespace.json` — at least 13 entries: 4 valid (plex/local/apple with realistic IDs including SIWA dot-separated subjects), 9 invalid (whitespace, full-width unicode, empty id, missing colon, wrong colon position, control chars, oversize, mixed case ULIDs, leading-zero plex id e.g. `plex:007` — see §8.1 round-trip rationale).
- `tests/vectors/error-reasons.json` — every locked value in the §12.4 closed `reason` enum.

**Authoring discipline**: every vector file has a `_meta` block with `{authored_from: '<RFC or contract section>', author: '<name>', date}`. PR review checklist requires a human to confirm the byte-level fields were typed by hand or derived from a spec, not pasted from a passing test run.

### 13.2 Migration tests

- Hono: existing migrator boot smoke test, extended to assert `schema_migrations` populated and checksums match.
- Recommender: same for `exchange.db`.
- **Skip-version test**: spin empty DB, apply migrations 1→N, assert schema matches `tests/golden/iptv-schema-vN.sql` (and equivalent for exchange/media).
- **Golden snapshot format**: output of `sqlite3 <db> '.fullschema'`, post-processed to:
  - Strip leading whitespace from each line (avoids `.fullschema`-version drift across SQLite releases).
  - Normalize all column-type names to canonical lowercase (INTEGER → integer).
  - Sort `CREATE INDEX` statements alphabetically by index name.
  - Strip trailing semicolons.

  The repo includes `scripts/dump-schema.sh` (one bash file, 10 lines) implementing this. CI runs it on the test DB and diffs against the golden file. Whitespace-after-normalization is significant for the diff.

- **CRLF/LF normalization**: golden files are checked in with LF endings via `.gitattributes: *.sql text eol=lf`. CI fails if any golden file has CRLF (catches Windows contributors).

### 13.3 Reproducible no-IPTV builds — TWO builds, server and client

**Server (Hono)**: runtime route-mount guard, NOT a compile flag. Hono is bundle-less; dead-code elimination does not happen at tsc compile. New env: `IPTV_DISABLED=1`. In `server/app.ts`: guard `app.route('/api/iptv', iptv)` AND guard the iptv-related imports in `server/index.ts` so `node-cron` and `better-sqlite3` are not loaded. Use dynamic `import()` for the iptv module: `if (!process.env.IPTV_DISABLED) { const { iptvScheduler, ... } = await import('./services/iptv/index.js'); ... }`. Assertion: CI test `app.iptv-disabled.test.ts` boots the server with `IPTV_DISABLED=1`, hits `GET /api/iptv/health` and asserts 404. New CI job `build:no-iptv-server` runs the test suite with this env.

**Client (Apple, M2 onward)**: Swift Active Compilation Conditions, NOT a runtime UI gate. Add `IPTV_DISABLED` build setting to the Xcode project; gate IPTV code with `#if !IPTV_DISABLED ... #endif` at the source-file level. UI tabs, AVPlayer IPTV configurations, network code, type definitions — all gated. App Review judges the BINARY's capability; runtime UI gates are insufficient. CI builds with `xcodebuild ... GCC_PREPROCESSOR_DEFINITIONS=IPTV_DISABLED=1` and a `swift-symbol-grep` check asserts no IPTV symbols remain in the binary (`nm | grep -i iptv` returns nothing).

### 13.4 ffmpeg sidecar version validation

- **Required in M1.5, not M4-era.** M1 already calls `spawn('ffmpeg', ...)` in `server/services/iptvRemux.ts:119`. A missing or out-of-version ffmpeg currently fails silently at runtime (ENOENT on spawn).
- New `server/services/ffmpeg.ts`:
  - On boot, runs `ffprobe -version` (synchronously, blocking the listener).
  - Refuses to boot if ffmpeg < 6.0 (HLS LL features assumed by M4) or missing.
  - Logs `[ffmpeg] version=<version> path=<resolved path>` on success.
- M4 transcoder boot extends this with `ffmpeg -encoders` parse to enumerate available hardware encoders (videotoolbox / nvenc / vaapi / qsv) and refuse to boot if `TRANSCODER_HW_ENCODER` env names an unavailable encoder.

### 13.5 Version-skew integration tests

Version-skew integration tests in `server/version.test.ts`:

- Send request with `X-Eex-App-Version: 1.0.0`, server `MIN_CLIENT_VERSION=2.0.0` → 426.
- Send request with `X-Eex-App-Version: 2.0.0`, server `MIN_CLIENT_VERSION=2.0.0` → 200.
- Server semver `0.5.0`, client expects min `0.6.0` (via `/api/version`) → app surfaces 'update your server' (client-side logic, not server-side; covered by Swift unit test on EmeraldKit).

Test constants are hardcoded; they do NOT derive from `package.json` (which the test framework imports for other reasons; deriving here creates circular update cost).

### 13.6 CI job inventory (added in D-row D10)

| Job | Trigger | Dependencies |
|---|---|---|
| `test:hono` (existing) | every commit | — |
| `test:recommender` (existing) | every commit | — |
| `test:contract-vectors` (new) | every commit | D1, D8 (migration tables exist) |
| `test:migrations-golden` (new) | every commit | D8 |
| `build:no-iptv-server` (new) | every commit | D-row for IPTV_DISABLED gating |
| `test:ffmpeg-boot` (new) | every commit | D-row for ffmpeg validation |
| `test:version-skew` (new) | every commit | D6 |

Total CI runtime budget per commit (existing 8 min + new 4 min): ≤ 15 min on GitHub Actions. D10 estimate revised to **2-3 days** (was 1).

---

## 14. License decision [DEFERRED]

**Status: deferred to first binary-distribution event (M2 TestFlight).**
The repo stays private on GitHub until that moment; no source is
published, no public registry uploads (`npm publish` / `cargo publish` /
PyPI / brew tap), and no outside PRs are merged. M1.5 ships internally
on the user's NAS with no LICENSE file and no exposure surface.

When M2 TestFlight is imminent, the realistic shortlist narrows to
**All Rights Reserved** (no LICENSE file, repo stays private, binary
ships under Apple's standard App Store EULA) or **custom proprietary
EULA for the binary** (more control over redistribution than Apple's
defaults). Both keep the future-monetize door open and require zero
source exposure. The a14-failure-modes analysis confirmed the current
dep tree (JS/TS + Python) is clean of GPL/LGPL, so any of those
license postures is achievable at decision time.

Permissive (MIT / Apache-2.0) and source-available (PolyForm-NC, BUSL)
options are explicitly out of scope for this deferral — they require
publishing source, which conflicts with the user's stated need to
prevent AI scraping and preserve commercialization optionality.

**Decision impact downstream (under deferral):**
- §4 (internal auth boundary): the §14 ↔ §4 audit-surface argument
  from the prior draft was a category error per a14-failure-modes;
  §4 decides on its own merits and is not constrained by deferral.
- §13.3 (no-IPTV insurance build): irrelevant under deferral. Becomes
  relevant only at the M2 distribution event, by which time the
  binary's license posture will be set.
- M2 readiness gate: re-evaluate §14 before the first TestFlight
  build. That gate fires when the M2 spec phase opens.

---

## 15. Telemetry posture [PICKED]

**Decision (2026-05-25): Self-hosted Glitchtip, mandatory in the EEX stack. Every self-hoster runs their own Glitchtip instance; every client (web SPA, tvOS, iOS) phones home to that instance.**

### 15.1 Architecture

Glitchtip is a required service in `docker-compose.yml` alongside Hono, Rust media-core (M3+), Python recommender, and their backing stores. Self-hosters cannot run EEX without it — there is no "telemetry-disabled" build option.

Each EEX deployment is its own crash-data island:
- The self-hoster's household crash data lives only on their NAS.
- The developer (project maintainer) sees only crashes from their own personal Glitchtip — not from any other self-hoster's deployment.
- No third-party processor. No data leaves the self-hoster's infrastructure.

### 15.2 DSN distribution

The Sentry-compatible DSN is server-provided, not app-baked. App boot sequence:
1. App authenticates against its self-hoster's server (§3 device-token flow).
2. App fetches `GET /api/telemetry/config` → `{dsn: "https://...@<server>/<project>", environment: "production", release: "<server-version>"}`.
3. App initializes Sentry SDK (`Sentry` for Swift, `@sentry/node` for Hono, `sentry-sdk` for Python, `sentry` crate for Rust) pointing at the self-hoster's Glitchtip.
4. SDK begins shipping crashes to the self-hoster's instance.

This pattern means **ONE App Store binary** can serve every self-hoster. No per-self-hoster app build. The DSN is not a secret — it's an ingestion endpoint, and Glitchtip's auth model is that the DSN's project key authorizes writes to that project only.

### 15.3 PII scrubbing (mandatory)

All four SDK integrations MUST install a `beforeSend` hook that scrubs:
- `plexAuthToken` field (anywhere it appears in any object)
- `verifiedPlexServerId` field
- Xtream credentials (`XTREAM_USERNAME`, `XTREAM_PASSWORD`)
- All stream-grant URL `t=<token>` query params (regex strip)
- Authorization headers (`Bearer <device-token>`)
- Cookie headers (`eex.session=<value>`)
- SQL query params that resemble JWE ciphertext (regex-detect `eyJ...` patterns)

The scrub list lives in `emerald-contracts::telemetry::pii_scrub_keys()` (single source of truth, mirrored to each SDK via the contracts crate's language ports). CI test vector at `tests/vectors/telemetry-pii-scrub.json` validates the scrubber.

### 15.4 App Store privacy nutrition labels

Committed at first App Store submission:
- "Crash Data" — Linked to user: No. Used for App Functionality.
- "Diagnostic Data" — Linked to user: No. Used for App Functionality.
- Third-party processor: **None.** Data is processed by the server operator (the self-hoster), who is the same entity as the user in self-hosted deployments.

This labeling is honest under the architecture above: crash data never reaches Sentry Inc., never reaches the EEX project maintainer, only reaches the self-hoster's own infrastructure.

### 15.5 docker-compose addition

```yaml
services:
  glitchtip:
    image: glitchtip/glitchtip:latest
    restart: unless-stopped
    environment:
      SECRET_KEY: ${GLITCHTIP_SECRET_KEY}
      DATABASE_URL: postgres://glitchtip:${GLITCHTIP_DB_PASSWORD}@glitchtip-db:5432/glitchtip
      EMAIL_URL: ${GLITCHTIP_EMAIL_URL:-consolemail://}
      GLITCHTIP_DOMAIN: ${GLITCHTIP_DOMAIN}
      DEFAULT_FROM_EMAIL: noreply@${GLITCHTIP_DOMAIN}
      CELERY_WORKER_AUTOSCALE: "1,3"
    depends_on:
      - glitchtip-db
      - glitchtip-redis

  glitchtip-db:
    image: postgres:15
    restart: unless-stopped
    environment:
      POSTGRES_USER: glitchtip
      POSTGRES_PASSWORD: ${GLITCHTIP_DB_PASSWORD}
      POSTGRES_DB: glitchtip
    volumes:
      - glitchtip-postgres:/var/lib/postgresql/data

  glitchtip-redis:
    image: redis:7-alpine
    restart: unless-stopped

  glitchtip-worker:
    image: glitchtip/glitchtip:latest
    command: ./bin/run-celery-with-beat.sh
    restart: unless-stopped
    environment:
      # (same env block as glitchtip service)
    depends_on:
      - glitchtip-db
      - glitchtip-redis

volumes:
  glitchtip-postgres:
```

### 15.6 Self-hoster onboarding

The install guide MUST include:
1. Generating `GLITCHTIP_SECRET_KEY` and `GLITCHTIP_DB_PASSWORD` at install time (auto-generate in setup script).
2. First-boot Glitchtip web UI access (default admin user; force password change on first login).
3. Creating an EEX project inside Glitchtip; copying the project DSN into `EEX_TELEMETRY_DSN`.
4. Reverse-proxy / HTTPS setup if apps will connect from outside the LAN. Tailscale or Caddy are the documented options; raw port-forward is explicitly discouraged because it exposes Glitchtip's admin UI to the public internet.

### 15.7 Implementation cost

Estimated **~35–40h M1.5 slice**:
- docker-compose additions + setup script (3h)
- `GET /api/telemetry/config` endpoint + admin gate (2h)
- Hono SDK init + `beforeSend` hook (3h)
- Python recommender SDK init + scrubber (2h)
- Rust SDK init via `sentry` crate (2h, part of M3 work)
- EmeraldKit SDK init + DSN-from-server bootstrap (3h)
- PII scrubber implementation in `emerald-contracts::telemetry` + 3 language ports (5h)
- CI test vectors (`telemetry-pii-scrub.json`) + integration test that crashes flow end-to-end (4h)
- Self-hoster install documentation (3h)
- App Store nutrition label copy + privacy policy draft (1h)
- Reverse-proxy guide + Tailscale docs (2h)
- Buffer for ops surprises (Postgres tuning, retention policy, disk-fill prevention) (5h)

### 15.8 Why not the other two

- **Sentry SaaS** rejected: third-party processor, $26/mo recurring, App Store labels disclose Sentry Inc. as data processor, conflicts with the no-third-party-handover posture established in §14.
- **Local-only** rejected: TestFlight-and-beyond strangers can't share log bundles at scale; debug-blindness post-M5.5; doesn't fit a self-hosted-product roadmap.

The strategy doc §11's original Glitchtip proposal is upgraded from "default" to "mandatory" here.

**Decision impact downstream:**
- Determines App Store privacy nutrition label content — required at
  submission, not amendable per release without re-review.
- Determines whether `emerald-contracts` exposes a `tracing` integration
  shape.
- Determines `/api/admin/diagnostics` (strategy doc §11) endpoint scope.

---

## 16. M1 deltas to apply before M2

These are the breaking changes the contract requires, applied while M1
is still the only consumer. Each is a discrete PR unless noted otherwise.

**Estimate revision:** The original draft stated "~1 week of work for
D1–D8." The full delta list (D1–D18 after missing work was surfaced by
audit) is **~12–15 days** of net implementation time. The 1-week figure
was based on an incomplete D-row count (11 items vs. the 18 enumerated
below). The revised estimate does not include sprint ceremonies or code
review cycles.

---

### Delta table

| # | Delta | File(s) | Effort |
|---|---|---|---|
| D1 | Switch `signStreamToken` to fixed-template canonical JSON per §5.1 (alphabetical-sorted keys, RFC 8785; `v: 1`; renamed `k`/`rid`/short claims). Update all call sites — 4 sign sites and 5 verify sites in `server/routes/iptv.ts` plus the test file. Add test vector file. | `server/services/iptvStreamToken.ts`, `iptvStreamToken.test.ts`, `server/routes/iptv.ts` (all sign/verify call sites), `tests/vectors/stream-token-canonical.json` (new) | 4–5h |
| D2a | Introduce `STREAM_TOKEN_SECRET` env var. Verifier tries new key first; on HMAC mismatch falls back to `SESSION_SECRET` with a WARN log. Boot-time assertion that all three secrets (`SESSION_SECRET`, `STREAM_TOKEN_SECRET`, `DEVICE_TOKEN_SECRET`) are pairwise distinct — throw with a clear message if any two match. Add same length/placeholder validation as `SESSION_SECRET`. | `server/env.ts`, `server/services/iptvStreamToken.ts`, `server/services/secrets.ts` (new — distinctness + validation helpers) | 2h |
| D2b | Drop the `SESSION_SECRET` fallback from the verifier entirely. **Must not ship until at least 90 days after D2a is deployed** (longest in-flight token TTL is the 90-day playlist token once D12 is applied; the fallback window must cover that full TTL before the old-key path is removed). | `server/services/iptvStreamToken.ts` | 0.5h, blocked on the 90-day TTL window post-D2a |
| D3 | Add `jti` (ULID) to stream token payload. Replace the bloom-cache model with an in-process `Map<jti, exp>` replay cache (zero false positives; bloom filters cannot implement the contract's stated per-kind reuse semantics — see sec-key-separation F3/F4). Cache applies to `segment` tokens only (already unique by `resourceId`). `live`/`vod`/`series`/`catchup` tokens: allow multi-use until `exp` (store on first presentation, reject only if presented after `exp`). `playlist` tokens: excluded from the in-process cache; their revocation is persistent via §6.2 table (D12). TTL-eviction GC sweep every 60 seconds. | `server/services/iptvStreamToken.ts`, new `server/services/tokenReplayCache.ts`, new dep `ulid` | 4h |
| D4 | Document `'remux'` as dual-membership: it is a valid stream-token `kind` (used in `rewriteRemuxManifest` / `checkToken`) AND a concurrency-tracker kind. **No code change to either enum** — the previous draft's plan to remove `'remux'` from `StreamKind` was incorrect and would have broken AVPlayer segment playback. Update comments in both files to state the dual-membership explicitly and cross-reference this delta so future readers do not re-open the question. | Comments only in `server/services/iptvStreamToken.ts` and `server/services/iptvConcurrency.ts` | 1h |
| D5 | Scaffold a new `server.db` with its own migrator. Generalise the existing `openIptvDb` into `openDb(migrationsDir, dbPath, dbName)` so both databases share the same migration infrastructure. Add a `server_state` table. Generate a UUID v4 `server_id` at first boot (`INSERT OR IGNORE`). New env var `SERVER_DB_PATH` (default `./data/server.db`). Migration lives at `server/migrations/server/0001_init.sql` — explicitly **not** under `server/migrations/iptv/` to avoid the migrator glob collision that D5's original path (`server/migrations/0001_*.sql`) would have caused. | `server/services/db.ts` (refactor — extract `openDb`), `server/migrations/server/0001_init.sql` (new directory), `server/index.ts` (boot sequence) | 5–6h |
| D6 | Implement `GET /api/version` per §12.1 (see also §7.2 for response shape). Open endpoint (no auth). Response includes `server_id` (requires D5) and `schema_migrations` versions from all DBs (requires D8a so the query is uniform). Support `EEX_VERSION_ENDPOINT_MINIMAL` env to suppress internal detail in public-facing deployments. Add test file. | new `server/routes/version.ts`, mount in `server/app.ts`, `server/routes/version.test.ts` | 3h. **Blocked on D5** (server_id) and **D8a** (schema_migrations shape stable across both DBs). |
| D7 | Namespace prefix migration and parser guard across all four backfill paths called out in §8: (1) `iptv.db` migration `0002_namespace_sub.sql` — backfill `iptv_favorites.sub` and `iptv_watch_history.sub`; (2) `exchange.db` migration `recommender/migrations/0006_namespace_sub.sql` — backfill any `sub` rows; (3) `feedback.json` one-time key rename script; (4) Hono session/auth namespace prefix on new logins. Grace-period handling: `verifySession` reads the cookie `sub` field through `parseSub` which accepts both bare and prefixed forms during the 30-day grace window, then normalises to the prefixed form before writing back. `checkToken` stream-token path: same grace-period normalisation for `sub` claim. New `parseSub(s: string): Sub` helper module; mirrored regex in Rust (`sub` module, §17) and Swift (EmeraldKit). Test vectors `tests/vectors/sub-namespace.json`. **D8 should land before D7** so the new migrations follow the `schema_migrations` convention from the outset. | `server/services/sub.ts` (new — `parseSub`, `Sub` type, namespace validation regex), `server/session.ts`, `server/middleware/auth.ts`, `server/routes/iptv.ts` (line 486 and all `sub` read/write paths in favorites and history endpoints), `server/services/userFeedback.ts`, `server/migrations/iptv/0002_namespace_sub.sql` (new), `recommender/migrations/0006_namespace_sub.sql` (new), `tests/vectors/sub-namespace.json` (new) | 6–8h |
| D8a | Lock the canonical `schema_migrations(version INTEGER NOT NULL PRIMARY KEY, applied_at TEXT, checksum TEXT NOT NULL)` shape. Specify: checksum is SHA-256 of the migration SQL after CRLF→LF normalisation. Checksum mismatch at boot → WARN log, do not fail boot, do not block further migrations. Spec change only — no code in this item. | Contract spec doc (this section) | 0.5h |
| D8b | Hono migrator: detect legacy `_migrations(id TEXT)` table (present in live `data/iptv.db`), rename it to `schema_migrations`, backfill `version = CAST(substr(id,1,4) AS INTEGER)`, compute and insert `checksum` for the single already-applied row. Switch all future INSERT statements to the new shape. Add CRLF→LF normalisation before both checksum computation and `exec`. Add `console.info('[migration] applying %s', file)` log line before each `exec` call. Add WARN on checksum mismatch. Add 30-second slow-migration WARN. Enforce `-- DESTRUCTIVE` marker: if any SQL file contains `DROP TABLE` and is not annotated `-- DESTRUCTIVE`, refuse to apply it; if `-- DESTRUCTIVE` is present, check that `server_state.last_backup_at` is within the last 10 minutes before proceeding. | `server/services/iptvDb.ts` (or refactored `server/services/migrator.ts`), `server/migrations/server/0001_init.sql` (add `last_backup_at` field to `server_state`) | 4h |
| D8c | Python migrator: `schema_migrations` currently has `filename TEXT PRIMARY KEY` — no `version INTEGER`, no `checksum`. Rebuild the table to the canonical shape via `CREATE TABLE schema_migrations_new ... INSERT ... DROP ... ALTER RENAME`. Backfill `version = CAST(substr(filename,1,4) AS INTEGER)`, compute `checksum`. Add CRLF→LF normalisation, checksum mismatch WARN, timing/destructive-marker logic matching D8b. The recommender DB is currently zero bytes so no live backfill concern, but the code path must be correct for first-boot initialisation. | `recommender/app/db.py` | 4h |
| D9 | Apply the user's chosen Resolution from §9 (recommender data-model contradiction). Effort is resolution-dependent: A ≈ 1 day (drop `iptv_ingest.py`, add migration `0007` to relax `iptv_kinds` CHECK constraint, clean up `title_features`/`title_vec` embedding rows); B ≈ 2 days (drop link table, switch `suggestions.ts` to query `exchange.db` directly, add WAL cross-process safety); C ≈ 0.5 day (document the dual-canonical line and add a CI integration test asserting both paths are exercised); D ≈ 1.5 days (sync-event-driven backfill via the iptv → recommender event bus). | Varies by resolution — see §9 for full file scope per option | 0.5–2 days. **Conditional on user's §9 pick.** |
| D10 | Add the 5 new CI jobs per §13.6: `test:contract-vectors` (read test vectors, assert TS+Rust+Swift produce identical bytes), `test:migrations-golden` (boot each DB from scratch, diff schema against golden snapshot), `build:no-iptv-server` (confirm recommender builds without Hono), `test:ffmpeg-boot` (boot with and without ffmpeg, assert correct behaviour each way — requires D16), `test:version-skew` (run old client against new server, assert version gate fires correctly — requires D6). | `.github/workflows/ci.yml`, golden snapshot files, test fixtures. **Blocked on D1, D6, D8a–D8c.** | 2–3 days |
| D11 | Add `removed_at TEXT NULL` column and partial index to `iptv_title_link` per §11.1. Change `iptvSync.ts` from hard-delete to soft-delete on de-listed titles. Update `tagIptvAvailability` filter to exclude `removed_at IS NOT NULL`. Add a nightly hard-delete sweep for rows where `removed_at < now() - 14 days`. | new `server/migrations/iptv/0003_link_tombstones.sql`, `server/services/iptvSync.ts`, `server/routes/suggestions.ts` | 3h. **Conditional: only ships if §9 outcome is Resolution A or C (link table is retained).** |
| D12 | Playlist token persistence and per-channel TTL correction. Create `iptv_playlist_tokens(jti, sub, issued_at, expires_at, revoked_at)` table in `iptv.db` per §6.2. Change M1's `POST /api/iptv/playlist/token` endpoint to write a row on issuance. Change `chTtl` from M1's 30-day value to 300 seconds for per-channel segment grants. Change `resourceId` from the bare string `'all'` to `'iptv-channels-all'`. Verifier reads `iptv_playlist_tokens` on every playlist token presentation and rejects if `revoked_at IS NOT NULL`. Admin UI surface: Revoke button. This also fixes the TTL contradiction between §5.6 (90-day contract) and M1 code (30-day); the new issued TTL is 90 days per §5.6, but the verifier fallback window (D2b) must not close until 90 days after D12 deploys so that any M1-era 30-day tokens also expire first. | new `server/migrations/iptv/0004_playlist_tokens.sql`, `server/routes/iptv.ts` lines 209–300 (issuance + TTL + resourceId), verifier path in `server/routes/iptv.ts`, admin UI Revoke surface | 6h |
| D13 | Device token registration and Devices UI. Create `device_tokens(jti, sub, device_id, device_name, platform, issued_at, expires_at, last_seen_at, last_seen_version)` and `device_token_revocations(jti, revoked_at, reason)` tables in `server.db` (requires D5). Schema MUST match §3.4 verbatim. Wire the device-token mint endpoint to insert into `device_tokens` on issuance. Verifier checks `device_token_revocations` on every bearer presentation AND confirms a `device_tokens` row exists (rejection on missing row catches restored-from-backup tokens after data-dir wipe). New endpoints: `GET /api/devices/self` (list caller's own live tokens), `DELETE /api/devices/self/:jti` (revoke one's own device), `DELETE /api/devices/self` (logout everywhere — revoke all `jti` for caller's `sub`), `PATCH /api/devices/self/:jti/name` (rename), admin variants under `/api/admin/devices/*`. Devices admin UI panel in the SPA. | new `server/migrations/server/0002_device_tokens.sql`, new `server/routes/devices.ts`, new `src/components/admin/DevicesPanel.tsx`, mount in `server/app.ts` | 1–1.5 days |
| D14 | Implement `reconcileDeviceToken(jti, sub)` per §3.4. Extracts the Plex-membership probe logic currently embedded in `reconcileSession` into a shared helper, then calls it from the device-bearer middleware path (the existing `reconcileSession` function has the wrong shape for device tokens — it accepts a `Session` struct with no `jti` or `aud` field, so the path cannot reuse it directly). Hook the new reconciler into the Plex membership probe path so that a Plex access revocation cascades to device token invalidation by writing to `device_token_revocations`. | `server/services/sessionGate.ts` (extend — extract shared Plex probe helper), new `server/services/reconcileDeviceToken.ts` | 3–4h |
| D15 | Implement `POST /api/admin/backup` per §7.4. `VACUUM INTO` each DB file to a temp path, tar both into a single archive, stream as the response with a JSON manifest (list of DB files, row counts, `schema_migrations` versions). Update `server_state.last_backup_at` on success — this field is consumed by D8b's `-- DESTRUCTIVE` migration enforcement, so D15 must land before any destructive migration can be applied in production. Protect behind admin-role check. | new `server/routes/adminBackup.ts`, mount in `server/app.ts`, admin UI trigger button | 4–5h |
| D16 | ffmpeg boot validation. New `server/services/ffmpeg.ts` per §13.4: run `ffprobe -version` synchronously at boot. If ffmpeg is absent or below version 6.0, refuse to boot with a clear error message (`[boot] ffmpeg ≥6.0 required; found: <version or missing>`). Used by `test:ffmpeg-boot` CI gate in D10. | new `server/services/ffmpeg.ts`, `server/index.ts` boot sequence | 2h |
| D17 | `auth_mode` plumbing. Add `auth_mode: 'plex' \| 'local'` field to the device-token mint path. Server determines the value from the session that triggers minting: Plex-authenticated session → `'plex'`; local session → `'local'`. Remove `'both'` from the value space (handled by §3.2 simplification — clients branch on the presence of each mode independently). The `auth_mode` claim informs the "Sign in with…" UI on re-auth. | `server/session.ts`, `server/env.ts` (expose whether Plex is configured), device-mint endpoint | 2h |
| D18 | Replace plain SHA-256 key derivation with HKDF-Extract (RFC 5869). Session cookie key: `HKDF(SESSION_SECRET, info='eex/session/v1')`; device-token key: `HKDF(DEVICE_TOKEN_SECRET, info='eex/device-token/v1')`; stream-token key: `HKDF(STREAM_TOKEN_SECRET, info='eex/stream-token/v1')`. Verifier on the session-cookie path: accept both old (raw SHA-256) and new (HKDF) derivations for a 30-day window (one cookie TTL), then drop the legacy path. Stream-token and device-token paths do not need a grace window because those secrets are being introduced fresh in D2a/D13. | `server/session.ts`, new `server/services/keyDerivation.ts` | 4h |

---

### Effort totals

| Group | Items | Net effort |
|---|---|---|
| Token shape and key separation | D1, D2a, D2b, D3, D4 | ~12h |
| Server infrastructure | D5, D6, D15, D16 | ~15–16h |
| Identity namespace | D7 | ~6–8h |
| Schema migrations | D8a, D8b, D8c | ~8.5h |
| Recommender resolution | D9 | ~4–16h (varies) |
| CI gates | D10 | ~16–24h |
| Tombstones (conditional) | D11 | ~3h |
| Playlist token persistence | D12 | ~6h |
| Device tokens | D13, D14 | ~11–15h |
| Auth plumbing | D17, D18 | ~6h |
| **Total** | **D1–D18** | **~88–117h ≈ 12–15 days** |

**Revised from the original draft's "~1 week" estimate.** The 1-week
figure was computed against D1–D8 only (19–20 hours of mechanical work).
Six entirely missing deltas (D12–D17) and the D8 → D8a/D8b/D8c split
account for the difference. The 12–15 day range is net coding time;
add sprint overhead for a real-world estimate.

---

### Dependency DAG and ordering constraints

```
D8a ──────────────────────────────────────┐
D8b (requires D8a, D5 for server_state)   │
D8c (requires D8a)                        │
D5  ──────────────────────────────────────┤──► D6 (requires D5 + D8a)
D1  ──────────────────────────────────────┤──► D10 (blocked on D1, D6, D8a-c)
D8a ─────────────────────────────► D7 (D8a first so new migrations use convention)
D9  ──────────────────────────────────────┤──► D11 (only if §9 = A or C)
D2a ─────────────────────(90-day TTL)────►D2b
D12 ─────────────────────(90-day TTL)────►D2b (playlist tokens now 90 days)
D13 (requires D5 for server.db)
D14 (requires D13)
D15 (requires D5; gates D8b destructive-migration enforcement)
```

**Must land before any TestFlight build mints a device token:**
D1, D2a, D5, D7, D8a, D8b, D8c, D12, D13, D14, D17.

**D2b:** waits ≥90 days post-D2a deploy (longest in-flight token TTL
once D12 raises playlist TTL to 90 days).

**D11:** ships only if §9 resolution retains the link table (A or C).

**D9:** conditional on user's §9 pick; blocks nothing else except D11.

**Recommended sprint order:**
1. D8a (spec lock, zero-code) → unblocks D7 and D8b/D8c
2. D5 (new server.db + openDb refactor)
3. D8b + D8c (migrator upgrades, can run in parallel)
4. D1 + D2a (token canonicalisation + key separation, can run in parallel)
5. D3 + D4 (replay cache + remux comment, can run in parallel)
6. D7 (namespace migration — after D8a so the new migrations are conformant)
7. D15 + D16 (backup endpoint + ffmpeg check, independent, can run in parallel)
8. D6 (version endpoint — after D5 and D8a)
9. D12 (playlist token persistence)
10. D13 + D17 + D18 (device tokens + auth_mode + HKDF, batch)
11. D14 (reconcileDeviceToken — after D13)
12. D9 (recommender resolution — user decision required)
13. D10 (CI gates — after D1, D6, D8a-c)
14. D11 (tombstones — after D9 if §9 = A or C)
15. D2b (drop SESSION_SECRET fallback — ≥90 days after D2a + D12)

---

## 17. Rust `emerald-contracts` crate scope

To be created when M2 kickoff is imminent (not now). Spec it here so M2 doesn't reinvent.

**Location**: `<repo-root>/crates/emerald-contracts/` (cargo workspace in the existing monorepo, NOT a separate repository). Justification: vector files at `<repo-root>/tests/vectors/` are co-located with both Hono and Rust consumers; separate repos require submodules or duplicates. CI path-filtered job runs only on changes under `crates/` or `tests/vectors/`.

**Contents (locked)**:
- `stream_token` module: sign + verify using the fixed-template canonical serialiser from §5.1 (NOT `serde_json::to_string`). Hand-implement the byte template; assert against `tests/vectors/stream-token-canonical.json`. **Required regardless of §4 choice** (test-vector CI validation applies in both branches). Under §4=A, this module is test-vector-only — Hono is the sole live verifier. Under §4=B, this module is also used for live token verification in Rust services.
- `device_token` module: **only if §4 = Option B**. JWE A256GCM via `aes-gcm` crate (NCC Group audited 2020) + ~50 lines of hand-rolled JWE compact serialization. **Do NOT pull in `josekit`** — it has openssl/ring transitive deps and is unaudited as of mid-2026.
- `sub` module: `parse_sub`, `Sub` enum with `Plex(u64)` / `Local(Ulid)` / `Apple(String)` variants. Provider-dispatching parser identical to TS §8.3.
- `version` module: `/api/version` response DTO with `ApiVersion`, `SchemaVersions`, `ServerInfo` structs.
- `error_reasons` module: `Reason` enum mirroring the locked enum in §12.4.

**§4-conditional scope table**:

| Module | §4=A | §4=B |
|---|---|---|
| `stream_token` | Required (test-vector CI only; Hono is live verifier) | Required (test-vector CI + live verification) |
| `device_token` | NOT NEEDED | Required |
| `sub` | Required (shared DTO) | Required |
| `version` | Required (shared DTO) | Required |
| `error_reasons` | Required (shared DTO) | Required |
| test fixtures | Required (canonical JSON CI) | Required |

**License**: dual-license **Apache-2.0 OR MIT**, regardless of the user's §14 LICENSE decision for the rest of the project. Dual-licensing is standard Rust practice; it lets the crate be consumed by GPL projects (M3+M4 may inherit the user's chosen LICENSE) without the crate itself forcing copyleft on every downstream consumer of `emerald-contracts`. The §14 decision affects the M3 transcoder and media-core binaries, not this contract crate.

**Test fixture authoring**:
- Vectors live at `<repo-root>/tests/vectors/` (per §13.1). This is the single canonical home — no duplication, no symlinks.
- Hono tests reference vectors via `new URL('../../tests/vectors/...', import.meta.url)`. Rust integration tests reference them via `Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/vectors/")`. Add a `build.rs` with `println!("cargo:rerun-if-changed=../../tests/vectors/");` to ensure Cargo rebuilds integration tests when vectors change.
- **Hand-authored from RFC 8785 / spec, not generated from one implementation.** Authoring order: (a) write `tests/vectors/stream-token-canonical.json` as its own M1.5 deliverable BEFORE D1; (b) D1 (Hono) asserts against the pre-authored vectors; (c) when the Rust crate ships, it asserts against the same file. This breaks the chicken-and-egg cycle.
- PR review checklist requires a `_meta` block with `{authored_from: '<RFC or contract section>', author, date}` in every vector file.

**Not in scope (deferred to consuming services)**:
- ffmpeg invocations (M4 transcoder crate).
- HTTP routing (each service owns its own routing via axum, hono, etc.).
- Database access (each service owns its own pool: sqlx for Rust, better-sqlite3 for TS, sqlite3 for Python).
- Plex client (M1 owns it; if Rust ever needs it, port lives elsewhere).
- JWE for cookie sessions (lives in Hono; not cross-cutting).

---

## 18. Sequencing summary

1. **User decides the four [USER'S CALL] items**: §4 (internal auth boundary), §9 (recommender data model), §14 (LICENSE), §15 (telemetry). Each flips downstream implementation choices in the deltas.
2. **Apply contract-spec deltas D1-D18** (~12-15 days; see §16). Critical path:
   - D8a (lock canonical schema_migrations) is a doc-only prerequisite.
   - D5 (server.db scaffold) unblocks D6, D13, D17.
   - D1 (canonical JSON) unblocks D3, D10.
   - D8b/D8c (migrator reconciliation) unblock D7, D11.
3. **Test vector authoring** (must precede D1 and D7): hand-author `tests/vectors/stream-token-canonical.json` and `tests/vectors/sub-namespace.json` from spec. ~0.5 day.
4. **D9 resolution** (per user §9 pick). 0.5-2 days.
5. **D10 CI gates**. 2-3 days.
6. **M2 kickoff**: spin up `theemeraldexchange-apple/` repo, scaffold EmeraldKit, write Swift test-vector assertions against the same `tests/vectors/` files BEFORE any production Swift code lands.
7. **D2b drop fallback**: 90 days post-D2a deploy. Schedule reminder.

**Done = all four user decisions documented, all deltas merged, green CI on the 5 new contract gates, M1 still passing all M1 tests after deltas.**

---

## 19. Open items in this draft (review checklist)

Decisions:
- [x] §4: Hybrid D (signed-and-encrypted internal token) PICKED 2026-05-25. Canonical crypto implementation in Rust (`emerald-contracts` crate per §17); Hono binds via N-API, Python via PyO3. Cost ~33–37h. Subtle hazard: AES-GCM nonce reuse — use `josekit`/`jose` defaults, no hand-rolled crypto.
- [x] §9: Resolution A PICKED 2026-05-25. Drop per-source rows, keep `iptv_title_link` join. Local-first source-precedence resolved at the grant endpoint: media-core (M3+) > Plex > IPTV. Auto-fallback on rank-1 unavailability; explicit user action on mid-session source failure (new `'source_unavailable'` reason code in §12.4 enum).
- [x] §14: LICENSE DEFERRED to first binary-distribution event (M2 TestFlight). Repo stays private; no public registry uploads; no outside PRs merged. Realistic shortlist at M2: All Rights Reserved or custom proprietary EULA.
- [x] §15: Self-hosted Glitchtip PICKED 2026-05-25, MANDATORY in the EEX stack (no telemetry-disabled build). Per-self-hoster crash-data islands; DSN distributed server→app at boot; PII scrubber in `emerald-contracts::telemetry`; App Store labels: "Crash Data" + "Diagnostic Data", no third-party processor. ~35–40h M1.5 slice.

Ratifications:
- [x] §3.2: ratify the revised device-token claim shape (especially removal of `device.name`/`device.app_version` from JWE in favour of server-side `device_tokens` table; reduction to 180-day TTL).
- [x] §3.4 revocation surface ratified: two `server.db` tables (`device_tokens` + `device_token_revocations`); 5-step verifier check order with error codes `token_revoked` / `token_expired` / `server_mismatch`; in-process `Set<string>` cache (no bloom filter) rebuilt synchronously after every revocation write; `reconcileDeviceToken(jti, sub)` implemented as a separate function from `reconcileSession` (required for Plex cascade); operator admin surface endpoints (`POST /api/admin/devices/:jti/revoke`, `PATCH /api/admin/devices/:jti`, `DELETE /api/devices`) and self-revoke (`DELETE /api/devices/self`) all specified.
- [x] §3.6 `jose` multi-kid symmetric verifier pattern ratified: `decodeProtectedHeader(token).kid` called before `jwtDecrypt`; `kid` resolved from `Map<string, Uint8Array>`; absent or unknown `kid` hard-rejects (key iteration forbidden); reference implementation lands as a new D-row in §16 deltas; `device-token-kid-rotation.json` test vector added to §13.1 vector set.
- [x] §3.5: ratify 180-day TTL (down from 365-day draft).
- [x] §3.7: ratify Keychain attribute lock (`AfterFirstUnlockThisDeviceOnly`, multi-server key shape).
- [x] §5.1: ratify fixed-template canonical serializer over RFC 8785 JCS.
- [x] §5.2: ratify the alphabetical byte template; the previous self-contradictory 'strict order' bullet is deleted.
- [x] §5.3: ratify `'remux'` as dual-membership kind (this corrects the previous-draft error).
- [x] §5.5: ratify `Map<jti, exp>` replay model (replaces bloom filter).
- [x] §5.6: ratify TTL table (live 300s / vod-series-catchup 3600s / segment 60s / playlist 90 days).
- [x] §6.1-§6.5: ratify the playlist-token redesign (90-day outer + 300s inner; persistent revocation; ATS HTTPS-proxy lock; Xtream Codes as out-of-scope future).
- [x] §7.1: ratify the 3-way `_migrations`/`schema_migrations` reconciliation path + CRLF normalization + `-- DESTRUCTIVE` marker enforcement.
- [x] §8.1-§8.3: ratify the provider-dispatching `parseSub` (replaces the buggy regex from the previous draft).
- [x] §11: ratify the conditional-on-§9 framing + the cascade-reasoning correction (watch history doesn't cascade) + 14-day window (down from 30).
- [x] §12.1: ratify the removal of `api_versions` (path-prefix versioning doesn't exist yet) + tiered minimal response env.
- [x] §12.3: ratify `server_id` in `server.db` (not `iptv.db`) + the corrected backup/restore behaviour.
- [x] §12.4: ratify 503 (not 426) for server-too-old + closed `reason` enum.
- [x] §13.1-§13.6: ratify test-vector path, IPTV_DISABLED split (server runtime guard / client compile-flag), ffmpeg M1.5 not M4-era validation, CI job inventory.
- [x] §16: ratify the expanded D1-D18 delta list and the revised ~12-15 day estimate (was ~1 week).
- [x] §17: ratify Rust crate location (`<repo-root>/crates/emerald-contracts/`), dual-license (Apache-2.0 OR MIT), test vector hand-authoring discipline.

Once all decisions are made and all ratifications checked, this doc becomes the locked contract and M1.5 implementation starts.

**Ratified 2026-05-25.** All 4 decisions PICKED/DEFERRED, all 21 ratification items checked. Contract is LOCKED. M1.5 implementation kickoff dispatched immediately after.

