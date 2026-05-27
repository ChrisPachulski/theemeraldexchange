// Encrypted-cookie session. The session payload is a JWE (A256GCM
// content-encrypted with an HKDF-derived key from SESSION_SECRET)
// that lives in the `eex.session` HttpOnly cookie. Stateless — no
// server-side store. Rotating SESSION_SECRET invalidates every existing
// session, which is the right behavior for a forced sign-out.
//
// Why JWE instead of plain SignJWT: the payload includes the user's
// Plex auth token (so admin routes can call plex.tv on their behalf).
// SignJWT only signs — the payload is base64-readable, so a copied or
// logged cookie would expose the Plex token to anyone holding it.
// JWE encrypts the payload end-to-end so the cookie is opaque even if
// captured.
//
// Key derivation (D18, RFC 5869):
//   New key  — HKDF(SESSION_SECRET, info='eex/session/v1')
//   Legacy   — SHA-256(SESSION_SECRET)  [grace-window only; see below]
//
// Grace-window (session-cookie path only):
//   Session cookies have a 30-day TTL. Switching key derivation
//   immediately would silently log out every active user whose cookie
//   was minted under the old SHA-256 key. To avoid that, verifySession
//   tries the new HKDF key first; on decryption failure it retries with
//   the legacy SHA-256 key and emits a WARN log so the operator can
//   monitor the tail-off. The legacy path is scheduled for removal after
//   one full cookie TTL (30 days) from the D18 deploy date.
//
//   createSession always uses the new HKDF key — new cookies are
//   immediately on the new derivation. Only the verifier carries the
//   dual path.
//
//   Stream-token and device-token keys are introduced fresh in D2a/D13
//   and carry NO grace window in their respective owners
//   (iptvStreamToken.ts / deviceToken.ts).

import { EncryptJWT, jwtDecrypt } from 'jose'
import { createHash } from 'node:crypto'
import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import * as contracts from '@emerald/contracts-napi'
import { env } from './env.js'
import { deriveKey, INFO_SESSION, INFO_DEVICE_TOKEN } from './services/keyDerivation.js'
import { tryNormaliseLegacySub } from './services/sub.js'
import { generateUlid } from './services/iptvStreamToken.js'
import { serverDb, ensureServerId } from './services/serverDb.js'

// Device-token JWE encrypt/decrypt is delegated to the Rust crate
// (@emerald/contracts-napi) so wire bytes are produced by the same code
// the cross-language vectors lock down. Session-cookie JWE stays on
// `jose` for now — its grace-window code path is delicate and not on
// the M2 critical path.

const COOKIE_NAME = 'eex.session'
const SESSION_TTL_DAYS = 30

export type Role = 'admin' | 'user'

/** Auth provider recorded in a device token at mint time (§3.2).
 *  'both' was eliminated — server-side config (which providers are
 *  enabled) lives in /api/version, not in the token. Clients branch on
 *  the presence of each mode independently.
 *  'apple' is added now (zero cost) so D17 changes are not reopened
 *  when Sign in with Apple lands in M2. */
export type AuthMode = 'plex' | 'local' | 'apple'

export type Session = {
  sub: string // plex user id (string for jwt sub claim)
  username: string
  role: Role
  /** Auth provider used when this session was created. Embedded in the
   *  session cookie so the device-token mint endpoint (D13) can read it
   *  server-side without inferring from plexAuthToken presence (fragile).
   *  Optional for backward-compat: cookies issued before D17 won't have
   *  this field; verifySession defaults missing values to 'plex' (all M1
   *  sessions are Plex-authenticated). Drop the default after one full
   *  cookie TTL (30 days post-D17 deploy). */
  auth_mode?: AuthMode
  /** The user's Plex auth token, threaded through so admin-only routes
   *  (e.g. /api/users) can call plex.tv on their behalf without us
   *  storing a long-lived owner token in env. Optional for forward-
   *  compatibility with existing sessions issued before this field
   *  existed — those users will need to re-auth before token-using
   *  endpoints work for them. */
  plexAuthToken?: string
  verifiedPlexServerId?: string
}

/** Derive the device-token `auth_mode` claim (§3.2) from the session
 *  that triggers a device-token mint.
 *
 *  Once D7 lands and all `sub` values carry a namespace prefix, the
 *  prefix alone is canonical (`plex:` → 'plex', `local:` → 'local',
 *  `apple:` → 'apple'). Until then (M1 sessions carry bare Plex IDs),
 *  `local:` and `apple:` are the only prefixes that can appear, so any
 *  un-prefixed sub is safely treated as Plex — which is correct for all
 *  M1 sessions.
 *
 *  auth_mode is NOT read from the session payload here (session.auth_mode
 *  would also be correct post-D17) — we derive from sub so this helper
 *  works even for session objects without the auth_mode field, e.g.,
 *  during the 30-day backward-compat window.
 */
