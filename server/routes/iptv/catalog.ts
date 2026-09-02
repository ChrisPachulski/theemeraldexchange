// /api/iptv catalog routes, split from the former single iptv.ts (paths unchanged).

import { Hono } from 'hono'
import { type Context } from 'hono'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { requireAuth, type Env } from '../../middleware/auth.js'
import { rateLimit } from '../../middleware/rateLimit.js'
import { requireSection } from '../../services/userPolicies.js'
import { getAccountInfo } from '../../services/xtream.js'
import { iptvDb } from '../../services/iptvDbSingleton.js'
import { listCategories, listLive, listVod, listSeries, getVodDetail, getSeriesDetail } from '../../services/iptvCatalog.js'
import { epgChannelWindow, epgGrid, epgNow, epgSearch } from '../../services/iptvEpgQuery.js'
import { KINDS } from './shared.js'

export const iptv = new Hono<Env>()


// Async gzip so a ~28 MB EPG-grid compression runs on the libuv threadpool
// instead of blocking the event loop (and every other in-flight request) for
// the full synchronous compress.
const gzipAsync = promisify(gzip)
iptv.get('/health', requireAuth, async (c) => {
  try {
    const info = await getAccountInfo()
    return c.json({
      expiresAt: info.expiresAt ? info.expiresAt.toISOString() : null,
      maxConnections: info.maxConnections,
      activeConnections: info.activeConnections,
      status: info.status,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: 'iptv_health_failed', detail: message }, 502)
  }
})

// Catalog + EPG browse. Every route below carries requireSection('live') for
// the same reason the grants and the DVR listings do: the whole IPTV surface
// (live channels, provider VOD/series, and the guide) IS the `live` section, so
// a member whose policy denies Live TV must not be able to browse it either.
// Hiding it client-side is not enforcement — without this, a denied member (or
// a tampered client) still got the full catalog and guide from these GETs.
iptv.get('/categories', requireAuth, requireSection('live'), (c) => {
  const kind = c.req.query('kind') ?? ''
  if (!KINDS.has(kind)) return c.json({ error: 'invalid_kind' }, 400)
  return c.json(listCategories(iptvDb(), kind as 'live' | 'vod' | 'series'))
})

function intOrUndef(s: string | undefined): number | undefined {
  if (s == null || s === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}

function parseListOpts(c: Context<Env>): { categoryId?: number; q?: string; limit?: number; offset?: number } {
  return {
    categoryId: intOrUndef(c.req.query('categoryId')),
    q: c.req.query('q') ?? undefined,
    limit: intOrUndef(c.req.query('limit')),
    offset: intOrUndef(c.req.query('offset')),
  }
}

iptv.get('/live', requireAuth, requireSection('live'), (c) => c.json(listLive(iptvDb(), parseListOpts(c))))
iptv.get('/vod', requireAuth, requireSection('live'), (c) => c.json(listVod(iptvDb(), parseListOpts(c))))
iptv.get('/series', requireAuth, requireSection('live'), (c) => c.json(listSeries(iptvDb(), parseListOpts(c))))

iptv.get('/epg/now', requireAuth, requireSection('live'), (c) => {
  const ids = (c.req.query('channelIds') ?? '')
    .split(',')
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)
  return c.json(epgNow(iptvDb(), ids))
})

iptv.get('/epg/channel/:channelId', requireAuth, requireSection('live'), (c) => {
  const channelId = Number(c.req.param('channelId'))
  if (!Number.isInteger(channelId) || channelId <= 0) return c.json({ error: 'invalid_id' }, 400)

  const from = c.req.query('from') ?? new Date().toISOString()
  const to = c.req.query('to') ?? new Date(Date.now() + 24 * 3600_000).toISOString()
  return c.json(epgChannelWindow(iptvDb(), channelId, from, to))
})

