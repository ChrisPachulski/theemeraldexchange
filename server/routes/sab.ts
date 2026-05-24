// Allow-list of SAB endpoints. SAB is single-endpoint with `mode=` and
// `name=` query params upstream, but we split read-vs-mutate by HTTP
// method on our side so cross-site requests can't trigger admin
// actions via GET image/link tags.
//
// Per the user spec: users can VIEW the queue and history, but cannot
// pause / resume / cancel — those are blocking/subtracting actions, so
// admin-only.
//
//   GET    /api/sab/api?mode=queue                 - queue snapshot (both roles)
//   GET    /api/sab/api?mode=history&limit=N       - history (both roles)
//   POST   /api/sab/api/queue/:nzoId/pause         - admin
//   POST   /api/sab/api/queue/:nzoId/resume        - admin
//   DELETE /api/sab/api/queue/:nzoId               - admin (with del_files=1)

import { Hono, type Context } from 'hono'
import { requireAuth, type Env } from '../middleware/auth.js'
import { sabCall } from '../services/sab.js'

export const sab = new Hono<Env>()
const DEFAULT_HISTORY_LIMIT = 10
const MAX_HISTORY_LIMIT = 100

sab.use('*', requireAuth)

// Reads — both roles. The presence of a `name` param is rejected here
// so the legacy SAB-style "GET ?mode=queue&name=pause" attack vector
// returns 404 instead of being interpreted as a read.
sab.get('/api', async (c) => {
  const url = new URL(c.req.url)
  const mode = url.searchParams.get('mode')
  if (url.searchParams.has('name')) {
    return c.json({ error: 'not_found' }, 404)
  }

  if (mode === 'queue') {
    const r = await sabCall('queue')
    return forward(r)
  }
  if (mode === 'history') {
    const limit = parseHistoryLimit(url.searchParams.get('limit'))
    const r = await sabCall('history', { limit })
    return forward(r)
  }
  return c.json({ error: 'not_found' }, 404)
})

function parseHistoryLimit(raw: string | null): string {
  if (raw === null) return String(DEFAULT_HISTORY_LIMIT)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) return String(DEFAULT_HISTORY_LIMIT)
  return String(Math.min(value, MAX_HISTORY_LIMIT))
}

// Mutations — admin only, method-distinguished so browser GET CSRF
// vectors can't trigger them. Cookies are SameSite=None in prod, so
// state-changing requests rely on the global Origin check
// (requireSafeOrigin) plus per-route admin role.
function ensureAdmin(c: Context<Env>): Response | null {
  const session = c.get('session')
  if (session.role !== 'admin') {
    return c.json({ error: 'forbidden', reason: 'admin_only' }, 403)
  }
  return null
}

sab.post('/api/queue/:nzoId/pause', async (c) => {
  const forbidden = ensureAdmin(c)
  if (forbidden) return forbidden
  const r = await sabCall('queue', { name: 'pause', value: c.req.param('nzoId') })
  return forward(r)
})

sab.post('/api/queue/:nzoId/resume', async (c) => {
  const forbidden = ensureAdmin(c)
  if (forbidden) return forbidden
  const r = await sabCall('queue', { name: 'resume', value: c.req.param('nzoId') })
  return forward(r)
})

sab.delete('/api/queue/:nzoId', async (c) => {
  const forbidden = ensureAdmin(c)
  if (forbidden) return forbidden
  const r = await sabCall('queue', {
    name: 'delete',
    value: c.req.param('nzoId'),
    del_files: '1',
  })
  return forward(r)
})

async function forward(r: Response): Promise<Response> {
  const body = await r.text()
  return new Response(body, {
    status: r.status,
    headers: { 'Content-Type': r.headers.get('Content-Type') ?? 'application/json' },
  })
}
