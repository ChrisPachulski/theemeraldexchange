// /api/iptv: a gated proxy to the iptv service (services/iptvService.ts).
// Paths, query strings and bodies pass through unchanged; Hono only decides
// who may reach them.
//
//   GET /stream/**      cookieless: a ?t= (or ?u= for /stream/segment) stream
//                       token, signature + membership checked here, kind and
//                       resource by the service. Players load these
//                       cross-origin without credentials.
//   GET /playlist.m3u   cookieless: a playlist token, plus membership, the
//                       live section and the rating cap re-checked at serve
//                       time (external players such as VLC refetch it).
//   everything else     requireAuth, then the live section except on the
//                       caller's own sessions and playlist-token list, then
//                       the rating cap on every grant and playlist mint (live
//                       TV carries no certification).

import { Hono, type Context } from 'hono'
import { requireAuth, type Env } from '../middleware/auth.js'
import { getPolicy } from '../services/userPolicies.js'
import { capBlocksUnrated } from '../services/parentalRating.js'
import { effectiveRoleFor } from '../services/sessionGate.js'
import { memberStatus } from '../services/membership.js'
import { verifyStreamToken } from '../services/iptvStreamToken.js'
import {
  forwardToIptv,
  liveSectionDenied,
  revokeIptvPlaylistTokens,
  sessionFromSub,
  verifyStreamTokenMember,
} from '../services/iptvService.js'
import { createLogger } from '../services/logger.js'
import { env } from '../env.js'

const log = createLogger('iptv')

export const iptv = new Hono<Env>()

const NO_SECTION = /^\/(sessions(\/[^/]+)?|playlist\/tokens(\/[^/]+)?)$/
const CAPPED = /^\/(stream\/(live|catchup|vod|series)\/[^/]+\/grant|playlist\/token)$/

function subpath(c: Context<Env>): string {
  return new URL(c.req.url).pathname.replace(/^\/api\/iptv/, '') || '/'
}

iptv.get('/stream/*', async (c) => {
  const sub = verifyStreamTokenMember(c, c.req.query('t') ?? c.req.query('u') ?? '')
  if (typeof sub !== 'string') return sub
  return forwardToIptv(c, sessionFromSub(sub))
})

iptv.get('/playlist.m3u', async (c) => {
  let sub: string
  try {
    sub = verifyStreamToken(env.streamTokenSecret, c.req.query('t') ?? '').sub
  } catch (err) {
    return c.json({ error: 'invalid_token', detail: err instanceof Error ? err.message : String(err) }, 401)
  }
  const status = memberStatus(sub)
  if (status !== 'allowed') {
    // A revoked member's tokens die with the membership, not at their 90-day exp.
    if (status === 'revoked') {
      await revokeIptvPlaylistTokens(sub).catch((err: unknown) => log.error('playlist-token revoke failed', { err }))
    }
    return c.json({ error: 'access_revoked' }, 401)
  }
  // No cookie here, so the role comes from ADMIN_SUBS + the members row.
  const role = effectiveRoleFor('', sub)
  if (role !== 'admin') {
    const policy = await getPolicy(sub)
    if (policy.allowedSections && !policy.allowedSections.live) {
      return c.json({ error: 'section_blocked' }, 403)
    }
  }
  if (await capBlocksUnrated({ sub, role })) return c.json({ error: 'rating_blocked' }, 403)
  return forwardToIptv(c, sessionFromSub(sub, role))
})

iptv.all('/*', requireAuth, async (c) => {
  const path = subpath(c)
  if (!NO_SECTION.test(path)) {
    const denied = await liveSectionDenied(c)
    if (denied) return denied
  }
  if (c.req.method === 'POST' && CAPPED.test(path) && (await capBlocksUnrated(c.get('session')))) {
    return c.json({ error: 'rating_blocked' }, 403)
  }
  return forwardToIptv(c, c.get('session'))
})