iptv.get('/epg/grid', requireAuth, requireSection('live'), async (c) => {
  const from = c.req.query('from') ?? new Date().toISOString()
  const to = c.req.query('to') ?? new Date(Date.now() + 4 * 3600_000).toISOString()
  const rawCategoryId = c.req.query('categoryId')
  const categoryId = rawCategoryId != null && rawCategoryId !== '' ? Number(rawCategoryId) : undefined
  if (categoryId != null && (!Number.isInteger(categoryId) || categoryId <= 0)) {
    return c.json({ error: 'invalid_category' }, 400)
  }
  // Multi-category filter (e.g. the tvOS guide's curated US+sports set). CSV of
  // ids; drop anything non-positive, cap the count so the IN-list can't blow up.
  const rawCategoryIds = c.req.query('categoryIds')
  const categoryIds = rawCategoryIds
    ? rawCategoryIds.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500)
    : undefined
  const rawQ = c.req.query('q')
  const q = rawQ && rawQ.trim() ? rawQ.trim().slice(0, 100) : undefined
  const hasEpgOnly = c.req.query('hasEpg') === '1' || c.req.query('hasEpg') === 'true'
  // Channel cap. Native clients (tvOS especially) OOM on the full ~17k-channel
  // has-EPG set — a 40 MB payload that decodes to GBs of objects. They send
  // `limit` to bound it; the web client virtualizes and omits it for the full grid.
  const rawLimit = c.req.query('limit')
  const limit = rawLimit != null && rawLimit !== '' ? Number(rawLimit) : undefined
  if (limit != null && (!Number.isInteger(limit) || limit <= 0)) {
    return c.json({ error: 'invalid_limit' }, 400)
  }
  const json = JSON.stringify(epgGrid(iptvDb(), from, to, { categoryId, categoryIds, q, hasEpgOnly, limit }))
  // The full has-EPG guide is ~28 MB of JSON (~14k channels x ~7 programmes).
  // gzip it (~12x → ~2 MB) so the client isn't pulling tens of MB on every
  // 30-min window refetch. Done inline (not as global middleware) so the
  // /stream/* video-proxy endpoints are never wrapped in compression. Browsers
  // always send Accept-Encoding: gzip and inflate transparently; fall back to
  // plain JSON for clients that don't, or for small bodies.
  const acceptsGzip = (c.req.header('accept-encoding') ?? '').toLowerCase().includes('gzip')
  if (acceptsGzip && json.length > 64 * 1024) {
    return c.body(await gzipAsync(json), 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
      Vary: 'Accept-Encoding',
    })
  }
  return c.body(json, 200, { 'Content-Type': 'application/json; charset=utf-8' })
})

// Programme search materializes a match set from the WHOLE EPG store, and once
// the client wires per-keystroke search it fires in bursts. Cap it per-caller so
// a scripted authed user (or a keystroke storm) can't pin the event loop with
// back-to-back scans — the same 429 backstop the *arr mutate routes carry.
// Literal 10 req/s config: this is a read, not an indexer-budget burn, so it
// needs no operator knob.
const epgSearchRateLimit = rateLimit({
  name: 'iptv-epg-search',
  capacity: 10,
  refill: 10,
  intervalMs: 1000,
})

// Server-side programme search over the ENTIRE synced EPG store — not just the
// warm channels the tvOS guide pre-fetches. Replaces the client-side scan seam
// (EmeraldKit EpgSearch.programHits, capped to CatalogStore.guideChannelLimit),
// so searching 'Yankees' / 'news' now reaches every channel's schedule without
// shipping the full ~28 MB grid to a memory-constrained device. Query parsing
// (q slice, categoryIds cap-500) + gzip mirror /epg/grid above.
iptv.get('/epg/search', requireAuth, requireSection('live'), epgSearchRateLimit, async (c) => {
  const rawQ = c.req.query('q')
  const q = rawQ && rawQ.trim() ? rawQ.trim().slice(0, 100) : undefined
  if (!q) return c.json({ error: 'invalid_query' }, 400)
  // A 1-char query matches nearly every programme (q='e'), degrading the SQL
  // LIKE into a whole-store scan; require >=2 chars so the filter narrows.
  if (q.length < 2) return c.json({ error: 'invalid_query' }, 400)

  const from = c.req.query('from') ?? new Date().toISOString()
  const to = c.req.query('to') ?? new Date(Date.now() + 4 * 3600_000).toISOString()

  const rawCategoryIds = c.req.query('categoryIds')
  const categoryIds = rawCategoryIds
    ? rawCategoryIds.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500)
    : undefined

  const rawLimit = c.req.query('limit')
  const limit = rawLimit != null && rawLimit !== '' ? Number(rawLimit) : undefined
  if (limit != null && (!Number.isInteger(limit) || limit <= 0)) {
    return c.json({ error: 'invalid_limit' }, 400)
  }

  const json = JSON.stringify(epgSearch(iptvDb(), from, to, { q, categoryIds, limit }))
  const acceptsGzip = (c.req.header('accept-encoding') ?? '').toLowerCase().includes('gzip')
  if (acceptsGzip && json.length > 64 * 1024) {
    return c.body(await gzipAsync(json), 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
      Vary: 'Accept-Encoding',
    })
  }
  return c.body(json, 200, { 'Content-Type': 'application/json; charset=utf-8' })
})

iptv.get('/vod/:streamId', requireAuth, requireSection('live'), (c) => {
  const id = Number(c.req.param('streamId'))
  if (!Number.isFinite(id)) return c.json({ error: 'invalid_id' }, 400)
  const detail = getVodDetail(iptvDb(), id)
  return detail ? c.json(detail) : c.json({ error: 'not_found' }, 404)
})

iptv.get('/series/:seriesId', requireAuth, requireSection('live'), (c) => {
  const id = Number(c.req.param('seriesId'))
  if (!Number.isFinite(id)) return c.json({ error: 'invalid_id' }, 400)
  const detail = getSeriesDetail(iptvDb(), id)
  return detail ? c.json(detail) : c.json({ error: 'not_found' }, 404)
})
