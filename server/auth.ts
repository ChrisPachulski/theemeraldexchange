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
import { createHash } from 'node:crypto'
import { env, isPlexConfigured, isAppleConfigured, isGoogleConfigured } from './env.js'
import {
  checkPin,
  getUser,
  listResources,
  signOut as signOutPlex,
  PLEX_PRODUCT,
  PlexRateLimitError,
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
import { verifyGoogleIdentityToken } from './services/googleAuth.js'
import { maybeMintDeviceToken } from './services/devicePair.js'
import { createLogger } from './services/logger.js'

export const auth = new Hono()
const authLog = createLogger('auth')

type AuthRateLimitKind = 'pin' | 'check' | 'apple' | 'passkey' | 'google'
type AuthRateLimitScope = 'global' | 'trusted_client' | 'pin' | 'identity'
type AuthRateLimitBucket = { count: number; resetAt: number }
type AuthRateLimitRule = {
  key: string
  scope: AuthRateLimitScope
  limit: number
  windowMs: number
}

const AUTH_CLIENT_RATE_LIMITS: Record<AuthRateLimitKind, { limit: number; windowMs: number }> = {
  pin: { limit: 10, windowMs: 60_000 },
  check: { limit: 300, windowMs: 60_000 },
  // SIWA login + invite-redeem. Tighter than `check` (no innocuous
  // polling here — every apple request is a verify + an authZ decision)
  // so a stolen-invite / token-replay flood is blunted on top of the
  // 128-bit invite entropy and the Apple-JWKS signature requirement.
  apple: { limit: 20, windowMs: 60_000 },
  // WebAuthn login + registration. Every passkey request is either a
  // challenge mint or a crypto verify + DB write (register also redeems an
  // invite) — no innocuous polling — so it gets the same tight bucket as
  // apple. Blunts credential-stuffing against /login/verify and challenge-
  // table burn against /register/options.
  passkey: { limit: 20, windowMs: 60_000 },
  // Google Sign-In: same posture as apple — every request is a JWKS verify
  // + authZ decision, no innocuous polling.
  google: { limit: 20, windowMs: 60_000 },
}
const AUTH_GLOBAL_RATE_LIMITS: Record<AuthRateLimitKind, { limit: number; windowMs: number }> = {
  pin: { limit: 120, windowMs: 60_000 },
  check: { limit: 600, windowMs: 60_000 },
  apple: { limit: 200, windowMs: 60_000 },
  passkey: { limit: 200, windowMs: 60_000 },
  google: { limit: 200, windowMs: 60_000 },
}
const AUTH_CHECK_PIN_RATE_LIMIT = { limit: 60, windowMs: 60_000 }
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
  if (!env.trustClientIpHeaders) return null
  const cfConnectingIp = c.req.header('cf-connecting-ip')?.trim()
  if (cfConnectingIp) return `cf:${cfConnectingIp}`
  const trueClientIp = c.req.header('true-client-ip')?.trim()
  if (trueClientIp) return `true-client:${trueClientIp}`
  return null
}

function authRateLimitRules(c: Context, kind: AuthRateLimitKind, pinId?: number): AuthRateLimitRule[] {
  const globalCfg = AUTH_GLOBAL_RATE_LIMITS[kind]
  const rules: AuthRateLimitRule[] = [
    {
      key: `${kind}:global`,
      scope: 'global',
      limit: globalCfg.limit,
      windowMs: globalCfg.windowMs,
    },
  ]
  const clientIdentity = trustedAuthClientIdentity(c)
  if (clientIdentity) {
    const clientCfg = AUTH_CLIENT_RATE_LIMITS[kind]
    rules.push({
      key: `${kind}:client:${clientIdentity}`,
      scope: 'trusted_client',
      limit: clientCfg.limit,
      windowMs: clientCfg.windowMs,
    })
  }
  if (kind === 'check' && pinId !== undefined) {
    rules.push({
      key: `${kind}:pin:${pinId}`,
      scope: 'pin',
      limit: AUTH_CHECK_PIN_RATE_LIMIT.limit,
      windowMs: AUTH_CHECK_PIN_RATE_LIMIT.windowMs,
    })
  }
  return rules
}

function sweepAuthRateLimitBuckets(now: number): void {
  if (now - authRateLimitLastSweep < AUTH_RATE_LIMIT_SWEEP_MS) return
  authRateLimitLastSweep = now
  for (const [key, bucket] of authRateLimitBuckets) {
    if (bucket.resetAt <= now) authRateLimitBuckets.delete(key)
  }
}

function rejectAuthRateLimit(
  c: Context,
  operation: AuthRateLimitKind,
  scope: AuthRateLimitScope,
  resetAt: number,
  now: number,
): Response {
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000))
  c.header('Retry-After', String(retryAfterSeconds))
  authLog.warn('rate limit rejected', {
    operation,
    scope,
    requestId: c.get('requestId') ?? c.req.header('x-request-id') ?? 'unavailable',
    retryAfterSeconds,
  })
  return c.json({ error: 'rate_limited' }, 429)
}

