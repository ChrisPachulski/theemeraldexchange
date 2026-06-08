// /api/devices/* — paired-device management for both self and admin.
//
// Self routes (requireAuth, scoped to session.sub):
//   GET    /self              — list this user's paired devices
//   DELETE /self/:jti         — revoke one of MY devices
//   DELETE /self              — revoke ALL of my devices (logout everywhere)
//   PATCH  /self/:jti/name    — rename one of MY devices
//
// Admin routes (requireAdmin, no sub scoping):
//   GET    /admin             — list every paired device across all users
//   DELETE /admin/:jti        — revoke any device
//   PATCH  /admin/:jti/name   — rename any device
//
// All revocations are idempotent (INSERT OR IGNORE in
// device_token_revocations). A device whose jti appears in revocations
// fails verifyDeviceToken on its next request and the app falls back to
// the PIN re-pair flow. The device_tokens row itself stays — we keep the
// audit trail and `last_seen_*` for forensics.

import { Hono } from 'hono'
import { requireAuth, requireAdmin, type Env } from '../middleware/auth.js'
import { serverDb } from '../services/serverDb.js'
import { revokeDeviceToken } from '../session.js'

export const devices = new Hono<Env>()

// ---------------------------------------------------------------------------
// Shared row shape — the public-API view of a device. Excludes raw kid
// (implementation detail) and revocation rows (rejoined via LEFT JOIN
// for the revoked flag).
// ---------------------------------------------------------------------------

type DeviceRow = {
  jti: string
  sub: string
  device_id: string
  device_name: string
  platform: string
  server_id: string
  issued_at: string
  expires_at: string
  last_seen_at: string | null
  last_seen_version: string | null
  revoked_at: string | null
  revoked_reason: string | null
}

type DeviceView = {
  jti: string
  device_id: string
  device_name: string
  platform: string
  server_id: string
  issued_at: string
  expires_at: string
  last_seen_at: string | null
  last_seen_version: string | null
  revoked: boolean
  revoked_at: string | null
  revoked_reason: string | null
  /** True for the device whose jti matches the caller's current Bearer
   *  token (when authenticated via Bearer). Lets the SPA highlight "this
   *  device" and warn before self-revoke. Always false for cookie-auth
   *  callers since they don't carry a jti. */
  is_current?: boolean
}

function toView(row: DeviceRow, currentJti?: string): DeviceView {
  return {
    jti: row.jti,
    device_id: row.device_id,
    device_name: row.device_name,
    platform: row.platform,
    server_id: row.server_id,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    last_seen_at: row.last_seen_at,
    last_seen_version: row.last_seen_version,
    revoked: row.revoked_at != null,
    revoked_at: row.revoked_at,
    revoked_reason: row.revoked_reason,
    ...(currentJti && row.jti === currentJti ? { is_current: true } : {}),
  }
}

// Reuses LEFT JOIN so a single query yields both active + revoked devices
// with the same row shape. Admin tooling needs to see revoked rows; self
// tooling currently surfaces only active but the SPA may want a "recently
// revoked" section later — keep the data path uniform.
const SELECT_DEVICES = `
  SELECT d.jti, d.sub, d.device_id, d.device_name, d.platform, d.server_id,
         d.issued_at, d.expires_at, d.last_seen_at, d.last_seen_version,
         r.revoked_at, r.reason AS revoked_reason
    FROM device_tokens d
    LEFT JOIN device_token_revocations r ON d.jti = r.jti
`

// ---------------------------------------------------------------------------
// Self routes
// ---------------------------------------------------------------------------

devices.use('/self', requireAuth)
devices.use('/self/*', requireAuth)

devices.get('/self', (c) => {
  const session = c.get('session')
  const currentJti = c.get('deviceClaims')?.jti
  const rows = serverDb()
    .raw.prepare(
      `${SELECT_DEVICES}
       WHERE d.sub = ? AND r.jti IS NULL
       ORDER BY datetime(COALESCE(d.last_seen_at, d.issued_at)) DESC`,
    )
    .all(session.sub) as DeviceRow[]
  return c.json({ devices: rows.map((r) => toView(r, currentJti)) })
})

