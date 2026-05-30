// Read-only view onto the grab-event log.
//
//   GET /api/grabs/recent?limit=20   admin only — full activity feed
//   GET /api/grabs/by-item?app=…&itemId=…  authed — per-item history,
//     scoped to the caller's own grab events (by `sub`). itemId is no
//     longer relied on as a capability: Sonarr/Radarr ids are small
//     sequential integers, so an unscoped read let any member enumerate
//     itemId=1..N and read everyone's grab history. Legacy events with
//     no recorded `sub` stay visible so pre-attribution history isn't
//     lost (see readEventsForItem).
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
  const { sub } = c.get('session')
  const events = await readEventsForItem(app, itemId, limit, sub)
  return c.json(events)
})
