// Per-request session reconciliation. The session cookie is JWE-
// encrypted and HttpOnly so the client can't tamper with it, but the
// claims inside are still a 30-day snapshot of facts that can change:
//
//   - role        — env.admins can be edited in production without
//                   invalidating any session cookie. A demoted admin
//                   would otherwise keep admin until cookie expiry.
//   - membership  — the user can be removed from PLEX_SERVER_ID (or
//                   sign out from plex.tv) and the cookie wouldn't
//                   notice; they'd retain access until expiry or
//                   SESSION_SECRET rotation.
//
// This module rolls a "reconcile on every protected request" layer in
// front of the raw cookie:
//   - role is recomputed cheaply from env.admins on every call.
//   - membership is re-checked against plex.tv at most once per
//     REVALIDATE_TTL_MS per sub, using the user's stored Plex token.
//     A definitive non-membership signal (200 with no matching server
//     resource) is cached per sub. A 401/403 from plex.tv means the
//     specific token was revoked, so that request returns null without
//     poisoning valid sibling sessions for the same sub.
//     Network errors / 5xx / timeout keep the user signed in and the
//     prior cached status — a plex.tv outage shouldn't lock everyone
//     out of the dashboard.

import { createHash } from 'crypto'
import { env } from '../env.js'
import { probeResources } from '../plex.js'
import type { Role, Session } from '../session.js'
import { authModeFromSession } from '../session.js'
import { cascadeRevokeForSub } from './reconcileDeviceToken.js'
import { memberStatus } from './membership.js'
import { isMember } from './members.js'
import { createLogger } from './logger.js'
import { sealVerifiedAdminOwnership } from './setupState.js'

const authLog = createLogger('auth')

// Cascade-revocation contract (§3.4): when Plex definitively denies the
// cookie user (auth_revoked or not_member), ALSO revoke every paired
// Apple device for that sub. Without this, a household member booted
// from the Plex server keeps streaming via their paired tvOS/iOS app
// until the 180-day device-token TTL expires. INSERT OR IGNORE makes
// the cascade idempotent so re-firing on cached denials is safe.
function cascadeOnDenial(sub: string, reason: string): void {
  try {
    const n = cascadeRevokeForSub(sub, reason)
    if (n > 0) {
      authLog.warn('device token cascade completed', {
        event: 'auth_device_cascade',
        outcome: 'revoked',
        revokedCount: n,
        reason,
      })
    }
  } catch (e) {
    // Don't let a cascade-revoke DB hiccup mask the underlying denial —
    // the cookie path's null-return MUST still propagate. Log + swallow.
    authLog.error('device token cascade failed', {
      event: 'auth_device_cascade',
      outcome: 'bookkeeping_failed',
      causeType: e instanceof Error ? 'error' : typeof e,
    })
  }
}

const REVALIDATE_TTL_MS = 15 * 60 * 1000
const REVALIDATE_TIMEOUT_MS = 5_000
const MAX_CACHE_ENTRIES = 1000

type Status = 'member' | 'not_member'
type CheckStatus = Status | 'auth_revoked' | 'unknown'

type Cached = { status: Status; checkedAt: number; tokenFingerprint?: string; plexServerId?: string }
const cache = new Map<string, Cached>()

function fingerprintToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

