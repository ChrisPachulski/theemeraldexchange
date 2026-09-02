// server/routes/account.ts — self-service account deletion for the Apple
// clients (App Store Guideline 5.1.1(v)). Contract: the app repo's
// docs/server-requirements-for-submission.md.
//
//   DELETE /api/account/self — revoke MY membership, every device token and
//   invite I hold, and purge my per-member state.
//     204            deleted, or already deleted (idempotent replay)
//     401            missing or already-revoked credential (requireAuth)
//     409 last_admin I am the only remaining administrator
//
// The subject is always session.sub: the route takes no parameter, so it can
// never be aimed at another member. The caller's own device token authorizes
// the request and is revoked by the cascade — the client deliberately does
// NOT call DELETE /api/devices/self first, which would kill the credential this
// request needs.

import { Hono } from 'hono'
import { requireAuth, type Env } from '../middleware/auth.js'
import { env } from '../env.js'
import { revokeSelf } from '../services/members.js'
import { eraseMemberState, type ErasureHooks } from '../services/memberErasure.js'
import { createLogger } from '../services/logger.js'

const log = createLogger('account')

export function accountRoutes(hooks: ErasureHooks = {}): Hono<Env> {
  const account = new Hono<Env>()
  account.use('/self', requireAuth)

  account.delete('/self', async (c) => {
    const session = c.get('session')
    const outcome = revokeSelf({
      sub: session.sub,
      immutableAdminSubs: env.adminSubs,
      legacyAdminUsernames: env.admins,
    })
    if (outcome === 'last_admin') return c.json({ error: 'last_admin' }, 409)

    // The members row is committed (or was already revoked). Everything below
    // is convergence: a failed step is logged for the operator, never surfaced,
    // because bearer reconciliation already denies the revoked member on its
    // next request.
    const failures = await eraseMemberState(session.sub, hooks)
    const requestId = c.req.header('x-request-id') ?? 'unavailable'
    for (const failure of failures) {
      log.error('account erasure step failed', { step: failure.step, error: failure.error, requestId })
    }
    log.info('account deleted', { outcome, failedSteps: failures.map((f) => f.step), requestId })
    return c.body(null, 204)
  })

  return account
}
