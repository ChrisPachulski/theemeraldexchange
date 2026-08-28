// Web-claimed device pairing — the non-Plex twin of routes/device.ts.
//
//   POST /api/auth/device/link/start  { device_id, device_name, device_platform }
//        → { code, verify_url, expires_in, interval }        (public)
//   POST /api/auth/device/link/claim  { code }                (cookie session)
//        binds the signed-in member (any provider) to that code
//   POST /api/auth/device/link/poll   { code, device_id }     (public)
//        → { status:'pending' } | { status:'denied', reason } |
//          { status:'authorized', token, server_id, user }   (same shape as /device/poll)
//
// The Apple app has no browser session and tvOS has no web view, so a member
// who joined through WorkOS/Google/Apple could only ever pair via Plex. This
// lets them sign in on the web (where every provider already works) and hand
// that identity to the device. The minted token is identical to the Plex
// path's: same JWE, same device_tokens row, same revocation.

import { Hono } from 'hono'
import { randomInt } from 'node:crypto'
import { requireAuth, type Env } from '../middleware/auth.js'
import { enforceAuthRateLimit } from '../auth.js'
import { env } from '../env.js'
import { serverDb } from '../services/serverDb.js'
import { parseLimitedJson } from '../services/parseLimitedJson.js'
import { withAuthOutcome } from '../services/authOutcome.js'
import { mintDeviceToken, ensureServerId, authModeFromSession, type AuthMode, type Role } from '../session.js'

export const deviceLink = new Hono<Env>()

// No 0/O/1/I so the code survives being read off a TV and typed on a phone.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8
export const LINK_CODE_TTL_SECS = 600
const POLL_INTERVAL_SECS = 2
const MAX_BODY_BYTES = 2048
const CODE_SHAPE = /^[A-Z2-9]{8}$/

export function generateLinkCode(): string {
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return out
}

type Row = {
  code: string
  device_id: string
  device_name: string
  device_platform: string
  expires_at: number
  claimed_sub: string | null
  claimed_username: string | null
  claimed_role: Role | null
  claimed_auth_mode: AuthMode | null
  consumed_at: number | null
}

const normalizeCode = (raw: unknown) =>
  typeof raw === 'string' ? raw.trim().toUpperCase().replace(/[\s-]/g, '') : ''

function spaOrigin(reqUrl: string): string {
  return env.serveSpa ? new URL(reqUrl).origin : (env.allowedOrigins[0] ?? new URL(reqUrl).origin)
}

function sweepExpired(now: number): void {
  serverDb().raw.prepare(`DELETE FROM device_link_codes WHERE expires_at < ?`).run(now - LINK_CODE_TTL_SECS)
}

deviceLink.post('/start', (c) =>
  withAuthOutcome(c, 'link', 'check', async (outcome) => {
    const limited = enforceAuthRateLimit(c, 'pin', undefined, outcome)
    if (limited) return limited
    const parsed = await parseLimitedJson(c, MAX_BODY_BYTES)
    if (parsed.tooLarge) {
      outcome.record('invalid', 'invalid_request')
      return c.json({ error: 'body_too_large' }, 413)
    }
    const body = parsed.body as Record<string, unknown> | null
    const str = (k: string) => (typeof body?.[k] === 'string' ? (body[k] as string).trim() : '')
    const deviceId = str('device_id'), deviceName = str('device_name'), devicePlatform = str('device_platform')
    if (!deviceId || !deviceName || !devicePlatform) {
      outcome.record('invalid', 'invalid_request')
      return c.json({ error: 'missing_device_fields' }, 400)
    }
    const now = Math.floor(Date.now() / 1000)
    sweepExpired(now)
    const code = generateLinkCode()
    serverDb()
      .raw.prepare(
        `INSERT INTO device_link_codes (code, device_id, device_name, device_platform, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(code, deviceId, deviceName, devicePlatform, now, now + LINK_CODE_TTL_SECS)
    outcome.record('authorized', 'device_link')
    return c.json({
      code,
      verify_url: `${spaOrigin(c.req.url)}/#/link/${code}`,
      expires_in: LINK_CODE_TTL_SECS,
      interval: POLL_INTERVAL_SECS,
    })
  }),
)