export function authModeFromSession(session: Pick<Session, 'sub'>): AuthMode {
  if (session.sub.startsWith('local:')) return 'local'
  if (session.sub.startsWith('apple:')) return 'apple'
  return 'plex'
}

/** Type-guard: true when a mint request should carry auth_mode 'plex'.
 *  Convenience wrapper over authModeFromSession for callers that only
 *  need the boolean. */
export function isPlexSession(session: Pick<Session, 'sub'>): boolean {
  return authModeFromSession(session) === 'plex'
}

/** Input to mintDeviceToken. The caller (device-mint endpoint, D13)
 *  reads the validated session and the client-supplied pairing body,
 *  then passes this to mint the JWE bearer token.
 *
 *  auth_mode is NOT supplied by the caller directly — it is DERIVED from
 *  the session via authModeFromSession. This type captures the shape
 *  D13's endpoint will build before calling mintDeviceToken. */
export type DeviceTokenInput = {
  /** Namespace-prefixed subject (§8). Must already be prefixed
   *  (e.g. 'plex:12345'). Pre-D7 callers pass the bare Plex id; D7
   *  will update this once sub prefixes are deployed universally. */
  sub: string
  role: Role
  /** auth_mode derived from the triggering session via authModeFromSession.
   *  The mint endpoint MUST call authModeFromSession(session) and pass
   *  the result here — it MUST NOT let the client supply this value. */
  auth_mode: AuthMode
  /** Stable ULID generated by the client and sent in the pairing body.
   *  Stored in Keychain on-device. */
  device_id: string
  /** Advisory platform string ('tvos' | 'ios' | 'ipados' | 'macos').
   *  Validators warn on unknown values but MUST NOT reject. */
  device_platform: string
  /** Display name for this device — client-supplied at pairing time
   *  (Apple device name) and stored in device_tokens.device_name.
   *  Mutable via admin/self rename routes. NOT carried in the JWE. */
  device_name: string
  /** Stable server UUID from server_state (§12.3). */
  server_id: string
}

/** kid for the v1 device-token key. Bump (`device-v2`, etc.) when
 *  rotating the underlying secret; the verifier's keymap stays
 *  populated with both kids during the grace window. The locked
 *  byte-level cross-language constant lives in
 *  `crates/emerald-contracts/src/device_token.rs` (`DEFAULT_KID`). */
export const DEVICE_TOKEN_KID = 'device-v1'

/** 180-day TTL per contract §3.5. NOT 1 year despite design.md older
 *  text — contract wins, locked 2026-05-25. */
export const DEVICE_TOKEN_TTL_SECS = 180 * 24 * 60 * 60

/** Cached device-token key. Lazy on first use rather than at module load
 *  so dev environments without DEVICE_TOKEN_SECRET don't crash on import.
 *  Resets to null on hot-reload. */
let cachedDeviceKey: Uint8Array | null = null

function getDeviceKey(): Uint8Array {
  if (!env.deviceTokenSecret) {
    throw new Error(
      'mintDeviceToken/verifyDeviceToken called without DEVICE_TOKEN_SECRET configured. ' +
        'Set DEVICE_TOKEN_SECRET in .env.local (and .env.production for prod). ' +
        'M2 Apple PIN-pair flow cannot work without it.',
    )
  }
  if (!cachedDeviceKey) {
    cachedDeviceKey = deriveKey(env.deviceTokenSecret, INFO_DEVICE_TOKEN)
  }
  return cachedDeviceKey
}

/** Test-only: clear the cached device key after rotating the secret in tests. */
export function _resetDeviceKeyForTests(): void {
  cachedDeviceKey = null
}

/** Mint a device-token JWE (§3.2). HKDF-derived AES-256-GCM, kid
 *  protected header for rotation, jti row inserted into
 *  server.db/device_tokens for revocation-cache lookup at verify time.
 *
 *  Wire format matches `emerald-contracts::device_token` byte-for-byte
 *  (cross-language gate via `tests/vectors/internal-principal.json`
 *  shape spec — JWE compact bytes are non-deterministic due to nonce
 *  but every other field is fixed).
 */
