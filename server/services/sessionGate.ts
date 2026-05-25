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

const REVALIDATE_TTL_MS = 15 * 60 * 1000
const REVALIDATE_TIMEOUT_MS = 5_000
const MAX_CACHE_ENTRIES = 1000

type Status = 'member' | 'not_member'
type CheckStatus = Status | 'auth_revoked' | 'unknown'

type Cached = { status: Status; checkedAt: number; tokenFingerprint?: string }
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
  })
}

export function roleFor(username: string): Role {
  const lower = username.toLowerCase()
  return env.admins.some((a) => a.toLowerCase() === lower) ? 'admin' : 'user'
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
  const role = roleFor(session.username)

  // Bootstrap mode (no PLEX_SERVER_ID configured): nothing to revalidate
  // against. Recompute role only.
  if (!env.plexServerId) {
    return { ...session, role }
  }

  // A configured gate REQUIRES a Plex token in the cookie. Legacy
  // sessions issued before the token field existed can still be decoded
  // (the session type leaves the field optional for that reason), but
  // they can't be authorized — without the token we have no way to
  // verify the user is still in PLEX_SERVER_ID, and trusting the
  // cookie alone would re-open exactly the revocation window this
  // module exists to close. Force re-auth.
  if (!session.plexAuthToken) {
    return null
  }

  const now = Date.now()
  const tokenFingerprint = fingerprintToken(session.plexAuthToken)
  const cached = cache.get(session.sub)
  if (cached && now - cached.checkedAt < REVALIDATE_TTL_MS) {
    if (cached.status === 'not_member') return null
    if (cached.tokenFingerprint === tokenFingerprint) return { ...session, role }
  }

  const status = await checkMembership(session.plexAuthToken)
  if (status === 'unknown') {
    // plex.tv hiccup. Fall back to the prior cached answer if any —
    // if we've never had a definitive answer for this sub, allow the
    // request rather than locking everyone out.
    if (cached) {
      if (cached.status === 'not_member') return null
      if (cached.tokenFingerprint === tokenFingerprint) return { ...session, role }
    }
    return { ...session, role }
  }

  if (status === 'auth_revoked') return null

  setCached(session.sub, {
    status,
    checkedAt: now,
    tokenFingerprint: status === 'member' ? tokenFingerprint : undefined,
  })
  if (status === 'not_member') return null
  return { ...session, role }
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
