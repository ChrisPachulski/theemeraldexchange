// server/routes/passkey.ts — passkey (WebAuthn) login + registration surface.
//
// Mounted PUBLIC at /api/auth/passkey (these endpoints ARE the login, so they
// carry no requireAuth middleware). Four endpoints, two ceremonies:
//
//   POST /register/options  { handle }                       -> { options, challengeId }
//   POST /register/verify   { challengeId, response,         -> { ok, user } | 403
//                             inviteCode, deviceLabel? }
//   POST /login/options     {}                               -> { options, challengeId }
//   POST /login/verify      { challengeId, response }        -> { ok, user } | 403
//
// Identity model: a passkey user is a self-owned `local:<ulid>` sub. AuthN is
// the WebAuthn signature; authZ is the shared invite/members allowlist —
// registration runs authorizeOrRedeem (same gate as Plex/Apple) BETWEEN
// verifying the attestation and persisting the credential, so a bad invite
// leaves no orphan credential. Login re-checks membership so a revoked passkey
// user is denied even though their signature is valid.

import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Env } from '../middleware/auth.js'
import {
  beginRegistration,
  verifyRegistration,
  persistCredential,
  beginLogin,
  verifyLogin,
  type RpOverride,
} from '../services/webauthn.js'
import { env } from '../env.js'
import {
  authorizeOrRedeem,
  enforceAuthRateLimit,
  enforceAuthIdentityRateLimit,
} from '../auth.js'
import { addMember, isMember, recordMemberLogin } from '../services/members.js'
import { setSessionCookie } from '../session.js'
import { maybeMintDeviceToken } from '../services/devicePair.js'
import {
  isClaimable,
  verifySetupToken,
  markClaimed,
  claimSourceAllowed,
} from '../services/setupState.js'
import { serverDb } from '../services/serverDb.js'
import { getConnInfo } from '@hono/node-server/conninfo'
import { resolveClientAddress } from '../services/clientAddress.js'

export const passkey = new Hono<Env>()

const MAX_HANDLE = 64
const MAX_LABEL = 64

/** Coerce/validate a user-supplied display handle. */
function cleanHandle(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const h = v.trim()
  if (h.length < 1 || h.length > MAX_HANDLE) return null
  return h
}

/** WebAuthn credential id from a ceremony response body — rate-limit keying
 *  only (the signature is verified later in the handler). The id is the
 *  client-asserted base64url credential id; hammering one credential lands
 *  in one identity bucket regardless of source IP / IP-header trust. */
