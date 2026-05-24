// Auth gates for the API. `requireAuth` rejects anyone without a valid
// session cookie with 401. `requireAdmin` further rejects non-admins
// with 403 — used on every destructive (delete / pause / cancel /
// blocklist) endpoint.
//
// Both middlewares run the decoded cookie session through
// reconcileSession, which (a) recomputes the role from env.admins on
// every request — so an operator who edits ADMINS and redeploys
// demotes the user on their next call without waiting for the cookie
// to expire — and (b) periodically revalidates the user's membership
// in PLEX_SERVER_ID against plex.tv using the stored Plex token, so a
// removed share recipient or a user who signed out from plex.tv loses
// dashboard access within REVALIDATE_TTL_MS instead of after the
// 30-day cookie TTL.

import type { MiddlewareHandler } from 'hono'
import { clearSessionCookie, readSession } from '../session.js'
import type { Session } from '../session.js'
import { reconcileSession } from '../services/sessionGate.js'

export type Env = {
  Variables: {
    session: Session
  }
}

async function loadReconciledSession(c: Parameters<MiddlewareHandler<Env>>[0]): Promise<
  | { ok: true; session: Session }
  | { ok: false; reason: 'unauthenticated' | 'access_revoked' }
> {
  const decoded = await readSession(c)
  if (!decoded) return { ok: false, reason: 'unauthenticated' }
  const reconciled = await reconcileSession(decoded)
  if (!reconciled) {
    // Plex says the user is no longer a member of the home server
    // (or their token was revoked). Drop the cookie so they have to
    // re-auth instead of carrying the now-invalid session around.
    clearSessionCookie(c)
    return { ok: false, reason: 'access_revoked' }
  }
  return { ok: true, session: reconciled }
}

export const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
  const r = await loadReconciledSession(c)
  if (!r.ok) {
    return c.json(
      { error: 'unauthenticated', ...(r.reason === 'access_revoked' ? { reason: r.reason } : {}) },
      401,
    )
  }
  c.set('session', r.session)
  await next()
}

export const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
  const r = await loadReconciledSession(c)
  if (!r.ok) {
    return c.json(
      { error: 'unauthenticated', ...(r.reason === 'access_revoked' ? { reason: r.reason } : {}) },
      401,
    )
  }
  if (r.session.role !== 'admin') {
    return c.json({ error: 'forbidden', reason: 'admin_only' }, 403)
  }
  c.set('session', r.session)
  await next()
}
