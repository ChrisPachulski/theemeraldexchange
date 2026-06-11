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
import type { Env } from '../middleware/auth.js'
import {
  beginRegistration,
  verifyRegistration,
  persistCredential,
  beginLogin,
  verifyLogin,
} from '../services/webauthn.js'
import {
  authorizeOrRedeem,
  enforceAuthRateLimit,
  enforceAuthIdentityRateLimit,
} from '../auth.js'
import { isMember, recordMemberLogin } from '../services/members.js'
import { setSessionCookie } from '../session.js'

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

  const { options, challengeId } = await beginRegistration(handle)
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
    verified = await verifyRegistration(challengeId, response)
  } catch {
    // Wrong/expired challenge or a failed attestation — never leak which.
    return c.json({ error: 'registration_failed' }, 400)
  }

  const { sub, handle, credential } = verified

  // SHARED authZ gate — identical decision to the Plex/Apple paths. A fresh
  // local: sub is never already a member, so this requires a valid invite.
  const authz = authorizeOrRedeem(sub, inviteCode, handle, 'local')
  if (!authz.allowed) {
    // No credential persisted, no member minted — the orphan is avoided by
    // ordering authZ before persistCredential.
    return c.json({ error: 'no_invite' }, 403)
  }

  // Membership minted (or pre-existing) — now durably record the passkey.
  persistCredential(sub, credential, deviceLabel ?? handle)

  const member = isMember(sub)
  const role = member?.role ?? 'user'
  await setSessionCookie(c, { sub, username: handle, role, auth_mode: 'local' })
  return c.json({ ok: true, user: { sub, username: handle, role } })
})

// ── authentication ──────────────────────────────────────────────────────────

passkey.post('/login/options', async (c) => {
  const limited = enforceAuthRateLimit(c, 'passkey')
  if (limited) return limited
  const { options, challengeId } = await beginLogin()
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
    ;({ sub } = await verifyLogin(challengeId, response))
  } catch {
    return c.json({ error: 'login_failed' }, 400)
  }

  // The signature is valid — but authZ is separate: a revoked passkey user has
  // no active members row and must be denied. isMember collapses revoked → null.
  const member = isMember(sub)
  if (!member) return c.json({ error: 'access_revoked' }, 403)

  recordMemberLogin(sub, member.display_name)
  const username = member.display_name ?? ''
  await setSessionCookie(c, { sub, username, role: member.role, auth_mode: 'local' })
  return c.json({ ok: true, user: { sub, username, role: member.role } })
})
