// /api/dvr: a gated proxy to the iptv service, which schedules, records and
// serves the recordings (crates/iptv/src/dvr.rs). Mounted only with
// DVR_ENABLED and IPTV on (app.ts); the service mounts its routes on the same
// condition.
//
// Recorded live TV belongs to the `live` section and carries no
// certification, so every route needs the section and the grant needs an
// uncapped profile. Scheduling and deleting are admin-only (the service also
// rate-limits them per caller). Play accepts a ?t= recording token (Hono
// checks signature + membership, the service checks kind + recording id) or
// falls back to the session, where the grant's gates are re-applied.

import { Hono, type Context } from 'hono'
import { requireAdmin, requireAuth, type Env } from '../middleware/auth.js'
import { capBlocksUnrated } from '../services/parentalRating.js'
import {
  forwardToIptv,
  liveSectionDenied,
  sessionFromSub,
  verifyStreamTokenMember,
} from '../services/iptvService.js'

export const dvr = new Hono<Env>()

async function liveGates(c: Context<Env>, capped: boolean): Promise<Response> {
  const denied = await liveSectionDenied(c)
  if (denied) return denied
  if (capped && (await capBlocksUnrated(c.get('session')))) {
    return c.json({ error: 'rating_blocked' }, 403)
  }
  return forwardToIptv(c, c.get('session'))
}

dvr.post('/recordings', requireAdmin, (c) => forwardToIptv(c, c.get('session')))
dvr.delete('/recordings/:id', requireAdmin, (c) => forwardToIptv(c, c.get('session')))
dvr.get('/recordings', requireAuth, (c) => liveGates(c, false))
dvr.get('/recordings/:id', requireAuth, (c) => liveGates(c, false))
dvr.post('/recordings/:id/grant', requireAuth, (c) => liveGates(c, true))

dvr.get('/recordings/:id/play', async (c) => {
  const token = c.req.query('t')
  if (token) {
    const sub = verifyStreamTokenMember(c, token)
    if (typeof sub !== 'string') return sub
    return forwardToIptv(c, sessionFromSub(sub))
  }
  const authDenied = await requireAuth(c, async () => {})
  if (authDenied) return authDenied
  return liveGates(c, true)
})
