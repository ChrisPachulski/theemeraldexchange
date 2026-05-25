// Usage telemetry routes. Three surfaces:
//   GET /api/usage/me     — the caller's own last-30-day summary
//   GET /api/usage/admin  — same summary keyed by user (admin only)
//   GET /api/usage/log    — recent raw events for the admin dashboard
//
// Backed by data/usage.jsonl which is appended every time the
// suggestions route makes a Claude call (success or error).

import { Hono } from 'hono'
import { requireAuth, requireAdmin, type Env } from '../middleware/auth.js'
import {
  summarizeUsage,
  readRecentUsageEvents,
  type UsageSummary,
} from '../services/usageLog.js'

export const usage = new Hono<Env>()

usage.use('*', requireAuth)

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

usage.get('/me', async (c) => {
  const session = c.get('session')
  const since = Date.now() - THIRTY_DAYS_MS
  const all = await summarizeUsage(since)
  const mine = all.find((r) => r.sub === session.sub)
  // Always return a row (empty if no calls) so the SPA doesn't have
  // to special-case the cold path.
  const row: UsageSummary = mine ?? {
    sub: session.sub,
    username: session.username,
    calls: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    costCents: 0,
  }
  return c.json(row)
})

usage.get('/admin', requireAdmin, async (c) => {
  const since = Date.now() - THIRTY_DAYS_MS
  const all = await summarizeUsage(since)
  return c.json(all)
})

usage.get('/log', requireAdmin, async (c) => {
  const limitRaw = c.req.query('limit')
  const n = Number(limitRaw)
  const limit = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 200) : 50
  return c.json(await readRecentUsageEvents(limit))
})