export function enforceAuthRateLimit(
  c: Context,
  kind: AuthRateLimitKind,
  pinId?: number,
): Response | null {
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
    authRateLimitBuckets.set(limited.rule.key, limited.bucket)
    return rejectAuthRateLimit(c, kind, limited.rule.scope, limited.bucket.resetAt, now)
  }
  for (const { rule, bucket } of buckets) {
    bucket.count += 1
    authRateLimitBuckets.set(rule.key, bucket)
  }
  return null
}

function enforceSingleBucketRule(
  c: Context,
  kind: AuthRateLimitKind,
  rule: AuthRateLimitRule,
): Response | null {
  const now = Date.now()
  sweepAuthRateLimitBuckets(now)
  const current = authRateLimitBuckets.get(rule.key)
  const bucket = current && current.resetAt > now ? current : { count: 0, resetAt: now + rule.windowMs }
  if (bucket.count >= rule.limit) {
    authRateLimitBuckets.set(rule.key, bucket)
    return rejectAuthRateLimit(c, kind, rule.scope, bucket.resetAt, now)
  }
  bucket.count += 1
  authRateLimitBuckets.set(rule.key, bucket)
  return null
}

/**
 * Identity-keyed rate-limit bucket, applied REGARDLESS of client-IP trust.
 *
 * The per-client buckets above only exist when TRUST_CLIENT_IP_HEADERS=1
 * (off by default — behind the Cloudflare tunnel the operator must opt in),
 * which left only the coarse global buckets biting on the default deploy.
 * These buckets key on the ATTEMPTED identity instead (pinId / SIWA sub /
 * passkey credential id / registration handle), so a stuffing or replay run
 * against one credential is throttled at the per-client rate no matter which
 * IP it arrives from or whether IP headers are trusted.
 *
 * The identity is attacker-supplied, so this is rate-limit keying ONLY —
 * never an authN/authZ signal. An attacker who randomises identities per
 * request merely splits their own traffic across buckets and is still capped
 * by the global bucket; an attacker hammering ONE account cannot escape its
 * bucket. Identities are SHA-256-hashed into the key so raw credential
 * material never sits in the bucket map.
 */
export function enforceAuthIdentityRateLimit(
  c: Context,
  kind: AuthRateLimitKind,
  identity: string | null | undefined,
): Response | null {
  if (!identity) return null
  const cfg = AUTH_CLIENT_RATE_LIMITS[kind]
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 16)
  return enforceSingleBucketRule(c, kind, {
    key: `${kind}:identity:${digest}`,
    scope: 'identity',
    limit: cfg.limit,
    windowMs: cfg.windowMs,
  })
}

/** UNVERIFIED `sub` claim of a compact JWT — for rate-limit keying only.
 *  (Signature verification happens later in the handler; see the
 *  enforceAuthIdentityRateLimit doc for why unverified is fine here.) */
export function unverifiedJwtSub(token: string): string | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      sub?: unknown
    }
    return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null
  } catch {
    return null
  }
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
// authMode spans every identity provider — 'plex' | 'apple' | 'local'
// (passkey/WebAuthn) | 'google' — because the allowlist is the single shared
// authZ gate for every login path. Exported so the passkey/apple/google
// routes reuse the exact same admit/redeem decision rather than
// reimplementing it.
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
auth.get('/plex/config', (c) => {
  // Plex login is optional (plan 006 Phase 0) — typed 503 mirrors the
  // apple/google fail-fast pattern so clients hide the Plex button.
  if (!env.plexClientId) return c.json({ error: 'plex_not_configured' }, 503)
  return c.json({ clientId: env.plexClientId, product: PLEX_PRODUCT })
})