function setCached(sub: string, cached: Cached): void {
  if (cache.has(sub)) cache.delete(sub)
  cache.set(sub, cached)
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

export function _resetSessionGateCacheForTests(): void {
  cache.clear()
}

// Seed the cache after a successful PIN check so the first protected
// request doesn't re-hit plex.tv. The login path already verified
// membership, so any seed here is fresh.
export function _primeSessionGateCache(
  sub: string,
  status: Status = 'member',
  plexAuthToken?: string,
): void {
  setCached(sub, {
    status,
    checkedAt: Date.now(),
    tokenFingerprint: status === 'member' && plexAuthToken
      ? fingerprintToken(plexAuthToken)
      : undefined,
    plexServerId: status === 'member' && env.plexServerId ? env.plexServerId : undefined,
  })
}

export function roleFor(username: string, sub?: string): Role {
  // Admin-by-sub: the stable, provider-scoped owner/admin allowlist. An exact
  // namespaced-sub match (e.g. plex:494190801, apple:001234...) — not guessable
  // from a free-text username/email — so this is the safe way to grant admin to
  // a non-Plex identity.
  if (sub && (env.adminSubs ?? []).includes(sub)) return 'admin'
  // Legacy admin-by-Plex-username (env.admins) must NEVER promote a non-Plex
  // identity. ADMINS is documented as *Plex usernames*; for Apple the username
  // is `verified.email.split('@')[0]` (attacker-chosen) and for passkeys it is
  // a self-chosen handle — matching either against ADMINS would let any invited
  // apple:/local: user whose name collides with an admin entry escalate to
  // admin, and reconcileSession would re-grant it on every request. Block the
  // username match for the non-Plex providers; plex: and legacy bare-numeric
  // Plex subs keep the historical behavior. Apple/passkey/Google admins must
  // instead be named explicitly by stable sub in ADMIN_SUBS (handled above).
  if (
    sub &&
    (sub.startsWith('apple:') || sub.startsWith('local:') || sub.startsWith('google:'))
  )
    return 'user'
  const lower = username.toLowerCase()
  return env.admins.some((a) => a.toLowerCase() === lower) ? 'admin' : 'user'
}

/** Effective role for an identity whose provider proof has already succeeded. */
export function effectiveRoleFor(username: string, sub: string): Role {
  const configured = roleFor(username, sub)
  if (configured === 'admin') return 'admin'
  return isMember(sub)?.role === 'admin' ? 'admin' : 'user'
}

/** Successful reconciliation boundary. An effective administrator has now
 * passed both the signed-session proof and live authZ, so permanently close
 * first-owner setup before returning any usable session. */
function finishAuthorizedSession(session: Session, role: Role): Session {
  if (role === 'admin') sealVerifiedAdminOwnership(session.sub)
  return { ...session, role }
}

/**
 * Reconcile a decoded session against current env + Plex state.
 *
 *   - role is always recomputed from env.admins (cheap, in-process,
 *     so demotions take effect on the next request).
 *   - membership is revalidated at most once per REVALIDATE_TTL_MS per
 *     sub. A definitive non-member signal returns null so the
 *     middleware can clear the cookie and 401. Network errors leave
 *     the cached status intact and pass the request through.
 *
 * Returns the (possibly role-corrected) session or null if the user
 * should be signed out. The cookie itself is not re-signed — the
 * override applies for the lifetime of this request only.
 */
export async function reconcileSession(session: Session): Promise<Session | null> {
  // Pass the sub so the provider guard applies on every request — an apple:/
  // local: session can never be re-escalated to admin via an ADMINS username
  // collision, and ADMIN_SUBS admins keep admin without a username match.
  // DB-backed admin (plan 006 Phase 1) and configured authorities converge on
  // the same exact-sub role decision used at successful login.
  const role = effectiveRoleFor(session.username, session.sub)

  // AuthZ gate — the FIRST and AUTHORITATIVE decision, before any
  // provider-specific work. With the invite/members model the per-request
  // question is no longer "is this sub a live Plex member?" but "is this
  // sub in the allowlist?" — provider-agnostic and identical for apple:
  // and plex: subs. memberStatus short-circuits ADMIN_SUBS to 'allowed'
  // (owner bootstrap) so the operator's own sub never needs an invite.
  const status = memberStatus(session.sub)
  if (status !== 'allowed') {
    // Revoked or never-a-member. Deny and cascade so any paired Apple/
    // tvOS device tokens for this sub are revoked on their next request
    // rather than at the 180-day TTL.
    cascadeOnDenial(session.sub, status === 'revoked' ? 'member_revoked' : 'not_member')
    return null
  }

  const authMode = authModeFromSession(session)

  // apple: subs NEVER probe plex.tv — Apple proved identity at login and
  // the members allowlist is the live authZ. There is no Plex token to
  // confirm and no plex.tv outage to couple to.
  if (authMode !== 'plex') {
    return finishAuthorizedSession(session, role)
  }

  // plex: subs — the allowlist above is authoritative. The plex.tv probe
  // is demoted to an OPTIONAL token-liveness / defense-in-depth signal:
  //   - it can ALSO drop the session when plex.tv definitively revokes
  //     the token (the user signed out of plex.tv), and auto-revoke the
  //     member row so state converges;
  //   - but a plex.tv 'not_member' or outage must NEVER override a
  //     present members row (fail-open on the probe, fail-closed on the
  //     allowlist).
  // When no Plex gate is configured or the cookie carries no Plex token
  // (e.g. a member added by the owner who hasn't re-logged-in), there is
  // nothing to probe — the allowlist decision stands.
  if (!env.plexServerId || !session.plexAuthToken) {
    return finishAuthorizedSession(session, role)
  }

  const now = Date.now()
  const tokenFingerprint = fingerprintToken(session.plexAuthToken)
  const cached = cache.get(session.sub)
  if (cached && now - cached.checkedAt < REVALIDATE_TTL_MS) {
    if (
      cached.status === 'member' &&
      cached.tokenFingerprint === tokenFingerprint &&
      cached.plexServerId === env.plexServerId
    ) {
      return finishAuthorizedSession(session, role)
    }
    // A cached not_member is advisory only now — the allowlist already
    // said 'allowed', so we keep the member signed in and let an admin
    // revoke explicitly if desired. Fall through to a fresh probe.
  }

  const probe = await checkMembership(session.plexAuthToken)
  if (probe === 'auth_revoked') {
    // Definitive plex.tv token revocation = the user signed out of
    // plex.tv. Drop this session and cascade-revoke their devices.
    cascadeOnDenial(session.sub, 'plex_auth_revoked')
    return null
  }
  if (probe === 'member') {
    setCached(session.sub, {
      status: 'member',
      checkedAt: now,
      tokenFingerprint,
      plexServerId: env.plexServerId,
    })
  } else {
    // 'not_member' or 'unknown' — advisory only. The allowlist wins, so
    // the row-backed member stays signed in. Cache the not_member signal
    // so we don't probe again this TTL, but do NOT deny.
    setCached(session.sub, {
      status: probe === 'not_member' ? 'not_member' : 'member',
      checkedAt: now,
      tokenFingerprint: probe === 'not_member' ? undefined : tokenFingerprint,
      plexServerId: probe === 'not_member' ? undefined : env.plexServerId,
    })
  }
  return finishAuthorizedSession(session, role)
}

async function checkMembership(token: string): Promise<CheckStatus> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REVALIDATE_TIMEOUT_MS)
  try {
    const probe = await probeResources(token, controller.signal)
    if (probe.kind === 'ok') {
      const isMember = probe.resources.some(
        (r) => r.provides.includes('server') && r.clientIdentifier === env.plexServerId,
      )
      return isMember ? 'member' : 'not_member'
    }
    if (probe.kind === 'http_error') {
      // 401 / 403 = token revoked. Definitive sign-out signal.
      if (probe.status === 401 || probe.status === 403) return 'auth_revoked'
      // 4xx other than auth, or 5xx — treat as transient. Don't lock
      // the user out on a plex.tv hiccup; we'll re-check next TTL.
      console.warn('[sessionGate] plex membership probe HTTP', probe.status)
      return 'unknown'
    }
    // network_error
    return 'unknown'
  } catch (e) {
    console.error(
      '[sessionGate] plex membership probe threw:',
      e instanceof Error ? e.message : String(e),
    )
    return 'unknown'
  } finally {
    clearTimeout(timer)
  }
}
