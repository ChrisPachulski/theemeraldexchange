// SyncPlay: watch-together groups. Any authenticated member may create or
// join a group pinned to one library item; every member may drive the shared
// transport (play/pause/seek). Clients poll GET /groups/:id — the poll doubles
// as the liveness heartbeat, and its `version` field tells the client whether
// anything changed since the last poll.

import { Hono } from 'hono'
import { requireAuth, type Env } from '../middleware/auth.js'
import { parseLimitedJson } from '../services/parseLimitedJson.js'
import {
  applyCommand,
  createGroup,
  getGroup,
  joinGroup,
  leaveGroup,
  listGroups,
  snapshot,
  touchMember,
  type SyncMediaKind,
} from '../services/syncplay.js'

// Bodies are a kind + id or a command — tiny. Bound the read (mirrors
// watchlist.ts) so a hostile body can't balloon memory.
const MAX_BODY_BYTES = 4 * 1024

export const syncplay = new Hono<Env>()

syncplay.use('*', requireAuth)

function isMediaKind(v: unknown): v is SyncMediaKind {
  return v === 'movie' || v === 'episode'
}

syncplay.get('/groups', (c) => {
  const now = Date.now()
  const items = listGroups(now).map((g) => ({
    ...snapshot(g, now),
    member_count: g.members.size,
  }))
  return c.json({ items })
})

syncplay.post('/groups', async (c) => {
  const session = c.get('session')
  const parsed = await parseLimitedJson(c, MAX_BODY_BYTES)
  if (parsed.tooLarge) return c.json({ error: 'body_too_large' }, 413)
  const body = (parsed.body ?? {}) as { media_kind?: unknown; media_id?: unknown }
  if (!isMediaKind(body.media_kind)) return c.json({ error: 'invalid_media_kind' }, 400)
  if (!Number.isSafeInteger(body.media_id) || (body.media_id as number) <= 0) {
    return c.json({ error: 'invalid_media_id' }, 400)
  }
  const now = Date.now()
  const group = createGroup(
    { sub: session.sub, username: session.username },
    body.media_kind,
    body.media_id as number,
    now,
  )
  return c.json(snapshot(group, now))
})

syncplay.post('/groups/:id/join', (c) => {
  const session = c.get('session')
  const now = Date.now()
  const group = getGroup(c.req.param('id'), now)
  if (!group) return c.json({ error: 'not_found' }, 404)
  joinGroup(group, { sub: session.sub, username: session.username }, now)
  return c.json(snapshot(group, now))
})

syncplay.post('/groups/:id/leave', (c) => {
  const session = c.get('session')
  const now = Date.now()
  const group = getGroup(c.req.param('id'), now)
  if (!group) return c.json({ error: 'not_found' }, 404)
  leaveGroup(group, session.sub)
  return c.json({ ok: true })
})

// The poll: returns the shared transport state and marks the caller alive.
syncplay.get('/groups/:id', (c) => {
  const now = Date.now()
  const group = getGroup(c.req.param('id'), now)
  if (!group) return c.json({ error: 'not_found' }, 404)
  if (!group.members.has(c.get('session').sub)) return c.json({ error: 'not_member' }, 403)
  touchMember(group, c.get('session').sub, now)
  return c.json(snapshot(group, now))
})

syncplay.post('/groups/:id/command', async (c) => {
  const session = c.get('session')
  const now = Date.now()
  const group = getGroup(c.req.param('id'), now)
  if (!group) return c.json({ error: 'not_found' }, 404)
  if (!group.members.has(session.sub)) return c.json({ error: 'not_member' }, 403)

  const parsed = await parseLimitedJson(c, MAX_BODY_BYTES)
  if (parsed.tooLarge) return c.json({ error: 'body_too_large' }, 413)
  const body = (parsed.body ?? {}) as { type?: unknown; position_secs?: unknown }
  if (body.type !== 'play' && body.type !== 'pause' && body.type !== 'seek') {
    return c.json({ error: 'invalid_type' }, 400)
  }
  let position: number | undefined
  if (body.position_secs !== undefined) {
    if (typeof body.position_secs !== 'number' || !Number.isFinite(body.position_secs)) {
      return c.json({ error: 'invalid_position' }, 400)
    }
    position = body.position_secs
  } else if (body.type === 'seek') {
    return c.json({ error: 'invalid_position' }, 400)
  }

  touchMember(group, session.sub, now)
  applyCommand(group, body.type, position, now)
  return c.json(snapshot(group, now))
})
