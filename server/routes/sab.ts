// Allow-list of SAB endpoints. SAB is single-endpoint with `mode=` and
// `name=` query params, so we read those and route on them. Anything
// not enumerated here is a 404.
//
// Per the user spec: users can VIEW the queue and history, but cannot
// pause / resume / cancel — those are blocking/subtracting actions, so
// admin-only.

import { Hono } from 'hono'
import { requireAuth, requireAdmin, type Env } from '../middleware/auth.js'
import { sabCall } from '../services/sab.js'

export const sab = new Hono<Env>()

sab.use('*', requireAuth)

sab.get('/api', async (c) => {
  const url = new URL(c.req.url)
  const mode = url.searchParams.get('mode')
  const name = url.searchParams.get('name')
  const value = url.searchParams.get('value') ?? undefined

  // Reads — both roles.
  if (mode === 'queue' && !name) {
    const r = await sabCall('queue')
    return forward(r)
  }
  if (mode === 'history' && !name) {
    const limit = url.searchParams.get('limit') ?? '10'
    const r = await sabCall('history', { limit })
    return forward(r)
  }

  // Mutations — admin only.
  if (mode === 'queue' && (name === 'pause' || name === 'resume' || name === 'delete')) {
    const session = c.get('session')
    if (session.role !== 'admin') {
      return c.json({ error: 'forbidden', reason: 'admin_only' }, 403)
    }
    if (!value) return c.json({ error: 'missing value' }, 400)
    const extra: Record<string, string> = { name, value }
    if (name === 'delete') extra.del_files = '1'
    const r = await sabCall('queue', extra)
    return forward(r)
  }

  return c.json({ error: 'not_found' }, 404)
})

async function forward(r: Response): Promise<Response> {
  const body = await r.text()
  return new Response(body, {
    status: r.status,
    headers: { 'Content-Type': r.headers.get('Content-Type') ?? 'application/json' },
  })
}
