// IPTV (MyBunny / Xtream) router. Mounted at /api/iptv. Currently only
// exposes a health smoke endpoint that surfaces the upstream Xtream
// account's expiry, connection cap, and status — the SPA uses it to
// warn when the panel is dead or the line is exhausted before the user
// tries to start a stream.

import { Hono, type Context } from 'hono'
import { requireAuth, requireAdmin, type Env } from '../middleware/auth.js'
import { getAccountInfo, credsFromEnv } from '../services/xtream.js'
import { syncOnce, type SyncResult } from '../services/iptvSync.js'
import { iptvDb } from '../services/iptvDbSingleton.js'
import {
  listCategories,
  listLive,
  listVod,
  listSeries,
  getVodDetail,
  getSeriesDetail,
} from '../services/iptvCatalog.js'
import { signStreamToken, verifyStreamToken } from '../services/iptvStreamToken.js'
import { streamConcurrency } from '../services/iptvConcurrency.js'
import { env } from '../env.js'
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

const KINDS = new Set(['live', 'vod', 'series'])

iptv.get('/categories', (c) => {
  const kind = c.req.query('kind') ?? ''
  if (!KINDS.has(kind)) return c.json({ error: 'invalid_kind' }, 400)
  return c.json(listCategories(iptvDb(), kind as 'live' | 'vod' | 'series'))
})

function parseListOpts(c: Context<Env>): { categoryId?: number; q?: string; limit?: number; offset?: number } {
  const cat = c.req.query('categoryId')
  return {
    categoryId: cat != null && cat !== '' ? Number(cat) : undefined,
    q: c.req.query('q') ?? undefined,
    limit: c.req.query('limit') != null ? Number(c.req.query('limit')) : undefined,
    offset: c.req.query('offset') != null ? Number(c.req.query('offset')) : undefined,
  }
}

iptv.get('/live', (c) => c.json(listLive(iptvDb(), parseListOpts(c))))
iptv.get('/vod', (c) => c.json(listVod(iptvDb(), parseListOpts(c))))
iptv.get('/series', (c) => c.json(listSeries(iptvDb(), parseListOpts(c))))

iptv.get('/vod/:streamId', (c) => {
  const id = Number(c.req.param('streamId'))
  if (!Number.isFinite(id)) return c.json({ error: 'invalid_id' }, 400)
  const detail = getVodDetail(iptvDb(), id)
  return detail ? c.json(detail) : c.json({ error: 'not_found' }, 404)
})

iptv.get('/series/:seriesId', (c) => {
  const id = Number(c.req.param('seriesId'))
  if (!Number.isFinite(id)) return c.json({ error: 'invalid_id' }, 400)
  const detail = getSeriesDetail(iptvDb(), id)
  return detail ? c.json(detail) : c.json({ error: 'not_found' }, 404)
})

function userOf(c: any): { sub: string } {
  // sessionGate sets `user` in the request context — read it.
  const u = c.get('user') as { sub: string } | undefined
  if (!u) throw new Error('missing_user')
  return u
}

function clientWantsAvplayer(c: any): boolean {
  return c.req.query('client') === 'avplayer'
}

iptv.post('/stream/live/:streamId/grant', (c) => {
  const streamId = c.req.param('streamId')
  if (!/^\d+$/.test(streamId)) return c.json({ error: 'invalid_id' }, 400)
  const { sub } = userOf(c)
  const sessionId = `live:${streamId}:${sub}:${Date.now()}`
  const acquired = streamConcurrency().tryAcquire({ sub, sessionId })
  if (!acquired.ok) return c.json(acquired, 429)

  if (clientWantsAvplayer(c)) {
    const token = signStreamToken(env.sessionSecret, {
      kind: 'remux', resourceId: streamId, sub, ttlSecs: env.IPTV_STREAM_TOKEN_TTL_SECS,
    })
    return c.json({
      url: `/api/iptv/stream/live/${streamId}/remux/index.m3u8?t=${token}`,
      delivery: 'hls', sessionId,
    })
  }

  const token = signStreamToken(env.sessionSecret, {
    kind: 'live', resourceId: streamId, sub, ttlSecs: env.IPTV_STREAM_TOKEN_TTL_SECS,
  })
  return c.json({
    url: `/api/iptv/stream/live/${streamId}.ts?t=${token}`,
    delivery: 'mpegts', sessionId,
  })
})

function checkToken(c: any, expectKind: string, resourceId: string): { ok: true; sub: string } | { ok: false; resp: Response } {
  const t = c.req.query('t') ?? ''
  try {
    const claims = verifyStreamToken(env.sessionSecret, t)
    if (claims.kind !== expectKind || claims.resourceId !== resourceId) {
      return { ok: false, resp: c.json({ error: 'token_mismatch' }, 401) }
    }
    return { ok: true, sub: claims.sub }
  } catch (err) {
    return { ok: false, resp: c.json({ error: 'invalid_token', detail: err instanceof Error ? err.message : String(err) }, 401) }
  }
}

iptv.get('/stream/live/:streamId.ts', async (c) => {
  const rawStreamId = c.req.param('streamId') ?? (c.req.param() as Record<string, string | undefined>)['streamId.ts']?.replace(/\.ts$/, '')
  const streamId = rawStreamId
  if (!streamId) return c.json({ error: 'invalid_id' }, 400)
  const v = checkToken(c, 'live', streamId)
  if (!v.ok) return v.resp
  const creds = credsFromEnv()
  const upstreamUrl = `${creds.host}/live/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${streamId}.ts`

  const controller = new AbortController()
  c.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true })

  const upstream = await fetch(upstreamUrl, {
    signal: controller.signal,
    headers: { 'User-Agent': 'IPTVSmarters' },
  })
  if (!upstream.ok || !upstream.body) {
    return c.json({ error: `upstream_${upstream.status}` }, 502)
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'no-store',
    },
  })
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
