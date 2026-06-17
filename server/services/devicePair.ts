// Shared device-pairing mint branch for the non-Plex login routes.
//
// The native app (tvOS/iOS) needs a device-token Bearer JWE, not a web
// session cookie. The Plex pair flow mints one in routes/device.ts; this
// helper gives the Apple / passkey / Google routes the SAME capability
// without duplicating the parse → mint → respond block three times.
//
// Contract: when the request body carries the device-pair triple
// (device_id, device_name, device_platform), the caller is a device — mint
// a device token and return the routes/device.ts wire shape
// { status:'authorized', token, server_id, user }. When NONE are present
// the caller is a browser — return null so the route falls through to its
// existing setSessionCookie path. A PARTIAL triple is a client bug → 400,
// never a silent cookie.
//
// MUST be called AFTER authN + the shared authZ gate (authorizeOrRedeem):
// the identity passed in is already proven and admitted, so this only
// chooses the credential FORMAT (Bearer vs cookie), never the decision.

import type { Context } from 'hono'
import { mintDeviceToken, ensureServerId, type AuthMode, type Role } from '../session.js'

export type DevicePairIdentity = {
  /** Namespace-prefixed subject (§8), e.g. 'apple:...' / 'local:...' / 'google:...'. */
  sub: string
  role: Role
  /** Derived server-side from the proven identity — never client-supplied. */
  auth_mode: AuthMode
  /** Display name captured at pairing time; advisory, stored for role recompute. */
  username?: string
}

type DeviceFields = { device_id: string; device_name: string; device_platform: string }

/** Pull the device-pair triple from a parsed route body. Returns the
 *  trimmed fields, `null` when none are present (browser/cookie mode), or
 *  'partial' when some-but-not-all are present (client bug). */
function readDeviceFields(body: unknown): DeviceFields | null | 'partial' {
  const b = (body ?? {}) as Record<string, unknown>
  const device_id = typeof b.device_id === 'string' ? b.device_id.trim() : ''
  const device_name = typeof b.device_name === 'string' ? b.device_name.trim() : ''
  const device_platform = typeof b.device_platform === 'string' ? b.device_platform.trim() : ''
  const present = [device_id, device_name, device_platform].filter(Boolean).length
  if (present === 0) return null
  if (present < 3) return 'partial'
  return { device_id, device_name, device_platform }
}

/**
 * If `body` carries the device-pair triple, mint a device token and return
 * the wire-contract JSON Response. Returns null for browser requests so the
 * caller continues to its session-cookie path. The body is passed in
 * (already parsed by the route) because a Hono request body can only be
 * read once.
 */
export async function maybeMintDeviceToken(
  c: Context,
  body: unknown,
  identity: DevicePairIdentity,
): Promise<Response | null> {
  const fields = readDeviceFields(body)
  if (fields === null) return null
  if (fields === 'partial') {
    return c.json({ error: 'incomplete_device_fields' }, 400)
  }

  const server_id = ensureServerId()
  const token = await mintDeviceToken({
    sub: identity.sub,
    role: identity.role,
    auth_mode: identity.auth_mode,
    device_id: fields.device_id,
    device_name: fields.device_name,
    device_platform: fields.device_platform,
    username: identity.username,
    server_id,
  })

  return c.json({
    status: 'authorized',
    /** Bearer JWE — apps store in Keychain
     *  (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly). */
    token,
    /** Stable server UUID — apps include in the Keychain key so a
     *  server_id reset (data-dir wipe) invalidates the stored token. */
    server_id,
    user: {
      sub: identity.sub,
      username: identity.username ?? '',
      role: identity.role,
    },
  })
}
