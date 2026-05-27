// Bearer-token middleware path. Hono auth.ts's loadReconciledSession
// tries this BEFORE the cookie path so Apple-paired devices (which send
// `Authorization: Bearer <JWE>` and no cookie) authenticate without
// CSRF concerns (no cookie → no cross-site forgery vector).
//
// The middleware reads the protected header, dispatches to the active
// key by kid, decrypts the JWE, validates claim shape, then runs the
// reconcile pass (role recompute + last_seen_at touch).

import type { Context } from 'hono'
import { verifyDeviceToken, type DeviceTokenClaims, type Session } from '../session.js'
import {
  reconcileDeviceToken,
  type ReconciledDeviceSession,
} from '../services/reconcileDeviceToken.js'

const BEARER_PREFIX = 'Bearer '

/** Lift a reconciled device-bearer claim set into the Session shape that
 *  the rest of the auth pipeline consumes. Device tokens don't carry a
 *  Plex username; we surface device_name as a stable display label.
 *
 *  This keeps the downstream `c.var.session` consumers (every protected
 *  route handler) working without forking on auth method. */
export function deviceSessionToSession(reconciled: ReconciledDeviceSession): Session {
  return {
    sub: reconciled.sub,
    username: reconciled.device_name, // proxy — device-authed clients
    // show their device name where the SPA shows a Plex username.
    role: reconciled.role,
    auth_mode: reconciled.auth_mode,
    // No plexAuthToken — device tokens do not carry one. Protected
    // routes that call plex.tv on the user's behalf MUST gracefully
    // degrade when this is absent (or 403 if Plex is required for that
    // specific call). Same constraint as legacy pre-D17 cookies.
  }
}

/** Try to authenticate via Bearer header. Returns:
 *  - `{ ok: true, session }` on success
 *  - `null` when no Authorization: Bearer header was present (caller
 *    falls back to cookie path)
 *  - `{ ok: false, reason }` when a Bearer was attempted but failed —
 *    caller should reject 401 without falling back to cookie
 */
export async function tryBearerAuth(
  c: Context,
): Promise<
  | { ok: true; session: Session; claims: DeviceTokenClaims }
  | { ok: false; reason: 'invalid_bearer' | 'reconcile_failed' }
  | null
> {
  const auth = c.req.header('Authorization') ?? c.req.header('authorization')
  if (!auth) return null
  if (!auth.startsWith(BEARER_PREFIX)) return null
  const token = auth.slice(BEARER_PREFIX.length).trim()
  if (!token) return { ok: false, reason: 'invalid_bearer' }

  const claims = await verifyDeviceToken(token)
  if (!claims) return { ok: false, reason: 'invalid_bearer' }

  // Bearer + clock-skew enforcement (jose handles nbf/exp during decrypt
  // but jwtDecrypt only enforces with the default clock — explicit
  // check belt-and-suspenders).
  const now = Math.floor(Date.now() / 1000)
  // 30s nbf skew + 5s exp skew per contract §5.7 (shared with stream
  // tokens; the constants live in the Rust crate).
  if (now + 30 < claims.nbf) return { ok: false, reason: 'invalid_bearer' }
  if (now - 5 > claims.exp) return { ok: false, reason: 'invalid_bearer' }

  const appVersion = c.req.header('X-App-Version') ?? null
  const reconciled = reconcileDeviceToken(claims, appVersion)
  if (!reconciled) return { ok: false, reason: 'reconcile_failed' }

  return { ok: true, session: deviceSessionToSession(reconciled), claims }
}
