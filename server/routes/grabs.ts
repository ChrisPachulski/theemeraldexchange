// Read-only view onto the grab-event log.
//
//   GET /api/grabs/recent?limit=20   admin only — full activity feed
//   GET /api/grabs/by-item?app=…&itemId=…  authed — per-item history.
//     itemId acts as a weak capability; a household member can only see
//     events for an id they already know (e.g. one they just added).
//
// The append side lives in services/grabLog.ts and is called from the
// cap pipelines (sonarr.ts, radarr.ts) when grabs succeed or fail.

import { Hono } from 'hono'
import { requireAuth, requireAdmin, type Env } from '../middleware/auth.js'
import { readRecentGrabEvents, readEventsForItem } from '../services/grabLog.js'

export const grabs = new Hono<Env>()

grabs.use('*', requireAuth)

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max)
}

grabs.get('/recent', requireAdmin, async (c) => {
  const limit = parseLimit(c.req.query('limit'), 20, 200)
  const events = await readRecentGrabEvents(limit)
  return c.json(events)
})

grabs.get('/by-item', async (c) => {
  const app = c.req.query('app')
  const itemIdRaw = c.req.query('itemId')
  if (app !== 'sonarr' && app !== 'radarr') {
    return c.json({ error: 'invalid_app' }, 400)
  }
  const itemId = Number(itemIdRaw)
  // Sonarr/Radarr expose integer primary keys; rejecting decimals or
  // unsafe-large numbers here mirrors what the upstream APIs would
  // reject anyway, and prevents a downstream readEventsForItem scan
  // against a junk value.
  if (!Number.isSafeInteger(itemId) || itemId <= 0) {
    return c.json({ error: 'invalid_itemId' }, 400)
  }
  const limit = parseLimit(c.req.query('limit'), 20, 100)
  const events = await readEventsForItem(app, itemId, limit)
  return c.json(events)
})
