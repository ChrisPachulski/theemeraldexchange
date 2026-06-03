// Plex PIN auth flow.
//
//   GET  /api/auth/plex/config  — public: the X-Plex-Client-Identifier (a
//                                  non-secret app id) + product label the SPA
//                                  needs to create the PIN IN THE BROWSER. The
//                                  PIN is created browser-side so plex.tv
//                                  attributes the sign-in to the visitor's own
//                                  IP — a server-side createPin leaked the
//                                  host's home IP/geo onto Plex's Security
//                                  Alert page to everyone signing in.
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
import { env, isAppleConfigured } from './env.js'
import {
  checkPin,
  getUser,
  listResources,
  signOut as signOutPlex,
  PLEX_PRODUCT,
} from './plex.js'
import {
  setSessionCookie,
  clearSessionCookie,
  readSession,
  authModeFromSession,
  type AuthMode,
} from './session.js'
import {
  _primeSessionGateCache,
  reconcileSession,
  roleFor,
} from './services/sessionGate.js'
import { memberStatus, redeemInvite } from './services/membership.js'
import { addMember } from './services/members.js'
import { verifyAppleIdentityToken } from './services/appleAuth.js'

export const auth = new Hono()

type AuthRateLimitKind = 'pin' | 'check' | 'apple'
type AuthRateLimitBucket = { count: number; resetAt: number }
type AuthRateLimitRule = { key: string; limit: number; windowMs: number }

const AUTH_CLIENT_RATE_LIMITS: Record<AuthRateLimitKind, { limit: number; windowMs: number }> = {
  pin: { limit: 10, windowMs: 60_000 },
  check: { limit: 60, windowMs: 60_000 },
  // SIWA login + invite-redeem. Tighter than `check` (no innocuous
  // polling here — every apple request is a verify + an authZ decision)
  // so a stolen-invite / token-replay flood is blunted on top of the
  // 128-bit invite entropy and the Apple-JWKS signature requirement.
  apple: { limit: 20, windowMs: 60_000 },
}
const AUTH_GLOBAL_RATE_LIMITS: Record<AuthRateLimitKind, { limit: number; windowMs: number }> = {
  pin: { limit: 120, windowMs: 60_000 },
  check: { limit: 600, windowMs: 60_000 },
  apple: { limit: 200, windowMs: 60_000 },
}
const AUTH_CHECK_PIN_RATE_LIMIT = { limit: 90, windowMs: 60_000 }
const AUTH_RATE_LIMIT_MAX_BUCKETS = 256
const AUTH_RATE_LIMIT_SWEEP_MS = 60_000
const AUTH_CHECK_MAX_BODY_BYTES = 1024
// A SIWA identity token is a full RS256 JWT (~1KB+), so the 1KB cap used
// for the Plex pinId body is too small. Allow 8KB for the apple route to
// cover the token + nonce + inviteCode while still bounding the read.
const AUTH_APPLE_MAX_BODY_BYTES = 8192
const authRateLimitBuckets = new Map<string, AuthRateLimitBucket>()
let authRateLimitLastSweep = 0

export function _resetAuthRateLimitsForTests(): void {
  authRateLimitBuckets.clear()
  authRateLimitLastSweep = 0
}

function trustedAuthClientIdentity(c: Context): string | null {
  const cfConnectingIp = c.req.header('cf-connecting-ip')?.trim()
  if (cfConnectingIp) return `cf:${cfConnectingIp}`
  const trueClientIp = c.req.header('true-client-ip')?.trim()
  if (trueClientIp) return `true-client:${trueClientIp}`
  return null
}

function authRateLimitRules(c: Context, kind: AuthRateLimitKind, pinId?: number): AuthRateLimitRule[] {
  const globalCfg = AUTH_GLOBAL_RATE_LIMITS[kind]
  const rules: AuthRateLimitRule[] = [
    { key: `${kind}:global`, limit: globalCfg.limit, windowMs: globalCfg.windowMs },
  ]
  const clientIdentity = trustedAuthClientIdentity(c)
  if (clientIdentity) {
    const clientCfg = AUTH_CLIENT_RATE_LIMITS[kind]
    rules.push({
      key: `${kind}:client:${clientIdentity}`,
      limit: clientCfg.limit,
      windowMs: clientCfg.windowMs,
    })
  }
  if (kind === 'check' && pinId !== undefined) {
    rules.push({
      key: `${kind}:pin:${pinId}`,
      limit: AUTH_CHECK_PIN_RATE_LIMIT.limit,
      windowMs: AUTH_CHECK_PIN_RATE_LIMIT.windowMs,
    })
  }
  return rules
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
    let deleted = false
    for (const key of authRateLimitBuckets.keys()) {
      if (key.endsWith(':global')) continue
      authRateLimitBuckets.delete(key)
      deleted = true
      break
    }
    if (!deleted) break
  }
}

