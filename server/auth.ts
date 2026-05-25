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

import { Hono, type Context } from 'hono'
import { env } from './env.js'
import {
  createPin,
  checkPin,
  getUser,
  listResources,
  buildAuthUrl,
  signOut as signOutPlex,
} from './plex.js'
import {
  setSessionCookie,
  clearSessionCookie,
  readSession,
} from './session.js'
import {
  _primeSessionGateCache,
  reconcileSession,
  roleFor,
} from './services/sessionGate.js'

export const auth = new Hono()

type AuthRateLimitKind = 'pin' | 'check'
type AuthRateLimitBucket = { count: number; resetAt: number }

const AUTH_RATE_LIMITS: Record<AuthRateLimitKind, { limit: number; windowMs: number }> = {
  pin: { limit: 10, windowMs: 60_000 },
  check: { limit: 60, windowMs: 60_000 },
}
const AUTH_RATE_LIMIT_MAX_BUCKETS = 256
const AUTH_RATE_LIMIT_SWEEP_MS = 60_000
const authRateLimitBuckets = new Map<string, AuthRateLimitBucket>()
let authRateLimitLastSweep = 0

export function _resetAuthRateLimitsForTests(): void {
  authRateLimitBuckets.clear()
  authRateLimitLastSweep = 0
}

function authClientKey(c: Context, kind: AuthRateLimitKind): string {
  void c
  return `${kind}:global`
}

function sweepAuthRateLimitBuckets(now: number): void {
  if (
    authRateLimitBuckets.size <= AUTH_RATE_LIMIT_MAX_BUCKETS &&
    now - authRateLimitLastSweep < AUTH_RATE_LIMIT_SWEEP_MS
  ) {
    return
  }
  authRateLimitLastSweep = now
  for (const [key, bucket] of authRateLimitBuckets) {
    if (bucket.resetAt <= now) authRateLimitBuckets.delete(key)
  }
  while (authRateLimitBuckets.size > AUTH_RATE_LIMIT_MAX_BUCKETS) {
    const oldest = authRateLimitBuckets.keys().next().value
    if (oldest === undefined) break
    authRateLimitBuckets.delete(oldest)
  }
}

function enforceAuthRateLimit(c: Context, kind: AuthRateLimitKind): Response | null {
  const cfg = AUTH_RATE_LIMITS[kind]
  const now = Date.now()
  sweepAuthRateLimitBuckets(now)
  const key = authClientKey(c, kind)
  const current = authRateLimitBuckets.get(key)
  const bucket = current && current.resetAt > now ? current : { count: 0, resetAt: now + cfg.windowMs }
  if (bucket.count >= cfg.limit) {
    c.header('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)))
    authRateLimitBuckets.set(key, bucket)
    return c.json({ error: 'rate_limited' }, 429)
  }
  bucket.count += 1
  authRateLimitBuckets.set(key, bucket)
  return null
}

auth.post('/plex/pin', async (c) => {
  const limited = enforceAuthRateLimit(c, 'pin')
  if (limited) return limited
  const pin = await createPin()
  return c.json({
    pinId: pin.id,
    code: pin.code,
    authUrl: buildAuthUrl(pin.code),
  })
})

auth.post('/plex/check', async (c) => {
  const limited = enforceAuthRateLimit(c, 'check')
  if (limited) return limited
  const body = await c.req.json().catch(() => null) as { pinId?: unknown } | null
  const pinIdRaw = typeof body?.pinId === 'string' || typeof body?.pinId === 'number' ? String(body.pinId) : undefined
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
  // depending on how the account was created). roleFor lives in
  // sessionGate so the per-request reconcile uses the same definition.
  const role = roleFor(user.username)

  await setSessionCookie(c, {
    sub: String(user.id),
    username: user.username,
    role,
    plexAuthToken: pin.authToken,
  })

  // Prime the membership cache so the very next protected request
  // doesn't re-hit plex.tv — the membership check we just performed
  // (or the bootstrap "no PLEX_SERVER_ID" path) IS the freshest possible
  // evidence we'll get.
  _primeSessionGateCache(String(user.id), 'member')

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
  const session = await readSession(c)
  if (session?.plexAuthToken) {
    try {
      await signOutPlex(session.plexAuthToken)
    } catch (err) {
      console.warn('[auth.logout] plex signout failed:', err instanceof Error ? err.message : String(err))
    }
  }
  clearSessionCookie(c)
  return c.json({ ok: true })
})

export const me = new Hono()

me.get('/', async (c) => {
  // /api/me drives the SPA's "am I signed in / am I admin?" view, so
  // it MUST reflect the same reconciled state every protected route
  // already enforces. Reading the raw cookie here would leave the SPA
  // showing a revoked user as still signed in (and a demoted admin
  // still wearing the admin chrome) until they tried a protected
  // action and got 401'd. Run the same reconcile + cookie-clear
  // pipeline as requireAuth.
  const decoded = await readSession(c)
  if (!decoded) return c.json({ error: 'unauthenticated' }, 401)
  const session = await reconcileSession(decoded)
  if (!session) {
    clearSessionCookie(c)
    return c.json({ error: 'unauthenticated', reason: 'access_revoked' }, 401)
  }
  return c.json({
    // sub is the stable Plex user id — used by the SPA to scope
    // per-user localStorage (e.g. the BYO Anthropic API key) so a
    // shared AppleTV signed in as different family members reads the
    // right key for each one.
    user: { sub: session.sub, username: session.username, role: session.role },
  })
})