// Public, auth-free: which login methods this install offers, so the native
// app (and SPA) render only the providers that are actually configured. plex
// is config-gated on PLEX_CLIENT_ID (optional since plan 006 Phase 0);
// apple/google are client-id gated (their ENABLE_* values are deployment
// fail-fast assertions); passkeys are always mounted (WebAuthn has dev defaults).
// The app reads this on the unpaired screen to build the provider button list.
auth.get('/methods', (c) =>
  c.json({
    plex: isPlexConfigured(),
    apple: isAppleConfigured(),
    google: isGoogleConfigured(),
    passkey: true,
  }),
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
  const parsed = await parseLimitedJson(c, AUTH_CHECK_MAX_BODY_BYTES)
  const body = parsed.body as { pinId?: unknown; inviteCode?: unknown } | null
  const pinIdRaw = typeof body?.pinId === 'string' || typeof body?.pinId === 'number' ? String(body.pinId) : undefined
  const pinIdCandidate = pinIdRaw ? Number(pinIdRaw) : NaN
  const pinId = Number.isInteger(pinIdCandidate) ? pinIdCandidate : undefined
  const limited = enforceAuthRateLimit(c, 'check', pinId)
  if (limited) return limited
  if (parsed.tooLarge) return c.json({ error: 'body_too_large' }, 413)
  if (!pinIdRaw) return c.json({ error: 'missing pinId' }, 400)
  if (pinId === undefined) return c.json({ error: 'bad pinId' }, 400)
  const inviteCode = typeof body?.inviteCode === 'string' ? body.inviteCode : undefined

  let pin: Awaited<ReturnType<typeof checkPin>>
  try {
    pin = await checkPin(pinId)
  } catch (error) {
    if (!(error instanceof PlexRateLimitError)) throw error
    c.header('Retry-After', error.retryAfter)
    return c.json({ error: 'plex_rate_limited' }, 429)
  }
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
  // Identity-keyed bucket on the (unverified) SIWA sub: throttles a replay /
  // stuffing run against one Apple account even on deploys where client-IP
  // headers are untrusted and the per-client buckets never engage.
  const identityLimited = enforceAuthIdentityRateLimit(c, 'apple', unverifiedJwtSub(identityToken))
  if (identityLimited) return identityLimited
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

  // Native app pairing: when the body carries the device-pair triple, mint a
  // device-token Bearer JWE (same wire shape as routes/device.ts) instead of
  // a browser session cookie. Returns null for browser sign-ins, which fall
  // through to the cookie path below.
  const deviceResponse = await maybeMintDeviceToken(c, body, {
    sub: namespacedSub,
    role,
    auth_mode: 'apple',
    username: displayName,
  })
  if (deviceResponse) return deviceResponse

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

// POST /api/auth/google — Google Sign-In. The Google parallel of
// /api/auth/apple: prove identity via the Google ID token (verified against
// Google's JWKS, never trusting a client-sent sub) and converge on the SAME
// invite/members authZ gate. Device-pair body → device-token Bearer JWE;
// browser body → session cookie. POST-only so requireSafeOrigin gates it.
auth.post('/google', async (c) => {
  const preLimit = enforceAuthRateLimit(c, 'google')
  if (preLimit) return preLimit

  if (!isGoogleConfigured()) {
    return c.json({ error: 'google_not_configured' }, 503)
  }

  const parsed = await parseLimitedJson(c, AUTH_APPLE_MAX_BODY_BYTES)
  if (parsed.tooLarge) return c.json({ error: 'body_too_large' }, 413)
  const body = parsed.body as
    | { identityToken?: unknown; nonce?: unknown; inviteCode?: unknown }
    | null
  // Accept identityToken (parity with the apple route) or idToken (Google's
  // own claim name) — clients in the wild send either.
  const identityToken =
    typeof body?.identityToken === 'string'
      ? body.identityToken
      : typeof (body as { idToken?: unknown })?.idToken === 'string'
        ? (body as { idToken: string }).idToken
        : undefined
  if (!identityToken) return c.json({ error: 'missing identity_token' }, 400)
  // Identity-keyed bucket on the (unverified) Google sub: throttles a replay
  // run against one Google account even where client-IP headers are untrusted.
  const identityLimited = enforceAuthIdentityRateLimit(c, 'google', unverifiedJwtSub(identityToken))
  if (identityLimited) return identityLimited
  const nonce = typeof body?.nonce === 'string' ? body.nonce : undefined
  const inviteCode = typeof body?.inviteCode === 'string' ? body.inviteCode : undefined

  // authN: verify the Google identity token. The only sub we trust comes
  // from the signature-verified payload (parseSub-validated google pattern).
  const verified = await verifyGoogleIdentityToken(identityToken, { expectedNonce: nonce })
  if (!verified.ok) {
    // jwks_unavailable is OUR problem (transient Google outage) → 503 so a
    // login isn't reported to the user as "your token is bad." Else 401.
    const httpStatus = verified.error === 'jwks_unavailable' ? 503 : 401
    return c.json({ error: 'invalid_identity_token', reason: verified.error }, httpStatus)
  }

  const namespacedSub = verified.sub.raw
  // Prefer Google's `name`, then the email local-part, then the sub. The sub
  // is the stable key; the username is advisory chrome for the members row.
  const displayName =
    verified.name ?? (verified.email ? verified.email.split('@')[0] : namespacedSub)
  // roleFor refuses to match a google: sub's id against ADMINS (Plex
  // usernames); a Google admin must be listed by stable sub in ADMIN_SUBS.
  const role = roleFor(displayName, namespacedSub)

  // SHARED authZ gate (identical to /plex/check and /apple).
  const authz = authorizeOrRedeem(namespacedSub, inviteCode, displayName, 'google')
  if (!authz.allowed) {
    return c.json({ status: 'denied', reason: 'no_invite' }, 403)
  }

  // Native app pairing: device-pair triple → device-token Bearer JWE instead
  // of a browser session cookie. Returns null for browser sign-ins.
  const deviceResponse = await maybeMintDeviceToken(c, body, {
    sub: namespacedSub,
    role,
    auth_mode: 'google',
    username: displayName,
  })
  if (deviceResponse) return deviceResponse

  // Mint the session. NO plexAuthToken — Google carries no Plex credential,
  // and reconcileSession skips the plex.tv probe for google: subs.
  await setSessionCookie(c, {
    sub: namespacedSub,
    username: displayName,
    role,
    auth_mode: 'google',
  })

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
