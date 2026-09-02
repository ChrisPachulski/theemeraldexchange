// /api/iptv sessions routes, split from the former single iptv.ts (paths unchanged).

import { Hono } from 'hono'
import { requireAuth } from '../../middleware/auth.js'
import { getAccountInfo } from '../../services/xtream.js'
import { streamConcurrency } from '../../services/iptvConcurrency.js'
import { getActiveLiveRemuxEntry, forgetLiveRemuxEntry } from '../../services/iptvLiveRemuxMap.js'
import { type Env } from '../../middleware/auth.js'
import { enrichSessions, userOf } from './shared.js'

export const iptv = new Hono<Env>()

// Connection diagnostics: surface our concurrency tracker + the upstream's
// own active_cons/max_connections counters so the SPA can show "1 of 2
// slots in use" and let the user kick whichever of OUR sessions is holding
// a slot. Doesn't (and can't) kick sessions from other IPTV apps using the
// same mybunny credentials directly — those are invisible to us. UI should
// explain that distinction.
iptv.get('/sessions', requireAuth, async (c) => {
  const { sub } = userOf(c)
  // Scope to the caller's own sessions. The tracker is household-wide, so an
  // unfiltered list handed every member the sub, resolved title and client IP
  // of everyone else's active stream. Admins keep full visibility because they
  // are the ones doing support/kicking — same gate as the DELETE below.
  const isAdmin = c.get('session').role === 'admin'
  const ours = enrichSessions(streamConcurrency().list().filter((s) => isAdmin || s.sub === sub))
  let upstream: { activeConnections: number; maxConnections: number; status: string } | null
  try {
    const info = await getAccountInfo()
    upstream = {
      activeConnections: info.activeConnections,
      maxConnections: info.maxConnections,
      status: info.status,
    }
  } catch {
    // Upstream probe failures shouldn't block the local sessions list —
    // they're the more interesting half anyway.
    upstream = null
  }
  return c.json({
    self: sub,
    upstream,
    ours,
  })
})

// Force-release. Admins can release any session; everyone else only their
// own. We trust sessionId to be opaque, so no admin can stomp anonymous
// sessions by guessing IDs — the session must exist.
iptv.delete('/sessions/:sessionId', requireAuth, (c) => {
  const sessionId = c.req.param('sessionId')
  const { sub } = userOf(c)
  const isAdmin = c.get('session').role === 'admin'
  const all = streamConcurrency().list()
  const target = all.find((s) => s.sessionId === sessionId)
  if (!target) return c.json({ error: 'not_found' }, 404)
  if (!isAdmin && target.sub !== sub) return c.json({ error: 'forbidden' }, 403)
  // dvr: is a synthetic sub minted only by dvrRecorder.start() (server/services/dvrRecorder.ts) so an
  // in-flight recording shows up in this list and counts toward upstreamInUse. It can never be a real
  // user sub. Releasing it here would free the accounting slot while the real ffmpeg keeps recording and
  // holding the actual upstream connection — undercounting upstreamInUse() and risking the provider's
  // abuse-block. Route the admin to the DVR panel instead, which stops the process AND the slot together.
  if (target.sub.startsWith('dvr:')) {
    return c.json(
      {
        error: 'dvr_recording_session',
        message:
          'stop this recording from the DVR panel (DELETE /api/dvr/recordings/:id), not the sessions widget',
      },
      409,
    )
  }
  streamConcurrency().release(sessionId)
  // A remux (AVPlayer live) slot is backed by an ffmpeg process holding a live
  // upstream provider connection, tracked SEPARATELY from the concurrency slot.
  // Releasing the slot alone leaves that ffmpeg alive until the 90s idle sweep,
  // so freeing a session in the sessions widget did not actually free the
  // provider connection. Stop the matching remux session now (keyed by the
  // slot's resourceId=streamId + sub) so the connection releases immediately.
  if (target.kind === 'remux') {
    const entry = getActiveLiveRemuxEntry(target.resourceId, target.sub)
    if (entry) forgetLiveRemuxEntry(target.resourceId, target.sub, entry.sessionId)
  }
  return c.json({ ok: true, released: sessionId })
})
