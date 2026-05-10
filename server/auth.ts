// Plex PIN auth flow.
//
//   POST /api/auth/plex/pin     — create a Plex PIN, return id + authUrl.
//                                  SPA opens authUrl in a popup.
//   GET  /api/auth/plex/check   — poll the PIN. When the user has
//                                  authorized in the popup, plex.tv
//                                  attaches an authToken; we exchange it
//                                  for the user's identity, verify
//                                  server membership (if PLEX_SERVER_ID
//                                  is configured), assign a role, set
//                                  the session cookie, and return the
//                                  authenticated user.
//   POST /api/auth/logout       — clear the session cookie.
//   GET  /api/me                — current user, or 401.

import { Hono } from 'hono'
import { env } from './env.js'
import {
  createPin,
  checkPin,
  getUser,
  listResources,
  buildAuthUrl,
} from './plex.js'
import {
  setSessionCookie,
  clearSessionCookie,
  readSession,
} from './session.js'
import type { Role } from './session.js'

export const auth = new Hono()

auth.post('/plex/pin', async (c) => {
  const pin = await createPin()
  return c.json({
    pinId: pin.id,
    code: pin.code,
    authUrl: buildAuthUrl(pin.code),
  })
})

auth.get('/plex/check', async (c) => {
  const pinIdRaw = c.req.query('pinId')
  if (!pinIdRaw) return c.json({ error: 'missing pinId' }, 400)
  const pinId = Number(pinIdRaw)
  if (!Number.isInteger(pinId)) return c.json({ error: 'bad pinId' }, 400)

  const pin = await checkPin(pinId)
  if (!pin.authToken) return c.json({ status: 'pending' })

  const user = await getUser(pin.authToken)

  // Server-membership gate. When PLEX_SERVER_ID is unset, we accept any
  // authenticated Plex user — first-run-friendly so you can discover
  // your own server's machineIdentifier via /api/me, then lock it down.
  let servers: { name: string; id: string; owned: boolean }[] = []
  if (env.plexServerId) {
    const resources = await listResources(pin.authToken)
    const isMember = resources.some(
      (r) => r.provides.includes('server') && r.clientIdentifier === env.plexServerId,
    )
    if (!isMember) {
      return c.json(
        { status: 'denied', reason: 'not_a_server_member' },
        403,
      )
    }
  } else {
    // No gate yet — surface the user's servers so the operator can
    // discover the machineIdentifier to configure.
    const resources = await listResources(pin.authToken)
    servers = resources
      .filter((r) => r.provides.includes('server'))
      .map((r) => ({ name: r.name, id: r.clientIdentifier, owned: r.owned }))
  }

  // Case-insensitive comparison so ADMINS env doesn't have to match the
  // exact Plex casing (which is sometimes uppercase, sometimes lowercase
  // depending on how the account was created).
  const usernameLower = user.username.toLowerCase()
  const role: Role = env.admins.some((a) => a.toLowerCase() === usernameLower)
    ? 'admin'
    : 'user'

  await setSessionCookie(c, {
    sub: String(user.id),
    username: user.username,
    role,
  })

  return c.json({
    status: 'authorized',
    user: { username: user.username, email: user.email, thumb: user.thumb, role },
    // Only present when PLEX_SERVER_ID is unset — discovery aid.
    discoveredServers: servers.length > 0 ? servers : undefined,
  })
})

auth.post('/logout', async (c) => {
  clearSessionCookie(c)
  return c.json({ ok: true })
})

export const me = new Hono()

me.get('/', async (c) => {
  const session = await readSession(c)
  if (!session) return c.json({ error: 'unauthenticated' }, 401)
  return c.json({
    user: { username: session.username, role: session.role },
  })
})