export async function mintDeviceToken(input: DeviceTokenInput): Promise<string> {
  const key = getDeviceKey()
  const now = Math.floor(Date.now() / 1000)
  const exp = now + DEVICE_TOKEN_TTL_SECS
  const jti = generateUlid()

  // Delegated to crates/emerald-contracts via N-API. The crate hard-codes
  // the JWE protected header to {alg:'dir', enc:'A256GCM', kid} and the
  // claim ordering — wire bytes are locked by the cross-language vectors.
  const token = contracts.deviceTokenEncrypt(Buffer.from(key), DEVICE_TOKEN_KID, {
    aud: 'device',
    iss: 'eex',
    sub: input.sub,
    role: input.role,
    authMode: input.auth_mode,
    deviceId: input.device_id,
    devicePlatform: input.device_platform,
    serverId: input.server_id,
    jti,
    iat: now,
    nbf: now,
    exp,
  })

  // §3.4: insert into device_tokens. Verifier later checks that the row
  // exists — catches restored-from-backup tokens after a data-dir wipe.
  // Column name `platform` (not device_platform) and `device_name` per
  // contract §3.4 — JWE claim names diverge from DB column names
  // intentionally (device_name is mutable, JWE claims are immutable).
  serverDb()
    .raw.prepare(
      `INSERT INTO device_tokens
        (jti, sub, device_id, device_name, platform, server_id, kid, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      jti,
      input.sub,
      input.device_id,
      input.device_name,
      input.device_platform,
      input.server_id,
      DEVICE_TOKEN_KID,
      new Date(now * 1000).toISOString(),
      new Date(exp * 1000).toISOString(),
    )

  return token
}

/** Decoded device-token claims (post-verify). All fields are required
 *  in a valid token — verifyDeviceToken returns null on any shape
 *  mismatch rather than partially-typed claims. */
export type DeviceTokenClaims = {
  aud: 'device'
  iss: 'eex'
  sub: string
  role: Role
  auth_mode: AuthMode
  device_id: string
  device_platform: string
  server_id: string
  jti: string
  iat: number
  nbf: number
  exp: number
}

/** Verify a device-token JWE. Performs:
 *  1. Read `kid` from the protected header without decrypting.
 *  2. Look up the active key for that kid (only `device-v1` at v1).
 *  3. Decrypt + parse claims.
 *  4. Validate aud/iss claims.
 *  5. Check that the jti row exists in `device_tokens`.
 *  6. Check that the jti is NOT in `device_token_revocations`.
 *
 *  Returns null on any failure. Callers that need a specific reason
 *  for logging should consult the rejection log written by this
 *  function (TODO: structured rejection logs). */
export async function verifyDeviceToken(token: string): Promise<DeviceTokenClaims | null> {
  const key = getDeviceKey()

  // Crate handles kid dispatch internally — pass the active key map.
  // At v1 there is only one kid; v2+ will add additional entries during
  // the rotation grace window.
  let claims: contracts.DeviceClaimsJs
  try {
    claims = contracts.deviceTokenDecrypt(
      [{ kid: DEVICE_TOKEN_KID, key: Buffer.from(key) }],
      token,
    )
  } catch {
    return null
  }

  if (claims.aud !== 'device' || claims.iss !== 'eex') return null
  if (claims.role !== 'admin' && claims.role !== 'user' && claims.role !== 'guest') return null
  if (
    claims.authMode !== 'plex' &&
    claims.authMode !== 'local' &&
    claims.authMode !== 'apple'
  )
    return null

  // §3.4 a-and-b checks: row exists AND not revoked.
  const db = serverDb().raw
  const row = db
    .prepare(`SELECT jti FROM device_tokens WHERE jti = ? AND expires_at > datetime('now')`)
    .get(claims.jti) as { jti: string } | undefined
  if (!row) {
    console.warn('[device-token] jti row missing or expired: %s', claims.jti)
    return null
  }
  const revoked = db
    .prepare(`SELECT jti FROM device_token_revocations WHERE jti = ?`)
    .get(claims.jti) as { jti: string } | undefined
  if (revoked) {
    console.warn('[device-token] jti revoked: %s', claims.jti)
    return null
  }

  return {
    aud: 'device',
    iss: 'eex',
    sub: claims.sub,
    role: claims.role as Role,
    auth_mode: claims.authMode as AuthMode,
    device_id: claims.deviceId,
    device_platform: claims.devicePlatform,
    server_id: claims.serverId,
    jti: claims.jti,
    iat: claims.iat,
    nbf: claims.nbf,
    exp: claims.exp,
  }
}

/** Mark a jti as revoked in `device_token_revocations`. Idempotent — a
 *  second revoke on the same jti is a no-op. */
export function revokeDeviceToken(jti: string, reason: string): void {
  serverDb()
    .raw.prepare(
      `INSERT OR IGNORE INTO device_token_revocations (jti, revoked_at, reason)
       VALUES (?, datetime('now'), ?)`,
    )
    .run(jti, reason)
}

/** Re-export so consumers can resolve server_id without an extra import. */
export { ensureServerId }

// New derivation (D18): HKDF-Extract+Expand, info = INFO_SESSION.
// This is the canonical signing key for all cookies issued from D18 onward.
const hkdfKey = deriveKey(env.sessionSecret, INFO_SESSION)

// Legacy derivation: plain SHA-256. Used ONLY in the verifier grace window
// so users with cookies minted before the D18 deploy are not silently
// logged out. The signer (createSession) never uses this key.
// TODO: Remove after 2026-06-25 (30 days post-D18 deploy — one cookie TTL).
const legacyKey = createHash('sha256').update(env.sessionSecret, 'utf8').digest()

export async function createSession(payload: Session): Promise<string> {
  return await new EncryptJWT({ ...payload })
    // No `kid` in this header: v1 has a single active session key, so there
    // is no ambiguity about which key to use. At v2 key rotation, add a
    // `kid` here (and in verifySession) before deploying two concurrent keys;
    // without it the verifier would need to brute-force both keys per token.
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_DAYS}d`)
    .encrypt(hkdfKey)
}

