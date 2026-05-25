// IPTV (MyBunny / Xtream) router. Mounted at /api/iptv. Currently only
// exposes a health smoke endpoint that surfaces the upstream Xtream
// account's expiry, connection cap, and status — the SPA uses it to
// warn when the panel is dead or the line is exhausted before the user
// tries to start a stream.

import { Hono } from 'hono'
import { requireAuth, requireAdmin, type Env } from '../middleware/auth.js'
import { getAccountInfo } from '../services/xtream.js'
import { syncOnce, type SyncResult } from '../services/iptvSync.js'
import { iptvDb } from '../services/iptvDbSingleton.js'
import { randomUUID } from 'node:crypto'

export const iptv = new Hono<Env>()

iptv.use('*', requireAuth)

iptv.get('/health', async (c) => {
  try {
    const info = await getAccountInfo()
    return c.json({
      expiresAt: info.expiresAt ? info.expiresAt.toISOString() : null,
      maxConnections: info.maxConnections,
      status: info.status,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: 'iptv_health_failed', detail: message }, 502)
  }
})

type Job = {
  id: string
  state: 'running' | 'done' | 'error'
  startedAt: string
  finishedAt?: string
  result?: SyncResult
  error?: string
}
const jobs = new Map<string, Job>()
function rememberJob(job: Job): void {
  jobs.set(job.id, job)
  if (jobs.size > 20) {
    const oldest = [...jobs.keys()][0]
    jobs.delete(oldest)
  }
}

iptv.post('/admin/sync', requireAdmin, async (c) => {
  const id = randomUUID()
  const job: Job = { id, state: 'running', startedAt: new Date().toISOString() }
  rememberJob(job)
  void (async () => {
    try {
      const result = await syncOnce(iptvDb())
      job.state = 'done'
      job.result = result
      job.finishedAt = new Date().toISOString()
    } catch (err) {
      job.state = 'error'
      job.error = err instanceof Error ? err.message : String(err)
      job.finishedAt = new Date().toISOString()
    }
  })()
  return c.json({ jobId: id }, 202)
})

iptv.get('/admin/sync/:id', requireAdmin, (c) => {
  const id = c.req.param('id')
  const job = jobs.get(id)
  if (!job) return c.json({ error: 'not_found' }, 404)
  return c.json(job)
})
