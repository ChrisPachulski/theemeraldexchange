import { describe, it, expect, vi } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'
import { iptv } from './iptv.js'

type TestAuthEnv = {
  Variables: {
    user: { sub: string; role: string; displayName: string }
  }
}

vi.mock('../middleware/auth.js', async () => {
  const requireTestAuth: MiddlewareHandler<TestAuthEnv> = async (c, next) => {
    c.set('user', { sub: 'plex:test', role: 'admin', displayName: 'Test' })
    await next()
  }
  return {
    requireAuth: requireTestAuth,
    requireAdmin: requireTestAuth,
  }
})

vi.mock('../services/xtream.js', () => ({
  getAccountInfo: vi.fn(async () => ({
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    maxConnections: 4,
    status: 'Active',
  })),
  credsFromEnv: vi.fn(() => ({ host: 'https://panel', username: 'u', password: 'p' })),
}))

vi.mock('../services/iptvStreamToken.js', () => ({
  signStreamToken: vi.fn(() => 'fake.token'),
  verifyStreamToken: vi.fn((_secret: string, t: string) => {
    if (t === 'fake.token') return { kind: 'live', resourceId: '10', sub: 'plex:test', exp: Date.now() / 1000 + 60 }
    throw new Error('invalid_signature')
  }),
}))

vi.mock('../services/iptvConcurrency.js', () => ({
  streamConcurrency: vi.fn(() => ({
    tryAcquire: vi.fn(({ sessionId }: { sessionId: string }) => ({ ok: true, sessionId })),
    heartbeat: vi.fn(),
    release: vi.fn(),
    sweep: vi.fn(),
    size: vi.fn(() => 0),
  })),
}))

describe('GET /api/iptv/health', () => {
  it('returns account info shape', async () => {
    const app = new Hono().route('/api/iptv', iptv)
    const res = await app.request('/api/iptv/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      expiresAt: string | null
      maxConnections: number
      status: string
    }
    expect(body.maxConnections).toBe(4)
    expect(body.status).toBe('Active')
    expect(typeof body.expiresAt).toBe('string')
  })
})

describe('live stream grant + proxy', () => {
  const app = new Hono().route('/api/iptv', iptv)

  it('issues a tokenized URL on POST /stream/live/:id/grant', async () => {
    const res = await app.request('/api/iptv/stream/live/10/grant', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { url: string; delivery: string }
    expect(body.url).toContain('/api/iptv/stream/live/10.ts?t=fake.token')
    expect(body.delivery).toBe('mpegts')
  })

  it('rejects bad tokens on the .ts endpoint', async () => {
    const res = await app.request('/api/iptv/stream/live/10.ts?t=bogus')
    expect(res.status).toBe(401)
  })
})

vi.mock('../services/iptvSync.js', () => ({
  syncOnce: vi.fn(async () => ({
    busy: false, channels: 10, vod: 20, series: 5, episodes: 50, epg: 100, categories: 6,
    startedAt: '2026-05-24T00:00:00Z', finishedAt: '2026-05-24T00:00:30Z', durationMs: 30000,
  })),
}))
vi.mock('../services/iptvDbSingleton.js', () => ({
  iptvDb: () => ({ raw: { prepare: () => ({ all: () => [], get: () => undefined, run: () => undefined }) }, stmts: {} }),
  closeIptvDb: () => undefined,
}))

vi.mock('../services/iptvCatalog.js', () => ({
  listCategories: vi.fn(() => [{ category_id: 1, name: 'News', parent_id: 0 }]),
  listLive: vi.fn(() => ({ items: [{ stream_id: 10, num: 1, name: 'CNN' }], total: 1, limit: 50, offset: 0 })),
  listVod: vi.fn(() => ({ items: [{ stream_id: 20, name: 'Matrix' }], total: 1, limit: 50, offset: 0 })),
  listSeries: vi.fn(() => ({ items: [{ series_id: 30, name: 'GoT' }], total: 1, limit: 50, offset: 0 })),
  getVodDetail: vi.fn(() => ({ stream_id: 20, name: 'Matrix' })),
  getSeriesDetail: vi.fn(() => ({ series_id: 30, name: 'GoT', seasons: [{ season: 1, episodes: [] }] })),
}))

describe('POST /api/iptv/admin/sync', () => {
  it('returns a job id and final stats', async () => {
    const app = new Hono().route('/api/iptv', iptv)
    const res = await app.request('/api/iptv/admin/sync', { method: 'POST' })
    expect(res.status).toBe(202)
    const body = await res.json() as { jobId: string }
    expect(typeof body.jobId).toBe('string')
  })

  it('GET /admin/sync/:id reports completed stats', async () => {
    const app = new Hono().route('/api/iptv', iptv)
    const start = await app.request('/api/iptv/admin/sync', { method: 'POST' })
    const { jobId } = await start.json() as { jobId: string }
    await new Promise(r => setTimeout(r, 30))
    const status = await app.request(`/api/iptv/admin/sync/${jobId}`)
    expect(status.status).toBe(200)
    const body = await status.json() as { state: string; result?: { channels: number } }
    expect(body.state).toBe('done')
    expect(body.result?.channels).toBe(10)
  })
})

describe('catalog read routes', () => {
  const app = new Hono().route('/api/iptv', iptv)
  it('lists categories by kind', async () => {
    const res = await app.request('/api/iptv/categories?kind=live')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ name: string }>
    expect(body[0].name).toBe('News')
  })
  it('rejects unknown kind', async () => {
    const res = await app.request('/api/iptv/categories?kind=music')
    expect(res.status).toBe(400)
  })
  it('lists live channels with query params', async () => {
    const res = await app.request('/api/iptv/live?q=cnn&limit=10')
    const body = (await res.json()) as { total: number }
    expect(body.total).toBe(1)
  })
  it('returns vod detail or 404', async () => {
    const res = await app.request('/api/iptv/vod/20')
    expect(res.status).toBe(200)
  })
  it('returns series detail', async () => {
    const res = await app.request('/api/iptv/series/30')
    const body = (await res.json()) as { name: string }
    expect(body.name).toBe('GoT')
  })
})