export async function verifySession(token: string): Promise<Session | null> {
  // Try the current HKDF-derived key first.
  const result = await tryDecrypt(token, hkdfKey)
  if (result !== null) return result

  // Grace-window fallback: attempt the legacy SHA-256 key. A cookie
  // that decrypts here was minted before D18. Emit a WARN so the
  // operator can see the tail-off and remove this path after
  // 2026-06-25.
  const legacy = await tryDecrypt(token, legacyKey)
  if (legacy !== null) {
    console.warn('[session] legacy-sha256-key accepted — user needs re-auth before grace window expires')
    return legacy
  }

  return null
}

async function tryDecrypt(token: string, key: Uint8Array): Promise<Session | null> {
  try {
    const { payload } = await jwtDecrypt(token, key)
    if (typeof payload.sub !== 'string') return null
    if (typeof payload.username !== 'string') return null
    const role = payload.role
    if (role !== 'admin' && role !== 'user') return null
    const plexAuthToken =
      typeof payload.plexAuthToken === 'string' ? payload.plexAuthToken : undefined
    const verifiedPlexServerId =
      typeof payload.verifiedPlexServerId === 'string' ? payload.verifiedPlexServerId : undefined
    // Backward-compat default: cookies issued before D17 have no auth_mode
    // field. All M1 sessions are Plex-authenticated, so 'plex' is the safe
    // fallback. TODO: drop this default after 2026-06-25 (30 days post-D17
    // deploy) — at that point all active cookies will carry an explicit value.
    const rawAuthMode = payload.auth_mode
    const auth_mode: AuthMode =
      rawAuthMode === 'plex' || rawAuthMode === 'local' || rawAuthMode === 'apple'
        ? rawAuthMode
        : 'plex'

    // Grace-window normalisation (§8.2 D): M1 cookies carry an unprefixed
    // Plex user id as `sub`. Normalise bare numeric ids to `plex:<id>` in
    // memory for the 30-day grace period post-D7. The cookie on disk is NOT
    // re-encrypted — the rewrite re-applies on every request until the
    // cookie expires or the user re-authenticates. Drop this block one
    // cookie-TTL (30 days) after D7 ships.
    const parsed = tryNormaliseLegacySub(payload.sub)
    if (!parsed) return null

    return {
      sub: parsed.raw,
      username: payload.username,
      role,
      auth_mode,
      ...(plexAuthToken ? { plexAuthToken } : {}),
      ...(verifiedPlexServerId ? { verifiedPlexServerId } : {}),
    }
  } catch {
    return null
  }
}

export async function setSessionCookie(c: Context, session: Session): Promise<void> {
  const token = await createSession(session)
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.isProd,
    sameSite: env.isProd ? 'None' : 'Lax',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  })
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, COOKIE_NAME, { path: '/' })
}

export async function readSession(c: Context): Promise<Session | null> {
  const token = getCookie(c, COOKIE_NAME)
  if (!token) return null
  return await verifySession(token)
}