function credentialIdOf(response: unknown): string | null {
  if (typeof response !== 'object' || response === null) return null
  const id = (response as { id?: unknown }).id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/** Request-derived WebAuthn Relying Party (plan 006 Phase 2).
 *
 *  Only when (a) the backend serves the SPA same-origin (SERVE_SPA) and
 *  (b) the operator did NOT pin WEBAUTHN_RP_ID. Then the RP is the
 *  request's own Origin — but ONLY if its host equals the Host header
 *  (same-host guard), so a cross-origin page can never steer the RP.
 *  Phishing resistance is intact: the browser enforces that the rpId is a
 *  registrable suffix of the page's own host, and here both derive from
 *  the same request. Falls back to the env-configured RP everywhere else. */
function rpForRequest(c: Context): RpOverride | undefined {
  if (env.webauthnRpIdExplicit || !env.serveSpa) return undefined
  const origin = c.req.header('origin')
  const host = c.req.header('host')
  if (!origin || !host) return undefined
  try {
    const u = new URL(origin)
    if (u.host !== host) return undefined
    return { rpId: u.hostname, origin }
  } catch {
    return undefined
  }
}

// ── registration ────────────────────────────────────────────────────────────

passkey.post('/register/options', async (c) => {
  const limited = enforceAuthRateLimit(c, 'passkey')
  if (limited) return limited
  const body = await c.req.json().catch(() => null)
  const handle = cleanHandle(body?.handle)
  if (!handle) return c.json({ error: 'invalid_handle' }, 400)
  // Identity-keyed bucket (per attempted handle): blunts challenge-table burn
  // targeted at one handle even when per-client IP buckets are not engaged.
  const identityLimited = enforceAuthIdentityRateLimit(c, 'passkey', `handle:${handle}`)
  if (identityLimited) return identityLimited

  const { options, challengeId } = await beginRegistration(handle, rpForRequest(c))
  return c.json({ options, challengeId })
})

passkey.post('/register/verify', async (c) => {
  const limited = enforceAuthRateLimit(c, 'passkey')
  if (limited) return limited
  const body = await c.req.json().catch(() => null)
  const challengeId = typeof body?.challengeId === 'string' ? body.challengeId : null
  const response = body?.response
  const inviteCode = typeof body?.inviteCode === 'string' ? body.inviteCode : undefined
  const deviceLabel =
    typeof body?.deviceLabel === 'string' ? body.deviceLabel.trim().slice(0, MAX_LABEL) : null
  if (!challengeId || !response || typeof response !== 'object') {
    return c.json({ error: 'invalid_request' }, 400)
  }
  // Identity-keyed bucket (per attempted credential id) — applies regardless
  // of IP-header trust; see enforceAuthIdentityRateLimit.
  const credId = credentialIdOf(response)
  const identityLimited = enforceAuthIdentityRateLimit(c, 'passkey', credId ? `cred:${credId}` : null)
  if (identityLimited) return identityLimited

  let verified
  try {
    verified = await verifyRegistration(challengeId, response, rpForRequest(c))
  } catch {
    // Wrong/expired challenge or a failed attestation — never leak which.
    return c.json({ error: 'registration_failed' }, 400)
  }

  const { sub, handle, credential } = verified

  // ── first-owner claim (plan 006 Phase 1) ─────────────────────────────────
  // First-owner claimability is separate from normal-login authZ, which is
  // always fail closed for identities without a member/admin/invite/share.
  // Only the boot-minted setup token enters this OWNER path: role 'admin', a real members row
  // (which closes setup for good), and the token burned. Source-gated to
  // private/loopback client addresses unless SETUP_ALLOW_REMOTE=1
  // (GHSA-mxqh-q9h6-v8pq: never leave first-run ownership claimable by
  // whoever shows up first).
  const setupToken = typeof body?.setupToken === 'string' ? body.setupToken : undefined
  if (setupToken !== undefined) {
    let socketAddress: string | undefined
    try {
      socketAddress = getConnInfo(c).remote.address
    } catch {
      socketAddress = undefined // fail closed below unless SETUP_ALLOW_REMOTE=1
    }
    const client = resolveClientAddress({
      trustProxyHeaders: env.trustClientIpHeaders,
      cfConnectingIp: c.req.header('cf-connecting-ip'),
      trueClientIp: c.req.header('true-client-ip'),
      socketAddress,
    })
    if (!claimSourceAllowed(client?.address)) {
      return c.json({ error: 'claim_source_blocked' }, 403)
    }
    if (!verifySetupToken(setupToken)) {
      return c.json({ error: 'invalid_setup_token' }, 403)
    }
    // One transaction: re-check claimable (two racing claims serialize on
    // SQLite's write lock — the loser sees claimable=false), mint the admin
    // member, persist the credential, burn the token. All-or-nothing so a
    // failure can never leave a claimed-but-credential-less owner.
    const claimed = serverDb().raw.transaction(() => {
      if (!isClaimable()) return false
      addMember({
        sub,
        displayName: handle,
        role: 'admin',
        authMode: 'local',
        invitedBy: 'setup:claim',
      })
      persistCredential(sub, credential, deviceLabel ?? handle)
      markClaimed(sub)
      return true
    }).immediate()
    if (!claimed) return c.json({ error: 'already_claimed' }, 403)
    await setSessionCookie(c, { sub, username: handle, role: 'admin', auth_mode: 'local' })
    return c.json({ ok: true, claimed: true, user: { sub, username: handle, role: 'admin' } })
  }

  // While the install is claimable there is no admin, therefore no invite
  // can legitimately exist. Pre-claim passkey registration requires the setup
  // token so only the operator who can read the host secret can become owner.
  // (The SPA sees claimable via /api/setup/status and shows the claim flow.)
  if (isClaimable()) {
    return c.json({ error: 'server_unclaimed' }, 403)
  }

  // One transaction owns the complete invited registration unit. The invite
  // helper's nested transaction becomes a SQLite savepoint on this same
  // connection, so a later credential write failure rolls back both the
  // member/regrant and invite use. Cookie/device minting remains after commit.
  const registration = serverDb().raw.transaction((): { role: 'admin' | 'user' } | null => {
    // SHARED authZ gate — identical decision to the Plex/Apple paths. A fresh
    // local: sub is never already a member, so this requires a valid invite.
    const authz = authorizeOrRedeem(sub, inviteCode, handle, 'local')
    if (!authz.allowed) return null

    persistCredential(sub, credential, deviceLabel ?? handle)
    return { role: isMember(sub)?.role ?? 'user' }
  }).immediate()
  if (!registration) {
    return c.json({ error: 'no_invite' }, 403)
  }
  const { role } = registration

  // Native app pairing: device-pair triple in the body → device-token
  // Bearer JWE (routes/device.ts wire shape) instead of a session cookie.
  const deviceResponse = await maybeMintDeviceToken(c, body, {
    sub,
    role,
    auth_mode: 'local',
    username: handle,
  })
  if (deviceResponse) return deviceResponse

  await setSessionCookie(c, { sub, username: handle, role, auth_mode: 'local' })
  return c.json({ ok: true, user: { sub, username: handle, role } })
})

// ── authentication ──────────────────────────────────────────────────────────

passkey.post('/login/options', async (c) => {
  const limited = enforceAuthRateLimit(c, 'passkey')
  if (limited) return limited
  const { options, challengeId } = await beginLogin(rpForRequest(c))
  return c.json({ options, challengeId })
})

passkey.post('/login/verify', async (c) => {
  const limited = enforceAuthRateLimit(c, 'passkey')
  if (limited) return limited
  const body = await c.req.json().catch(() => null)
  const challengeId = typeof body?.challengeId === 'string' ? body.challengeId : null
  const response = body?.response
  if (!challengeId || !response || typeof response !== 'object') {
    return c.json({ error: 'invalid_request' }, 400)
  }
  // Identity-keyed bucket (per attempted credential id): credential stuffing
  // against /login/verify hits one bucket per credential no matter the source
  // IP — the per-client buckets are skipped entirely unless
  // TRUST_CLIENT_IP_HEADERS=1, which is off on the tunnel default.
  const credId = credentialIdOf(response)
  const identityLimited = enforceAuthIdentityRateLimit(c, 'passkey', credId ? `cred:${credId}` : null)
  if (identityLimited) return identityLimited

  let sub: string
  try {
    ;({ sub } = await verifyLogin(challengeId, response, rpForRequest(c)))
  } catch {
    return c.json({ error: 'login_failed' }, 400)
  }

  // The signature is valid — but authZ is separate: a revoked passkey user has
  // no active members row and must be denied. isMember collapses revoked → null.
  const member = isMember(sub)
  if (!member) return c.json({ error: 'access_revoked' }, 403)

  recordMemberLogin(sub, member.display_name)
  const username = member.display_name ?? ''

  // Native app pairing: device-pair triple in the body → device-token
  // Bearer JWE (routes/device.ts wire shape) instead of a session cookie.
  const deviceResponse = await maybeMintDeviceToken(c, body, {
    sub,
    role: member.role,
    auth_mode: 'local',
    username,
  })
  if (deviceResponse) return deviceResponse

  await setSessionCookie(c, { sub, username, role: member.role, auth_mode: 'local' })
  return c.json({ ok: true, user: { sub, username, role: member.role } })
})
