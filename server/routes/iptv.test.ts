import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'
import { openIptvDb, type IptvDb } from '../services/iptvDb.js'
import { iptv } from './iptv.js'

const dbState = vi.hoisted(() => ({
  testDb: null as IptvDb | null,
}))

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
  signStreamToken: vi.fn((_secret: string, opts: { kind: string; resourceId: string }) =>
    `fake.${opts.kind}.${Buffer.from(opts.resourceId, 'utf-8').toString('base64url')}`),
  verifyStreamToken: vi.fn((_secret: string, t: string) => {
    const match = /^fake\.([^.]+)\.(.+)$/.exec(t)
    if (match) {
      return {
        kind: match[1],
        resourceId: Buffer.from(match[2], 'base64url').toString('utf-8'),
        sub: 'plex:test',
        exp: Date.now() / 1000 + 60,
      }
    }
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

function fakeToken(kind: string, resourceId: string): string {
  return `fake.${kind}.${Buffer.from(resourceId, 'utf-8').toString('base64url')}`
}

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
    expect(body.url).toContain('/api/iptv/stream/live/10.ts?t=fake.live.MTA')
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
  iptvDb: () => {
    if (!dbState.testDb) throw new Error('test iptv db not initialized')
    return dbState.testDb
  },
  closeIptvDb: () => {
    dbState.testDb?.close()
    dbState.testDb = null
  },
}))

vi.mock('../services/iptvCatalog.js', () => ({
  listCategories: vi.fn(() => [{ category_id: 1, name: 'News', parent_id: 0 }]),
  listLive: vi.fn(() => ({ items: [{ stream_id: 10, num: 1, name: 'CNN' }], total: 1, limit: 50, offset: 0 })),
  listVod: vi.fn(() => ({ items: [{ stream_id: 20, name: 'Matrix' }], total: 1, limit: 50, offset: 0 })),
  listSeries: vi.fn(() => ({ items: [{ series_id: 30, name: 'GoT' }], total: 1, limit: 50, offset: 0 })),
  getVodDetail: vi.fn(() => ({ stream_id: 20, name: 'Matrix', container_extension: 'mp4' })),
  getSeriesDetail: vi.fn(() => ({ series_id: 30, name: 'GoT', seasons: [{ season: 1, episodes: [] }] })),
}))

beforeAll(() => {
  dbState.testDb = openIptvDb(':memory:')
  dbState.testDb.stmts.upsertSeries.run({
    series_id: 30,
    name: 'GoT',
    cover: null,
    plot: null,
    rating: null,
    category_id: null,
    tmdb_id: null,
    last_modified: null,
    fetched_at: '2026-05-24T00:00:00Z',
  })
  dbState.testDb.stmts.upsertEpisode.run({
    episode_id: 'ep-1',
    series_id: 30,
    season: 1,
    episode_num: 1,
    title: 'Pilot',
    container_extension: 'mkv',
    added_ts: null,
    plot: null,
    duration_secs: null,
  })
})

afterAll(() => {
  dbState.testDb?.close()
  dbState.testDb = null
})

describe('vod stream grant + proxy', () => {
  const app = new Hono().route('/api/iptv', iptv)

  it('issues a tokenized URL with detected ext', async () => {
    const res = await app.request('/api/iptv/stream/vod/20/grant', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string; delivery: string; mime: string }
    expect(body.url).toContain('/api/iptv/stream/vod/20/mp4?t=fake.vod.MjA')
    expect(body.delivery).toBe('progressive')
    expect(body.mime).toBe('video/mp4')
  })

  it('proxies Range requests upstream', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('abc', {
      status: 206,
      headers: {
        'content-length': '3',
        'content-range': 'bytes 0-2/10',
        'accept-ranges': 'bytes',
      },
    }))

    const res = await app.request('/api/iptv/stream/vod/20/mp4?t=fake.vod.MjA', {
      headers: { Range: 'bytes=0-2' },
    })

    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-2/10')
    expect(fetchSpy).toHaveBeenCalledWith('https://panel/movie/u/p/20.mp4', expect.objectContaining({
      headers: { Range: 'bytes=0-2' },
    }))
    fetchSpy.mockRestore()
  })

  it('rewrites HLS playlists to signed segment proxy URLs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response([
      '#EXTM3U',
      '#EXTINF:6.0,',
      'seg-001.ts',
    ].join('\n'), {
      status: 200,
      headers: { 'content-type': 'application/vnd.apple.mpegurl' },
    }))

    const res = await app.request(`/api/iptv/stream/vod/20/m3u8?t=${fakeToken('vod', '20')}`)
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledWith('https://panel/movie/u/p/20.m3u8')
    expect(text).toContain(`/api/iptv/stream/segment?u=${encodeURIComponent(fakeToken('segment', 'https://panel/movie/u/p/seg-001.ts'))}`)
    fetchSpy.mockRestore()
  })
})

