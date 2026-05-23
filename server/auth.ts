// Plex PIN auth flow.
//
//   POST /api/auth/plex/pin     — create a Plex PIN, return id + authUrl.
//                                  SPA opens authUrl in a popup.
//   POST /api/auth/plex/check   — poll the PIN. When the user has
//                                  authorized in the popup, plex.tv
//                                  attaches an authToken; we exchange it
//                                  for the user's identity, verify
//                                  server membership (if PLEX_SERVER_ID
//                                  is configured), assign a role, set
//                                  the session cookie, and return the
//                                  authenticated user. POST (not GET)
//                                  so requireSafeOrigin gates it —
//                                  otherwise a hostile page could trigger
//                                  a cross-site GET with an attacker-
//                                  authorized pinId and overwrite the
//                                  victim's session cookie (session
//                                  fixation).
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

auth.post('/plex/check', async (c) => {
  // pinId can come from the query string OR a JSON body. The body
  // path is what the SPA uses now (POST + CSRF-gated); query-string
  // is retained so existing test fixtures keep working.
  const body = await c.req.json().catch(() => null) as { pinId?: unknown } | null
  const pinIdRaw = c.req.query('pinId') ?? (typeof body?.pinId === 'string' || typeof body?.pinId === 'number' ? String(body.pinId) : undefined)
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
    plexAuthToken: pin.authToken,
  })

  return c.json({
    status: 'authorized',
    user: {
      sub: String(user.id),
      username: user.username,
      email: user.email,
      thumb: user.thumb,
      role,
    },
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
    // sub is the stable Plex user id — used by the SPA to scope
    // per-user localStorage (e.g. the BYO Anthropic API key) so a
    // shared AppleTV signed in as different family members reads the
    // right key for each one.
    user: { sub: session.sub, username: session.username, role: session.role },
  })
})