deviceLink.post('/claim', requireAuth, async (c) => {
  const parsed = await parseLimitedJson(c, MAX_BODY_BYTES)
  if (parsed.tooLarge) return c.json({ error: 'body_too_large' }, 413)
  const code = normalizeCode((parsed.body as Record<string, unknown> | null)?.code)
  if (!CODE_SHAPE.test(code)) return c.json({ error: 'invalid_code' }, 400)
  const now = Math.floor(Date.now() / 1000)
  const row = serverDb().raw.prepare(`SELECT * FROM device_link_codes WHERE code = ?`).get(code) as Row | undefined
  if (!row) return c.json({ error: 'unknown_code' }, 404)
  if (row.expires_at < now) return c.json({ error: 'expired' }, 410)
  if (row.claimed_sub) return c.json({ error: 'already_claimed' }, 409)
  const session = c.get('session')
  serverDb()
    .raw.prepare(
      `UPDATE device_link_codes
         SET claimed_sub = ?, claimed_username = ?, claimed_role = ?, claimed_auth_mode = ?, claimed_at = ?
       WHERE code = ?`,
    )
    .run(session.sub, session.username, session.role, session.auth_mode ?? authModeFromSession(session), now, code)
  return c.json({ ok: true, device_name: row.device_name, device_platform: row.device_platform })
})

deviceLink.post('/poll', (c) =>
  withAuthOutcome(c, 'link', 'check', async (outcome) => {
    const limited = enforceAuthRateLimit(c, 'check', undefined, outcome)
    if (limited) return limited
    const parsed = await parseLimitedJson(c, MAX_BODY_BYTES)
    if (parsed.tooLarge) {
      outcome.record('invalid', 'invalid_request')
      return c.json({ error: 'body_too_large' }, 413)
    }
    const body = parsed.body as Record<string, unknown> | null
    const code = normalizeCode(body?.code)
    const deviceId = typeof body?.device_id === 'string' ? body.device_id.trim() : ''
    if (!CODE_SHAPE.test(code) || !deviceId) {
      outcome.record('invalid', 'invalid_request')
      return c.json({ error: 'invalid_request' }, 400)
    }
    const now = Math.floor(Date.now() / 1000)
    const row = serverDb().raw.prepare(`SELECT * FROM device_link_codes WHERE code = ?`).get(code) as Row | undefined
    // A wrong device_id is treated exactly like an unknown code so the poll
    // endpoint cannot be used to probe which codes exist.
    if (!row || row.device_id !== deviceId || row.consumed_at) {
      outcome.record('invalid', 'invalid_request')
      return c.json({ status: 'denied', reason: 'unknown_code' })
    }
    if (row.expires_at < now) {
      outcome.record('invalid', 'invalid_request')
      return c.json({ status: 'denied', reason: 'expired' })
    }
    if (!row.claimed_sub) return c.json({ status: 'pending' })

    const serverId = ensureServerId()
    const token = await mintDeviceToken({
      sub: row.claimed_sub,
      role: row.claimed_role ?? 'user',
      auth_mode: row.claimed_auth_mode ?? 'plex',
      device_id: row.device_id,
      device_name: row.device_name,
      username: row.claimed_username ?? row.claimed_sub,
      device_platform: row.device_platform,
      server_id: serverId,
    })
    serverDb().raw.prepare(`UPDATE device_link_codes SET consumed_at = ? WHERE code = ?`).run(now, code)
    outcome.record('authorized', 'device_link')
    return c.json({
      status: 'authorized',
      token,
      server_id: serverId,
      user: { sub: row.claimed_sub, username: row.claimed_username ?? row.claimed_sub, role: row.claimed_role ?? 'user' },
    })
  }),
)