describe('series stream grant', () => {
  const app = new Hono().route('/api/iptv', iptv)

  it('issues a tokenized URL with detected episode ext', async () => {
    const res = await app.request('/api/iptv/stream/series/ep-1/grant', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string; delivery: string; mime: string }
    expect(body.url).toContain('/api/iptv/stream/series/ep-1/mkv?t=fake.series.ZXAtMQ')
    expect(body.delivery).toBe('progressive')
    expect(body.mime).toBe('video/x-matroska')
  })
})

describe('segment proxy', () => {
  const app = new Hono().route('/api/iptv', iptv)

  it('passes through signed segments with Range', async () => {
    const upstreamUrl = 'https://cdn.example/foo/seg.ts'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('seg', {
      status: 206,
      headers: {
        'content-type': 'video/mp2t',
        'content-length': '3',
        'content-range': 'bytes 0-2/12',
        'accept-ranges': 'bytes',
      },
    }))

    const res = await app.request(`/api/iptv/stream/segment?u=${encodeURIComponent(fakeToken('segment', upstreamUrl))}`, {
      headers: { Range: 'bytes=0-2' },
    })

    expect(res.status).toBe(206)
    expect(res.headers.get('content-type')).toBe('video/mp2t')
    expect(res.headers.get('content-range')).toBe('bytes 0-2/12')
    expect(fetchSpy).toHaveBeenCalledWith(upstreamUrl, expect.objectContaining({
      headers: { Range: 'bytes=0-2' },
    }))
    fetchSpy.mockRestore()
  })

  it('recursively rewrites signed sub-playlists', async () => {
    const upstreamUrl = 'https://cdn.example/foo/level1.m3u8'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response([
      '#EXTM3U',
      '#EXTINF:6.0,',
      'seg.ts',
    ].join('\n'), { status: 200 }))

    const res = await app.request(`/api/iptv/stream/segment?u=${encodeURIComponent(fakeToken('segment', upstreamUrl))}`)
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledWith(upstreamUrl)
    expect(text).toContain(`/api/iptv/stream/segment?u=${encodeURIComponent(fakeToken('segment', 'https://cdn.example/foo/seg.ts'))}`)
    fetchSpy.mockRestore()
  })
})

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

describe('favorites + history', () => {
  const app = new Hono().route('/api/iptv', iptv)

  it('adds a favorite and lists it', async () => {
    const add = await app.request('/api/iptv/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'live', itemId: '10' }),
    })

    expect(add.status).toBe(201)
    const after = await (await app.request('/api/iptv/favorites')).json() as Array<{ kind: string; item_id: string }>
    expect(after).toContainEqual(expect.objectContaining({ kind: 'live', item_id: '10' }))
    await app.request('/api/iptv/favorites/live/10', { method: 'DELETE' })
  })

  it('removes a favorite and excludes it from the list', async () => {
    await app.request('/api/iptv/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'live', itemId: '10' }),
    })

    const del = await app.request('/api/iptv/favorites/live/10', { method: 'DELETE' })
    expect(del.status).toBe(204)

    const empty = await (await app.request('/api/iptv/favorites')).json()
    expect(empty).toEqual([])
  })

  it('records and reads history with the reported position', async () => {
    const put = await app.request('/api/iptv/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'vod', itemId: '20', positionSecs: 90, durationSecs: 7200, completed: false }),
    })

    expect(put.status).toBe(201)
    const hist = await (await app.request('/api/iptv/history?limit=10')).json() as Array<{
      kind: string
      item_id: string
      position_secs: number
      completed: number
    }>
    expect(hist[0]).toMatchObject({ kind: 'vod', item_id: '20', position_secs: 90, completed: 0 })
  })
})