devices.delete('/self/:jti', (c) => {
  const session = c.get('session')
  const jti = c.req.param('jti')
  // Ownership check: only revoke if the row belongs to this caller's sub.
  const row = serverDb()
    .raw.prepare(`SELECT jti FROM device_tokens WHERE jti = ? AND sub = ?`)
    .get(jti, session.sub) as { jti: string } | undefined
  if (!row) return c.json({ error: 'not_found' }, 404)
  revokeDeviceToken(jti, 'self_revoke')
  return c.json({ ok: true, revoked: jti })
})

devices.delete('/self', (c) => {
  // Logout everywhere — revoke every non-revoked device for this sub.
  const session = c.get('session')
  const db = serverDb().raw
  const rows = db
    .prepare(
      `SELECT d.jti FROM device_tokens d
         LEFT JOIN device_token_revocations r ON d.jti = r.jti
        WHERE d.sub = ? AND r.jti IS NULL`,
    )
    .all(session.sub) as Array<{ jti: string }>
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO device_token_revocations (jti, revoked_at, reason)
     VALUES (?, datetime('now'), 'self_logout_everywhere')`,
  )
  const tx = db.transaction((items: typeof rows) => {
    for (const r of items) stmt.run(r.jti)
  })
  tx(rows)
  return c.json({ ok: true, revoked_count: rows.length })
})

devices.patch('/self/:jti/name', async (c) => {
  const session = c.get('session')
  const jti = c.req.param('jti')
  const body = (await c.req.json().catch(() => null)) as { device_name?: unknown } | null
  if (!body || typeof body.device_name !== 'string') {
    return c.json({ error: 'invalid_body', message: 'device_name (string) required' }, 400)
  }
  const name = body.device_name.trim()
  if (name.length === 0 || name.length > 128) {
    return c.json({ error: 'invalid_body', message: 'device_name must be 1-128 chars' }, 400)
  }
  // Ownership-scoped UPDATE — affects nothing if the row isn't this caller's.
  const info = serverDb()
    .raw.prepare(`UPDATE device_tokens SET device_name = ? WHERE jti = ? AND sub = ?`)
    .run(name, jti, session.sub)
  if (info.changes === 0) return c.json({ error: 'not_found' }, 404)
  return c.json({ ok: true, device_name: name })
})

// ---------------------------------------------------------------------------
// Admin routes (mounted under /api/admin/devices by the app router)
// ---------------------------------------------------------------------------

export const adminDevices = new Hono<Env>()

adminDevices.use('*', requireAdmin)

adminDevices.get('/', (c) => {
  const rows = serverDb()
    .raw.prepare(
      `${SELECT_DEVICES}
       ORDER BY datetime(COALESCE(d.last_seen_at, d.issued_at)) DESC`,
    )
    .all() as DeviceRow[]
  // Admin view INCLUDES sub so the SPA can group/filter by user.
  return c.json({
    devices: rows.map((r) => ({ ...toView(r), sub: r.sub })),
  })
})

adminDevices.delete('/:jti', (c) => {
  const jti = c.req.param('jti')
  const row = serverDb()
    .raw.prepare(`SELECT jti FROM device_tokens WHERE jti = ?`)
    .get(jti) as { jti: string } | undefined
  if (!row) return c.json({ error: 'not_found' }, 404)
  revokeDeviceToken(jti, 'admin_revoke')
  return c.json({ ok: true, revoked: jti })
})

adminDevices.patch('/:jti/name', async (c) => {
  const jti = c.req.param('jti')
  const body = (await c.req.json().catch(() => null)) as { device_name?: unknown } | null
  if (!body || typeof body.device_name !== 'string') {
    return c.json({ error: 'invalid_body', message: 'device_name (string) required' }, 400)
  }
  const name = body.device_name.trim()
  if (name.length === 0 || name.length > 128) {
    return c.json({ error: 'invalid_body', message: 'device_name must be 1-128 chars' }, 400)
  }
  const info = serverDb()
    .raw.prepare(`UPDATE device_tokens SET device_name = ? WHERE jti = ?`)
    .run(name, jti)
  if (info.changes === 0) return c.json({ error: 'not_found' }, 404)
  return c.json({ ok: true, device_name: name })
})
