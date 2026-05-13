// CRUD on the persistent "never suggest this" list. Both reads and
// writes are auth-only — the list is shared across the household.

import { Hono } from 'hono'
import { requireAuth, type Env } from '../middleware/auth.js'
import { getRejections, addRejection, removeRejection, type RejectionsKind } from '../services/rejections.js'

export const rejections = new Hono<Env>()

rejections.use('*', requireAuth)

rejections.get('/', async (c) => {
  return c.json(await getRejections())
})

rejections.post('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { type?: string; tmdbId?: number }
    | null
  if (!body) return c.json({ error: 'invalid_body' }, 400)
  if (body.type !== 'movie' && body.type !== 'tv') {
    return c.json({ error: 'invalid_type' }, 400)
  }
  if (!Number.isFinite(body.tmdbId) || (body.tmdbId as number) <= 0) {
    return c.json({ error: 'invalid_tmdbId' }, 400)
  }
  await addRejection(body.type as RejectionsKind, body.tmdbId as number)
  return c.json({ ok: true })
})

rejections.delete('/:type/:tmdbId', async (c) => {
  const type = c.req.param('type')
  const tmdbId = Number(c.req.param('tmdbId'))
  if (type !== 'movie' && type !== 'tv') {
    return c.json({ error: 'invalid_type' }, 400)
  }
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
    return c.json({ error: 'invalid_tmdbId' }, 400)
  }
  await removeRejection(type as RejectionsKind, tmdbId)
  return c.json({ ok: true })
})
