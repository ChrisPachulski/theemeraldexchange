// Apple device-pair flow.
//
//   POST /api/auth/device/start  — create a Plex PIN; return id + code
//                                  + the verification URL. tvOS/iOS
//                                  apps show the code on-screen and
//                                  ask the user to visit plex.tv/link.
//   POST /api/auth/device/poll   — poll the PIN. When the user has
//                                  authorized in their phone/computer
//                                  browser, exchange for identity,
//                                  verify server membership (same gate
//                                  as the cookie /plex/check), mint a
//                                  device-token JWE bound to the
//                                  client-supplied device_id +
//                                  device_name, persist a row in
//                                  device_tokens, and return the
//                                  Bearer token plus server_id for
//                                  Keychain keying.
//
// Both endpoints reuse the existing createPin/checkPin Plex helpers
// (server/plex.ts) so the upstream rate-limit and PIN-lifecycle
// semantics are identical to the cookie path. No new Plex API surface.

import { Hono, type Context } from 'hono'
import { env } from '../env.js'
import {
  buildAuthUrl,
  checkPin,
  createPin,
  getUser,
  listResources,
} from '../plex.js'
import { roleFor } from '../services/sessionGate.js'
import {
  mintDeviceToken,
  ensureServerId,
  type AuthMode,
  type Role,
} from '../session.js'

export const device = new Hono()

const PAIR_MAX_BODY_BYTES = 2048

async function parseLimitedJson(
  c: Context,
  maxBytes: number,
): Promise<{ tooLarge: boolean; body: unknown | null }> {
  const contentLength = c.req.header('content-length')
  if (contentLength) {
    const n = Number(contentLength)
    if (Number.isFinite(n) && n > maxBytes) return { tooLarge: true, body: null }
  }
  const stream = c.req.raw.body
  if (!stream) return { tooLarge: false, body: null }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return { tooLarge: true, body: null }
      }
      chunks.push(value)
    }
  } catch {
    return { tooLarge: false, body: null }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { tooLarge: false, body: JSON.parse(new TextDecoder().decode(bytes)) }
  } catch {
    return { tooLarge: false, body: null }
  }
}

device.post('/start', async (c) => {
  const pin = await createPin()
  return c.json({
    pinId: pin.id,
    code: pin.code,
    /** plex.tv URL the user opens on a separate device to authorize. */
    verificationUrl: 'https://plex.tv/link',
    /** Convenience deep-link prefilled with the code (some Apple TV
     *  setups can render this as a popover). */
    authUrl: buildAuthUrl(pin.code),
  })
})

device.post('/poll', async (c) => {
  const parsed = await parseLimitedJson(c, PAIR_MAX_BODY_BYTES)
  if (parsed.tooLarge) return c.json({ error: 'body_too_large' }, 413)
  const body = parsed.body as {
    pinId?: unknown
    device_id?: unknown
    device_name?: unknown
    device_platform?: unknown
  } | null

  const pinIdRaw =
    typeof body?.pinId === 'string' || typeof body?.pinId === 'number'
      ? String(body.pinId)
      : undefined
  if (!pinIdRaw) return c.json({ error: 'missing_pinId' }, 400)
  const pinId = Number(pinIdRaw)
  if (!Number.isInteger(pinId)) return c.json({ error: 'bad_pinId' }, 400)

  const deviceId = typeof body?.device_id === 'string' ? body.device_id.trim() : ''
  const deviceName = typeof body?.device_name === 'string' ? body.device_name.trim() : ''
  const devicePlatform =
    typeof body?.device_platform === 'string' ? body.device_platform.trim() : ''
  if (!deviceId) return c.json({ error: 'missing_device_id' }, 400)
  if (!deviceName) return c.json({ error: 'missing_device_name' }, 400)
  if (!devicePlatform) return c.json({ error: 'missing_device_platform' }, 400)

  const pin = await checkPin(pinId)
  if (!pin.authToken) return c.json({ status: 'pending' })

  const user = await getUser(pin.authToken)

  // Server-membership gate — same as the cookie /plex/check path. If
  // PLEX_SERVER_ID is unset we accept any authenticated Plex user
  // (first-deploy bootstrap mode); production envs reject the boot
  // without PLEX_SERVER_ID anyway, so reaching this branch in prod
  // means the operator explicitly set ALLOW_UNSCOPED_PLEX_LOGIN=1.
  if (env.plexServerId) {
    const resources = await listResources(pin.authToken)
    const isMember = resources.some(
      (r) => r.provides.includes('server') && r.clientIdentifier === env.plexServerId,
    )
    if (!isMember) {
      return c.json({ status: 'denied', reason: 'not_a_server_member' }, 403)
    }
  }

  const role: Role = roleFor(user.username)
  // Namespaced sub per §8.2 — device tokens always carry the prefixed
  // form (no legacy grace-window normalization needed for new mints).
  const sub = `plex:${String(user.id)}`
  const authMode: AuthMode = 'plex'

  const serverId = ensureServerId()

  const token = await mintDeviceToken({
    sub,
    role,
    auth_mode: authMode,
    device_id: deviceId,
    device_name: deviceName,
    device_platform: devicePlatform,
    server_id: serverId,
  })

  return c.json({
    status: 'authorized',
    /** Bearer JWE — apps store in Keychain
     *  (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly). */
    token,
    /** Stable server UUID — apps include in Keychain key so a
     *  server_id reset (data-dir wipe) invalidates the stored token
     *  and triggers re-pair. */
    server_id: serverId,
    user: {
      sub,
      username: user.username,
      role,
    },
  })
})
