// /api/iptv admin routes, split from the former single iptv.ts (paths unchanged).

import { Hono } from 'hono'
import { requireAuth, requireAdmin } from '../../middleware/auth.js'
import { iptvDb } from '../../services/iptvDbSingleton.js'
import { getSyncJob, startSyncJob } from '../../services/iptvSyncJobs.js'
import { env } from '../../env.js'
import { type Env } from '../../middleware/auth.js'
import { secretsEqual } from './shared.js'

export const iptv = new Hono<Env>()

iptv.get('/export/recommender', (c) => {
  const secret = c.req.header('x-iptv-export-secret') ?? ''
  if (!env.IPTV_RECOMMENDER_EXPORT_SECRET || !secretsEqual(secret, env.IPTV_RECOMMENDER_EXPORT_SECRET)) {
    return c.json({ error: 'forbidden' }, 403)
  }

  const db = iptvDb()
  const vod = db.raw.prepare(`
    SELECT stream_id AS id,
           name AS title,
           year,
           plot AS overview,
           director,
           cast_csv AS cast,
           tmdb_id,
           rating,
           stream_icon AS poster_path
    FROM vod
  `).all()
  const series = db.raw.prepare(`
    SELECT series_id AS id,
           name AS title,
           plot AS overview,
           cover AS poster_path,
           tmdb_id,
           rating
    FROM series
  `).all()

  return c.json({ vod, series })
})

// Background sync job lifecycle (start / poll / eviction) lives in
// services/iptvSyncJobs.ts.
iptv.post('/admin/sync', requireAuth, requireAdmin, (c) => {
  return c.json({ jobId: startSyncJob() }, 202)
})

iptv.get('/admin/sync/:id', requireAuth, requireAdmin, (c) => {
  const job = getSyncJob(c.req.param('id'))
  if (!job) return c.json({ error: 'not_found' }, 404)
  return c.json(job)
})