function enforceAuthRateLimit(c: Context, kind: AuthRateLimitKind, pinId?: number): Response | null {
  const now = Date.now()
  sweepAuthRateLimitBuckets(now)
  const rules = authRateLimitRules(c, kind, pinId)
  const buckets = rules.map((rule) => {
    const current = authRateLimitBuckets.get(rule.key)
    const bucket = current && current.resetAt > now ? current : { count: 0, resetAt: now + rule.windowMs }
    return { rule, bucket }
  })
  const limited = buckets.find(({ rule, bucket }) => bucket.count >= rule.limit)
  if (limited) {
    c.header('Retry-After', String(Math.ceil((limited.bucket.resetAt - now) / 1000)))
    authRateLimitBuckets.set(limited.rule.key, limited.bucket)
    return c.json({ error: 'rate_limited' }, 429)
  }
  for (const { rule, bucket } of buckets) {
    bucket.count += 1
    authRateLimitBuckets.set(rule.key, bucket)
  }
  return null
}

function enforceAuthCheckPinRateLimit(c: Context, pinId: number): Response | null {
  const now = Date.now()
  sweepAuthRateLimitBuckets(now)
  const rule: AuthRateLimitRule = {
    key: `check:pin:${pinId}`,
    limit: AUTH_CHECK_PIN_RATE_LIMIT.limit,
    windowMs: AUTH_CHECK_PIN_RATE_LIMIT.windowMs,
  }
  const current = authRateLimitBuckets.get(rule.key)
  const bucket = current && current.resetAt > now ? current : { count: 0, resetAt: now + rule.windowMs }
  if (bucket.count >= rule.limit) {
    c.header('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)))
    authRateLimitBuckets.set(rule.key, bucket)
    return c.json({ error: 'rate_limited' }, 429)
  }
  bucket.count += 1
  authRateLimitBuckets.set(rule.key, bucket)
  return null
}

async function parseLimitedJson(c: Context, maxBytes: number): Promise<{ tooLarge: boolean; body: unknown | null }> {
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

// Shared authZ decision used by BOTH login paths (Plex + Apple) after
// each has independently proven identity. Provider-agnostic: it answers
// "is this verified sub allowed?" by consulting the members allowlist
// and, when present, redeeming an invite to mint a new membership.
//
//   - Existing allowed member → admitted (no invite needed; idempotent
//     re-login).
//   - Not yet a member + a valid unredeemed invite → membership minted,
//     admitted.
//   - Otherwise → denied (caller returns 403 no_invite).
//
// The sub passed here MUST already be the signature/PIN-verified,
// parseSub-validated namespaced form. authZ never trusts a client sub.
//
// authMode spans all three identity providers — 'plex' | 'apple' | 'local'
// (passkey/WebAuthn) — because the allowlist is the single shared authZ gate
// for every login path. Exported so the passkey route reuses the exact same
// admit/redeem decision rather than reimplementing it.
export function authorizeOrRedeem(
  sub: string,
  inviteCode: string | undefined,
  displayName: string | null,
  authMode: AuthMode,
): { allowed: boolean } {
  if (memberStatus(sub) === 'allowed') return { allowed: true }
  if (inviteCode) {
    const r = redeemInvite(inviteCode, sub, displayName, authMode)
    if (r.ok) return { allowed: true }
  }
  return { allowed: false }
}

// Public, auth-free: hands the SPA the non-secret X-Plex-Client-Identifier
// (already embedded in every Plex auth URL) + product label so it can create
// the PIN IN THE BROWSER. The PIN is no longer minted server-side — that made
// plex.tv attribute the request to the host's public IP and leak the owner's
// home location onto Plex's "Security Alert" page for every person signing in.
// The browser creates the PIN with THIS clientId; the backend's checkPin polls
// with the SAME clientId, so the authorized token is still found.
auth.get('/plex/config', (c) =>
  c.json({ clientId: env.plexClientId, product: PLEX_PRODUCT }),
)

// Is this Plex token a member (owner OR shared invitee) of the configured home
// server? Matches the plex.tv resource clientIdentifier against PLEX_SERVER_ID
// — the exact predicate sessionGate.checkMembership uses. Fail CLOSED on a
// probe error: this is a login-time admit gate, so uncertainty must not grant
// access (the user can retry or present an invite). This differs from the
// per-request reconcile, which fails OPEN to avoid mass lockout on a plex.tv
// hiccup once a member row already exists.
async function isOwnerServerMember(authToken: string): Promise<boolean> {
  if (!env.plexServerId) return false
  try {
    const resources = await listResources(authToken)
    return resources.some(
      (r) => r.provides.includes('server') && r.clientIdentifier === env.plexServerId,
    )
  } catch {
    return false
  }
}

auth.post('/plex/check', async (c) => {
  const preLimit = enforceAuthRateLimit(c, 'check')
  if (preLimit) return preLimit
  const parsed = await parseLimitedJson(c, AUTH_CHECK_MAX_BODY_BYTES)
  if (parsed.tooLarge) return c.json({ error: 'body_too_large' }, 413)
  const body = parsed.body as { pinId?: unknown; inviteCode?: unknown } | null
  const pinIdRaw = typeof body?.pinId === 'string' || typeof body?.pinId === 'number' ? String(body.pinId) : undefined
  if (!pinIdRaw) return c.json({ error: 'missing pinId' }, 400)
  const pinId = Number(pinIdRaw)
  if (!Number.isInteger(pinId)) return c.json({ error: 'bad pinId' }, 400)
  const inviteCode = typeof body?.inviteCode === 'string' ? body.inviteCode : undefined
  const limited = enforceAuthCheckPinRateLimit(c, pinId)
  if (limited) return limited

  const pin = await checkPin(pinId)
  if (!pin.authToken) return c.json({ status: 'pending' })

  // authN: prove the Plex identity. This stays exactly as before — the
  // PIN exchange + getUser is who-you-are. authZ is now decoupled: a
  // valid Plex identity alone no longer grants access.
  const user = await getUser(pin.authToken)

  // Namespace-prefix the sub from day one (§8.2 D). New logins always
  // receive a namespaced sub so that M2 device tokens minted from this
  // session carry the prefixed form without needing the grace window.
  const namespacedSub = `plex:${String(user.id)}`

  // Case-insensitive comparison so ADMINS env doesn't have to match the
  // exact Plex casing (which is sometimes uppercase, sometimes lowercase
  // depending on how the account was created). roleFor lives in
  // sessionGate so the per-request reconcile uses the same definition.
  const role = roleFor(user.username, namespacedSub)

  // SHARED authZ gate (identical to /api/auth/apple): the invite/members
  // allowlist — NOT the Plex machineId — decides access. An existing
  // member is admitted; otherwise a valid unredeemed invite in the body
  // mints a membership; otherwise 403. This is the behavior change that
  // makes the app invitation-only by membership rather than by live
  // Plex-server membership, and makes the Plex and Apple paths symmetric.
  let allowed = authorizeOrRedeem(namespacedSub, inviteCode, user.username, 'plex').allowed

  // Plex-server-share auto-admit: a verified Plex identity that is shared on
  // (or owns) the configured home server is admitted automatically and minted
  // onto the members allowlist, so being shared on Plex grants app access
  // without a separate invite. Gated to a brand-new identity
  // (memberStatus === 'not_member'): a 'revoked' member is NOT silently
  // re-admitted by a still-present Plex share — an explicit revoke wins. The
  // minted row makes the per-request reconcile (which keys on the allowlist)
  // see 'allowed' on every subsequent request without re-probing.
  if (!allowed && env.plexServerId && memberStatus(namespacedSub) === 'not_member') {
    if (await isOwnerServerMember(pin.authToken)) {
      addMember({
        sub: namespacedSub,
        displayName: user.username,
        role,
        authMode: 'plex',
        invitedBy: 'plex:server-share',
      })
      allowed = true
    }
  }

  if (!allowed) {
    return c.json({ status: 'denied', reason: 'no_invite' }, 403)
  }

  // Discovery aid only (no longer an authZ gate): when PLEX_SERVER_ID is
  // unset, surface the user's servers so the operator can find the
  // machineIdentifier. Best-effort — a probe failure must not block a
  // row-backed member, so swallow errors.
  let servers: { name: string; id: string; owned: boolean }[] = []
  if (!env.plexServerId) {
    try {
      const resources = await listResources(pin.authToken)
      servers = resources
        .filter((r) => r.provides.includes('server'))
        .map((r) => ({ name: r.name, id: r.clientIdentifier, owned: r.owned }))
    } catch {
      servers = []
    }
  }

  await setSessionCookie(c, {
    sub: namespacedSub,
    username: user.username,
    role,
    auth_mode: 'plex',
    plexAuthToken: pin.authToken,
    ...(env.plexServerId ? { verifiedPlexServerId: env.plexServerId } : {}),
  })

  // Prime the membership cache so the very next protected request
  // doesn't re-hit plex.tv — the membership check we just performed
  // (or the bootstrap "no PLEX_SERVER_ID" path) IS the freshest possible
  // evidence we'll get.
  _primeSessionGateCache(namespacedSub, 'member', pin.authToken)

  return c.json({
    status: 'authorized',
    user: {
      sub: namespacedSub,
      username: user.username,
      email: user.email,
      thumb: user.thumb,
      role,
    },
    // Only present when PLEX_SERVER_ID is unset — discovery aid.
    discoveredServers: servers.length > 0 ? servers : undefined,
  })
})

// POST /api/auth/apple — Sign in with Apple. The parallel of /plex/check:
// it proves identity via the SIWA identity token (verified against
// Apple's JWKS, never trusting a client-sent sub) and then converges on
// the SAME invite/members authZ gate as Plex. POST-only so requireSafeOrigin
// (mounted on '*') gates it — a cross-site GET can't mint a session
// (the /plex/check session-fixation rationale applies verbatim).
auth.post('/apple', async (c) => {
  const preLimit = enforceAuthRateLimit(c, 'apple')
  if (preLimit) return preLimit

  // SIWA must be configured. Fail fast with 503 (server-side gap, not the
  // client's fault) rather than verifying against an empty aud.
  if (!isAppleConfigured()) {
    return c.json({ error: 'apple_not_configured' }, 503)
  }

  const parsed = await parseLimitedJson(c, AUTH_APPLE_MAX_BODY_BYTES)
  if (parsed.tooLarge) return c.json({ error: 'body_too_large' }, 413)
  const body = parsed.body as
    | { identityToken?: unknown; nonce?: unknown; inviteCode?: unknown }
    | null
  const identityToken = typeof body?.identityToken === 'string' ? body.identityToken : undefined
  if (!identityToken) return c.json({ error: 'missing identity_token' }, 400)
  const nonce = typeof body?.nonce === 'string' ? body.nonce : undefined
  const inviteCode = typeof body?.inviteCode === 'string' ? body.inviteCode : undefined

  // authN: verify the Apple identity token. The only sub we ever trust
  // comes from the signature-verified payload (parseSub-validated apple
  // pattern inside the verifier). nonce is compared constant-time when
  // supplied.
  const verified = await verifyAppleIdentityToken(identityToken, { expectedNonce: nonce })
  if (!verified.ok) {
    // jwks_unavailable is OUR problem (transient Apple outage) — surface
    // 503 so a login isn't reported to the user as "your token is bad."
    // Everything else is a client-side auth failure → 401.
    const httpStatus = verified.error === 'jwks_unavailable' ? 503 : 401
    return c.json({ error: 'invalid_identity_token', reason: verified.error }, httpStatus)
  }

  const namespacedSub = verified.sub.raw
  // Apple usernames are unstable/absent; derive a best-effort display
  // name from the email local-part for roleFor + the members row. The
  // sub (apple:<x>) is the stable key; the username is advisory chrome.
  const displayName = verified.email ? verified.email.split('@')[0] : namespacedSub
  // Pass the apple: sub so roleFor refuses to match the attacker-controlled
  // email local-part against ADMINS (Plex usernames). An Apple admin must be
  // listed explicitly in ADMIN_SUBS (by stable sub) instead.
  const role = roleFor(displayName, namespacedSub)

  // SHARED authZ gate (identical to /plex/check).
  const authz = authorizeOrRedeem(namespacedSub, inviteCode, displayName, 'apple')
  if (!authz.allowed) {
    return c.json({ status: 'denied', reason: 'no_invite' }, 403)
  }

  // Mint the session. NO plexAuthToken / verifiedPlexServerId — Apple
  // carries no Plex credential, and reconcileSession skips the plex.tv
  // probe entirely for apple: subs.
  await setSessionCookie(c, {
    sub: namespacedSub,
    username: displayName,
    role,
    auth_mode: 'apple',
  })

  // Prime the membership cache as 'member' so the next protected request
  // skips re-work. No plexAuthToken/serverId fields for apple.
  _primeSessionGateCache(namespacedSub, 'member')

  return c.json({
    status: 'authorized',
    user: {
      sub: namespacedSub,
      username: displayName,
      email: verified.email,
      role,
    },
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
    // sub is the stable provider-namespaced id (plex:/apple:) — used by
    // the SPA to scope per-user localStorage (e.g. the BYO Anthropic API
    // key) so a shared AppleTV signed in as different family members
    // reads the right key for each one. auth_mode lets the SPA render
    // the right chrome ("Signed in with Apple" vs "with Plex") and gate
    // Plex-only admin features; authModeFromSession is the pre-D17
    // fallback for cookies minted before the field existed.
    user: {
      sub: session.sub,
      username: session.username,
      role: session.role,
      auth_mode: session.auth_mode ?? authModeFromSession(session),
    },
  })
})
