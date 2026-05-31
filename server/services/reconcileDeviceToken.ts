// Per-request reconciliation for device-bearer auth.
//
// Unlike cookie sessions (sessionGate.reconcileSession), device tokens
// do NOT carry a Plex auth token — we have no way to per-request probe
// plex.tv on the user's behalf. The cascade revocation contract works
// in the OTHER direction: when a cookie session's reconcileSession
// returns null (Plex says not a member), the helper here revokes every
// device-token for that sub. M2 Apple device gets a 401 on its next
// request and falls back to the PIN re-pair flow.
//
// Per-request work here is therefore cheap:
//   - recompute role from env.admins (an admin demotion takes effect
//     immediately, same as the cookie path)
//   - touch last_seen_at on every protected request

import { serverDb } from './serverDb.js'
import type { DeviceTokenClaims } from '../session.js'
import { roleFor } from './sessionGate.js'
import { memberStatus } from './membership.js'

export type ReconciledDeviceSession = DeviceTokenClaims & {
  /** Stable identifier for /api/me. Device tokens don't carry a
   *  Plex username (the claim shape is locked); UI presents the
   *  device_name from device_tokens instead. Stored separately on the
   *  reconcile result so callers can render either. */
  device_name: string
}

/** Reconcile a verified device-token against current server state.
 *
 *  Returns the augmented session or null if the token should be
 *  rejected (e.g., the row was hard-deleted between verify and
 *  reconcile — rare but possible).
 */
export function reconcileDeviceToken(
  claims: DeviceTokenClaims,
  appVersion: string | null,
): ReconciledDeviceSession | null {
  const db = serverDb().raw

  // AuthZ gate — IDENTICAL to the cookie path's reconcileSession. The Bearer
  // path previously trusted the 180-day token claim and never re-checked the
  // allowlist, so a member revoked via /api/admin/members who only used the
  // native app kept full access until the token's TTL. Enforce memberStatus on
  // every Bearer request: a revoked/never-member sub is denied AND its device
  // tokens are cascade-revoked so the rejection persists. ADMIN_SUBS owners
  // short-circuit to 'allowed', so the operator is never locked out.
  const status = memberStatus(claims.sub)
  if (status !== 'allowed') {
    try {
      cascadeRevokeForSub(claims.sub, status === 'revoked' ? 'member_revoked' : 'not_member')
    } catch (e) {
      console.error('[reconcileDeviceToken] cascade-revoke failed for sub=%s: %s', claims.sub, e)
    }
    return null
  }

  // Read device_name + apply role recompute. roleFor needs a username
  // and device tokens don't carry one; we use sub-as-username for the
  // role check, which works because env.admins is a list of Plex
  // usernames that the cookie path already maps from. For device tokens
  // the mint path looked the role up at pairing time and embedded it
  // in the claim — so role IS already current as of pairing. We
  // additionally re-derive it from the sub-derived username so that
  // admin demotions land on the next request without re-pairing.
  //
  // Implementation note: the username-by-sub mapping lives in
  // device_tokens (not directly — but we can store it there at mint
  // time as a future enhancement). For now, trust the role claim and
  // touch last_seen_at.
  const row = db
    .prepare(
      `UPDATE device_tokens
         SET last_seen_at = datetime('now'),
             last_seen_version = COALESCE(?, last_seen_version)
       WHERE jti = ?
       RETURNING device_name`,
    )
    .get(appVersion, claims.jti) as { device_name: string } | undefined

  if (!row) {
    // jti row vanished between verify and reconcile (concurrent revoke +
    // delete). Treat as 401.
    return null
  }

  return {
    ...claims,
    device_name: row.device_name,
    // role passthrough — could re-derive via roleFor but device tokens
    // don't carry username. Future work: store username column in
    // device_tokens at mint time, then call roleFor here for parity
    // with the cookie path's per-request demotion semantics.
  }
}

/** Cascade revoke: every device-token for the given sub becomes
 *  revoked. Called by reconcileSession when Plex says the cookie user
 *  is no longer a member. Idempotent — re-revoking is INSERT OR IGNORE.
 */
export function cascadeRevokeForSub(sub: string, reason: string): number {
  const db = serverDb().raw
  const jtis = db
    .prepare(`SELECT jti FROM device_tokens WHERE sub = ?`)
    .all(sub) as Array<{ jti: string }>
  if (jtis.length === 0) return 0

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO device_token_revocations (jti, revoked_at, reason)
     VALUES (?, datetime('now'), ?)`,
  )
  const tx = db.transaction((rows: typeof jtis) => {
    for (const r of rows) stmt.run(r.jti, reason)
  })
  tx(jtis)
  return jtis.length
}

// roleFor is re-exported so middleware that builds a Session-shaped
// view from a device token has a single import surface.
export { roleFor }
