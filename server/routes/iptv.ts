// IPTV (MyBunny / Xtream) router. Mounted at /api/iptv. Currently only
// exposes a health smoke endpoint that surfaces the upstream Xtream
// account's expiry, connection cap, and status — the SPA uses it to
// warn when the panel is dead or the line is exhausted before the user
// tries to start a stream.

import { Hono, type Context } from 'hono'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
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
import { epgChannelWindow, epgGrid, epgNow } from '../services/iptvEpgQuery.js'
import { signStreamToken, verifyStreamToken } from '../services/iptvStreamToken.js'
import { streamConcurrency } from '../services/iptvConcurrency.js'
import { rewriteManifest } from '../services/iptvHlsRewrite.js'
import {
  heartbeatRemuxSession,
  listRemuxSessions,
  startRemuxSession,
  stopRemuxSession,
} from '../services/iptvRemux.js'
import { env } from '../env.js'

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
const FAV_KINDS = new Set(['live', 'vod', 'series'])
const HIST_KINDS = new Set(['live', 'vod', 'series_episode'])

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

iptv.get('/epg/now', (c) => {
  const ids = (c.req.query('channelIds') ?? '')
    .split(',')
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)
  return c.json(epgNow(iptvDb(), ids))
})

iptv.get('/epg/channel/:channelId', (c) => {
  const channelId = Number(c.req.param('channelId'))
  if (!Number.isInteger(channelId) || channelId <= 0) return c.json({ error: 'invalid_id' }, 400)

  const from = c.req.query('from') ?? new Date().toISOString()
  const to = c.req.query('to') ?? new Date(Date.now() + 24 * 3600_000).toISOString()
  return c.json(epgChannelWindow(iptvDb(), channelId, from, to))
})

iptv.get('/epg/grid', (c) => {
  const from = c.req.query('from') ?? new Date().toISOString()
  const to = c.req.query('to') ?? new Date(Date.now() + 4 * 3600_000).toISOString()
  const rawCategoryId = c.req.query('categoryId')
  const categoryId = rawCategoryId != null && rawCategoryId !== '' ? Number(rawCategoryId) : undefined
  if (categoryId != null && (!Number.isInteger(categoryId) || categoryId <= 0)) {
    return c.json({ error: 'invalid_category' }, 400)
  }
  return c.json(epgGrid(iptvDb(), from, to, categoryId))
})

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

function userOf(c: Context<Env>): { sub: string } {
  const session = c.get('session')
  if (session) return { sub: session.sub }

  const user = (c.var as Record<string, unknown>).user
  if (typeof user === 'object' && user != null && 'sub' in user && typeof user.sub === 'string') {
    return { sub: user.sub }
  }
  throw new Error('missing_user')
}

function escapeM3uAttr(value: string): string {
  return value.replace(/"/g, '\'')
}

iptv.post('/playlist/token', (c) => {
  const { sub } = userOf(c)
  // 30-day TTL — long enough to drop in an external player and forget, short enough that revoking access via /api/me eventually bites.
  const ttl = 30 * 24 * 3600
  const token = signStreamToken(env.sessionSecret, {
    kind: 'playlist', resourceId: 'all', sub, ttlSecs: ttl,
  })
  const requestUrl = new URL(c.req.url)
  const host = c.req.header('host') ?? requestUrl.host
  const baseUrl = `${requestUrl.protocol}//${host}`
  return c.json({
    url: `${baseUrl}/api/iptv/playlist.m3u?t=${token}`,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  })
})

iptv.get('/playlist.m3u', (c) => {
  const t = c.req.query('t') ?? ''
  let claims: ReturnType<typeof verifyStreamToken>
  try {
    claims = verifyStreamToken(env.sessionSecret, t)
    if (claims.kind !== 'playlist') throw new Error('kind_mismatch')
  } catch (err) {
    return c.json({ error: 'invalid_token', detail: err instanceof Error ? err.message : String(err) }, 401)
  }

  const channels = iptvDb().raw
    .prepare(`SELECT stream_id, num, name, stream_icon, epg_channel_id, category_id FROM channels ORDER BY num, name`)
    .all() as Array<{ stream_id: number; num: number; name: string; stream_icon: string | null; epg_channel_id: string | null; category_id: number | null }>
  const catNames = new Map<number, string>()
  for (const row of iptvDb().raw.prepare(`SELECT category_id, name FROM categories WHERE kind='live'`).all() as Array<{ category_id: number; name: string }>) {
    catNames.set(row.category_id, row.name)
  }

  // Per-channel HMAC tokens with a long TTL too — external players cache the M3U and re-resolve URLs lazily.
  // Re-use the playlist sub for each token so revocation cascades.
  const requestUrl = new URL(c.req.url)
  const host = c.req.header('host') ?? requestUrl.host
  const baseUrl = `${requestUrl.protocol}//${host}`
  const chTtl = 30 * 24 * 3600
  const lines: string[] = ['#EXTM3U']
  for (const ch of channels) {
    const chToken = signStreamToken(env.sessionSecret, {
      kind: 'live', resourceId: String(ch.stream_id), sub: claims.sub, ttlSecs: chTtl,
    })
    const url = `${baseUrl}/api/iptv/stream/live/${ch.stream_id}.ts?t=${chToken}`
    const groupTitle = ch.category_id != null ? (catNames.get(ch.category_id) ?? 'Other') : 'Other'
    const tvgId = ch.epg_channel_id ?? ''
    const tvgLogo = ch.stream_icon ?? ''
    lines.push(`#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${escapeM3uAttr(ch.name)}" tvg-logo="${tvgLogo}" group-title="${escapeM3uAttr(groupTitle)}",${ch.name}`)
    lines.push(url)
  }
  return new Response(lines.join('\n') + '\n', {
    status: 200,
    headers: {
      'Content-Type': 'audio/x-mpegurl',
      'Content-Disposition': 'attachment; filename="theemeraldexchange.m3u"',
      'Cache-Control': 'no-store',
    },
  })
})

iptv.get('/favorites', (c) => {
  const { sub } = userOf(c)
  const rows = iptvDb().stmts.getFavorites.all(sub)
  return c.json(rows)
})

iptv.post('/favorites', async (c) => {
  const { sub } = userOf(c)
  const body = await c.req.json().catch(() => ({})) as { kind?: unknown; itemId?: unknown }
  if (typeof body.kind !== 'string' || !FAV_KINDS.has(body.kind)) return c.json({ error: 'invalid_kind' }, 400)
  if (typeof body.itemId !== 'string' || body.itemId.length === 0) return c.json({ error: 'invalid_item' }, 400)

  iptvDb().stmts.addFavorite.run({
    sub,
    kind: body.kind,
    item_id: body.itemId,
    added_ts: new Date().toISOString(),
  })
  return c.body(null, 201)
})

iptv.delete('/favorites/:kind/:itemId', (c) => {
  const { sub } = userOf(c)
  const kind = c.req.param('kind')
  const itemId = c.req.param('itemId')
  if (!FAV_KINDS.has(kind)) return c.json({ error: 'invalid_kind' }, 400)
  iptvDb().stmts.removeFavorite.run({ sub, kind, item_id: itemId })
  return c.body(null, 204)
})

function parseHistoryLimit(rawLimit: string | undefined): number {
  if (rawLimit == null || rawLimit === '') return 50
  const parsed = Number(rawLimit)
  if (!Number.isFinite(parsed)) return 50
  return Math.min(100, Math.max(1, Math.floor(parsed)))
}

iptv.get('/history', (c) => {
  const { sub } = userOf(c)
  const rows = iptvDb().stmts.getHistory.all(sub, parseHistoryLimit(c.req.query('limit')))
  return c.json(rows)
})

iptv.post('/history', async (c) => {
  const { sub } = userOf(c)
  const body = await c.req.json().catch(() => ({})) as {
    kind?: unknown
    itemId?: unknown
    positionSecs?: unknown
    durationSecs?: unknown
    completed?: unknown
  }
  if (typeof body.kind !== 'string' || !HIST_KINDS.has(body.kind)) return c.json({ error: 'invalid_kind' }, 400)
  if (typeof body.itemId !== 'string' || body.itemId.length === 0) return c.json({ error: 'invalid_item' }, 400)

  const positionSecs = Number(body.positionSecs ?? 0)
  const durationSecs = body.durationSecs == null ? null : Number(body.durationSecs)
  iptvDb().stmts.putHistory.run({
    sub,
    kind: body.kind,
    item_id: body.itemId,
    position_secs: Number.isFinite(positionSecs) ? Math.max(0, Math.floor(positionSecs)) : 0,
    duration_secs: durationSecs != null && Number.isFinite(durationSecs) ? Math.max(0, Math.floor(durationSecs)) : null,
    watched_at: new Date().toISOString(),
    completed: body.completed ? 1 : 0,
  })
  return c.body(null, 201)
})

function clientWantsAvplayer(c: Context<Env>): boolean {
  return c.req.query('client') === 'avplayer'
}

export function formatXtreamTimeshiftStart(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) throw new Error('invalid_start')
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}:${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}`
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null
  return parsed
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

iptv.post('/stream/catchup/:streamId/grant', (c) => {
  const streamId = c.req.param('streamId')
  if (!/^\d+$/.test(streamId)) return c.json({ error: 'invalid_id' }, 400)

  const startUtc = c.req.query('startUtc') ?? ''
  const durationMin = parsePositiveInt(c.req.query('durationMin') ?? '')
  const startDate = new Date(startUtc)
  if (!startUtc || Number.isNaN(startDate.getTime()) || durationMin == null) {
    return c.json({ error: 'invalid_params' }, 400)
  }

  const channel = iptvDb().raw
    .prepare(`SELECT tv_archive, tv_archive_duration FROM channels WHERE stream_id = ?`)
    .get(Number(streamId)) as { tv_archive: number; tv_archive_duration: number | null } | undefined
  if (!channel) return c.json({ error: 'not_found' }, 404)
  if (channel.tv_archive !== 1) return c.json({ error: 'catchup_unavailable' }, 400)

  const archiveCutoff = Date.now() - (channel.tv_archive_duration ?? 7) * 24 * 3600_000
  if (startDate.getTime() < archiveCutoff) return c.json({ error: 'beyond_archive_window' }, 400)

  const { sub } = userOf(c)
  const sessionId = `catchup:${streamId}:${startUtc}:${sub}:${Date.now()}`
  const acquired = streamConcurrency().tryAcquire({ sub, sessionId })
  if (!acquired.ok) return c.json(acquired, 429)

  const resourceId = `${streamId}|${startUtc}|${durationMin}`
  const token = signStreamToken(env.sessionSecret, {
    kind: 'catchup',
    resourceId,
    sub,
    ttlSecs: env.IPTV_STREAM_TOKEN_TTL_SECS,
  })

  return c.json({
    url: `/api/iptv/stream/catchup/${streamId}/${encodeURIComponent(startUtc)}/${durationMin}.ts?t=${token}`,
    delivery: 'mpegts',
    sessionId,
  })
})

function checkToken(c: Context<Env>, expectKind: string, resourceId: string): { ok: true; sub: string } | { ok: false; resp: Response } {
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

type LiveRemuxEntry = { sessionId: string; dir: string; manifestPath: string }
const liveRemuxIndex = new Map<string, LiveRemuxEntry>()

function remuxKey(streamId: string, sub: string): string {
  return `${streamId}:${sub}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRemuxSessionActive(sessionId: string): boolean {
  return listRemuxSessions().some((s) => s.sessionId === sessionId)
}

function forgetRemuxSession(key: string, sessionId: string): void {
  liveRemuxIndex.delete(key)
  stopRemuxSession(sessionId)
}

function rewriteRemuxManifest(text: string, streamId: string, sessionId: string, sub: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line || line.startsWith('#')) return line
      const segFile = path.basename(line.trim())
      if (!/^seg_\d{5}\.ts$/.test(segFile)) return line
      const token = signStreamToken(env.sessionSecret, {
        kind: 'remux',
        resourceId: `${sessionId}/${segFile}`,
        sub,
        ttlSecs: env.IPTV_STREAM_TOKEN_TTL_SECS,
      })
      return `/api/iptv/stream/live/${streamId}/remux/seg?t=${encodeURIComponent(token)}`
    })
    .join('\n')
}

function remuxSegmentResource(resourceId: string): { sessionId: string; segFile: string } | null {
  const slash = resourceId.lastIndexOf('/')
  if (slash <= 0 || slash === resourceId.length - 1) return null
  const sessionId = resourceId.slice(0, slash)
  const segFile = resourceId.slice(slash + 1)
  if (!/^seg_\d{5}\.ts$/.test(segFile)) return null
  return { sessionId, segFile }
}

async function proxyRangeable(c: Context, upstreamUrl: string, mime: string): Promise<Response> {
  const controller = new AbortController()
  c.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true })
  const headers: Record<string, string> = {}
  const range = c.req.header('range')
  if (range) headers.Range = range

  const upstream = await fetch(upstreamUrl, { signal: controller.signal, headers })
  if (!upstream.ok || !upstream.body) return c.json({ error: `upstream_${upstream.status}` }, 502)

  const responseHeaders = new Headers({
    'Content-Type': mime,
    'Cache-Control': 'no-store',
  })
  const contentLength = upstream.headers.get('content-length')
  if (contentLength) responseHeaders.set('Content-Length', contentLength)
  const contentRange = upstream.headers.get('content-range')
  if (contentRange) responseHeaders.set('Content-Range', contentRange)
  const acceptRanges = upstream.headers.get('accept-ranges')
  if (acceptRanges) responseHeaders.set('Accept-Ranges', acceptRanges)

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
}

async function rewriteHlsPlaylist(c: Context, upstreamUrl: string): Promise<Response> {
  const upstream = await fetch(upstreamUrl)
  if (!upstream.ok) return c.json({ error: `upstream_${upstream.status}` }, 502)

  const text = await upstream.text()
  const { sub } = userOf(c)
  const sign = (url: string) =>
    signStreamToken(env.sessionSecret, {
      kind: 'segment', resourceId: url, sub, ttlSecs: env.IPTV_STREAM_TOKEN_TTL_SECS,
    })
  const rewritten = rewriteManifest(text, upstreamUrl, sign, '/api/iptv/stream/segment')

  return new Response(rewritten, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store',
    },
  })
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

iptv.get('/stream/live/:streamId/remux/index.m3u8', async (c) => {
  const streamId = c.req.param('streamId')
  if (!/^\d+$/.test(streamId)) return c.json({ error: 'invalid_id' }, 400)
  const v = checkToken(c, 'remux', streamId)
  if (!v.ok) return v.resp

  const key = remuxKey(streamId, v.sub)
  let entry = liveRemuxIndex.get(key)
  if (entry && !isRemuxSessionActive(entry.sessionId)) {
    liveRemuxIndex.delete(key)
    entry = undefined
  }
  if (!entry) {
    const creds = credsFromEnv()
    const upstreamUrl = `${creds.host}/live/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${streamId}.ts`
    const session = startRemuxSession({ streamId, sub: v.sub, upstreamUrl })
    entry = { sessionId: session.sessionId, dir: session.dir, manifestPath: session.manifestPath }
    liveRemuxIndex.set(key, entry)
  }

  heartbeatRemuxSession(entry.sessionId)
  const deadline = Date.now() + 8_000
  while (!fs.existsSync(entry.manifestPath) && Date.now() < deadline) {
    await sleep(200)
    heartbeatRemuxSession(entry.sessionId)
  }
  if (!fs.existsSync(entry.manifestPath)) {
    forgetRemuxSession(key, entry.sessionId)
    return c.json({ error: 'remux_manifest_timeout' }, 504)
  }

  const rewritten = rewriteRemuxManifest(
    fs.readFileSync(entry.manifestPath, 'utf-8'),
    streamId,
    entry.sessionId,
    v.sub,
  )
  return new Response(rewritten, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store',
    },
  })
})

iptv.get('/stream/live/:streamId/remux/seg', (c) => {
  const streamId = c.req.param('streamId')
  if (!/^\d+$/.test(streamId)) return c.json({ error: 'invalid_id' }, 400)

  const t = c.req.query('t') ?? ''
  let claims: ReturnType<typeof verifyStreamToken>
  try {
    claims = verifyStreamToken(env.sessionSecret, t)
    if (claims.kind !== 'remux') throw new Error('kind_mismatch')
  } catch (err) {
    return c.json({ error: 'invalid_token', detail: err instanceof Error ? err.message : String(err) }, 401)
  }

  const resource = remuxSegmentResource(claims.resourceId)
  if (!resource) return c.json({ error: 'bad_resource' }, 400)

  const key = remuxKey(streamId, claims.sub)
  const entry = liveRemuxIndex.get(key)
  if (!entry || entry.sessionId !== resource.sessionId) return c.json({ error: 'session_gone' }, 410)
  if (!isRemuxSessionActive(entry.sessionId)) {
    liveRemuxIndex.delete(key)
    return c.json({ error: 'session_gone' }, 410)
  }

  const filePath = path.join(entry.dir, resource.segFile)
  if (!fs.existsSync(filePath)) return c.json({ error: 'segment_gone' }, 404)

  heartbeatRemuxSession(entry.sessionId)
  const stream = fs.createReadStream(filePath)
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    status: 200,
    headers: {
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'no-store',
    },
  })
})

iptv.get('/stream/catchup/:streamId/:startUtc/:durationMin.ts', async (c) => {
  const streamId = c.req.param('streamId')
  if (!/^\d+$/.test(streamId)) return c.json({ error: 'invalid_id' }, 400)

  const startUtc = decodeURIComponent(c.req.param('startUtc'))
  const rawDurationMin = (c.req.param('durationMin') ??
    (c.req.param() as Record<string, string | undefined>)['durationMin.ts'])?.replace(/\.ts$/, '')
  const durationMin = parsePositiveInt(rawDurationMin)
  if (durationMin == null) return c.json({ error: 'invalid_params' }, 400)

  let xtreamStart: string
  try {
    xtreamStart = formatXtreamTimeshiftStart(startUtc)
  } catch {
    return c.json({ error: 'invalid_params' }, 400)
  }

  const v = checkToken(c, 'catchup', `${streamId}|${startUtc}|${durationMin}`)
  if (!v.ok) return v.resp

  const creds = credsFromEnv()
  const upstreamUrl =
    `${creds.host}/streaming/timeshift.php?username=${encodeURIComponent(creds.username)}` +
    `&password=${encodeURIComponent(creds.password)}&stream=${streamId}&start=${xtreamStart}&duration=${durationMin}`

  const controller = new AbortController()
  c.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true })
  const upstream = await fetch(upstreamUrl, { signal: controller.signal })
  if (!upstream.ok || !upstream.body) return c.json({ error: `upstream_${upstream.status}` }, 502)

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'no-store',
    },
  })
})

iptv.post('/stream/vod/:streamId/grant', (c) => {
  const streamId = c.req.param('streamId')
  if (!/^\d+$/.test(streamId)) return c.json({ error: 'invalid_id' }, 400)
  const { sub } = userOf(c)
  const detail = getVodDetail(iptvDb(), Number(streamId))
  if (!detail) return c.json({ error: 'not_found' }, 404)

  const ext = (detail.container_extension ?? 'mp4').toLowerCase()
  const sessionId = `vod:${streamId}:${sub}:${Date.now()}`
  const acquired = streamConcurrency().tryAcquire({ sub, sessionId })
  if (!acquired.ok) return c.json(acquired, 429)

  const token = signStreamToken(env.sessionSecret, {
    kind: 'vod', resourceId: streamId, sub, ttlSecs: env.IPTV_STREAM_TOKEN_TTL_SECS,
  })
  const delivery: 'hls' | 'progressive' = ext === 'm3u8' ? 'hls' : 'progressive'

  return c.json({
    url: `/api/iptv/stream/vod/${streamId}/${ext}?t=${token}`,
    delivery,
    mime: delivery === 'hls' ? 'application/vnd.apple.mpegurl' : (ext === 'mkv' ? 'video/x-matroska' : 'video/mp4'),
    sessionId,
  })
})

iptv.get('/stream/vod/:streamId/:ext', async (c) => {
  const streamId = c.req.param('streamId')
  const ext = c.req.param('ext').toLowerCase()
  const v = checkToken(c, 'vod', streamId)
  if (!v.ok) return v.resp

  const creds = credsFromEnv()
  const upstreamUrl = `${creds.host}/movie/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${streamId}.${ext}`
  if (ext === 'm3u8') return await rewriteHlsPlaylist(c, upstreamUrl)

  const mime = ext === 'mkv' ? 'video/x-matroska' : 'video/mp4'
  return await proxyRangeable(c, upstreamUrl, mime)
})

iptv.post('/stream/series/:episodeId/grant', (c) => {
  const episodeId = c.req.param('episodeId')
  if (!/^[\w-]+$/.test(episodeId)) return c.json({ error: 'invalid_id' }, 400)
  const { sub } = userOf(c)
  const row = iptvDb().raw
    .prepare('SELECT container_extension FROM series_episodes WHERE episode_id = ?')
    .get(episodeId) as { container_extension: string | null } | undefined
  if (!row) return c.json({ error: 'not_found' }, 404)

  const ext = (row.container_extension ?? 'mp4').toLowerCase()
  const sessionId = `series:${episodeId}:${sub}:${Date.now()}`
  const acquired = streamConcurrency().tryAcquire({ sub, sessionId })
  if (!acquired.ok) return c.json(acquired, 429)

  const token = signStreamToken(env.sessionSecret, {
    kind: 'series', resourceId: episodeId, sub, ttlSecs: env.IPTV_STREAM_TOKEN_TTL_SECS,
  })
  const delivery: 'hls' | 'progressive' = ext === 'm3u8' ? 'hls' : 'progressive'

  return c.json({
    url: `/api/iptv/stream/series/${episodeId}/${ext}?t=${token}`,
    delivery,
    mime: delivery === 'hls' ? 'application/vnd.apple.mpegurl' : (ext === 'mkv' ? 'video/x-matroska' : 'video/mp4'),
    sessionId,
  })
})

iptv.get('/stream/series/:episodeId/:ext', async (c) => {
  const episodeId = c.req.param('episodeId')
  const ext = c.req.param('ext').toLowerCase()
  const v = checkToken(c, 'series', episodeId)
  if (!v.ok) return v.resp

  const creds = credsFromEnv()
  const upstreamUrl = `${creds.host}/series/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${episodeId}.${ext}`
  if (ext === 'm3u8') return await rewriteHlsPlaylist(c, upstreamUrl)

  const mime = ext === 'mkv' ? 'video/x-matroska' : 'video/mp4'
  return await proxyRangeable(c, upstreamUrl, mime)
})

iptv.get('/stream/segment', async (c) => {
  const t = c.req.query('u') ?? ''
  let claims: ReturnType<typeof verifyStreamToken>
  try {
    claims = verifyStreamToken(env.sessionSecret, t)
    if (claims.kind !== 'segment') throw new Error('kind_mismatch')
  } catch (err) {
    return c.json({ error: 'invalid_token', detail: err instanceof Error ? err.message : String(err) }, 401)
  }

  const upstream = claims.resourceId
  const allowedHost = new URL(credsFromEnv().host).host
  let url: URL
  try {
    url = new URL(upstream)
  } catch {
    return c.json({ error: 'bad_upstream' }, 400)
  }
  void allowedHost

  if (url.pathname.toLowerCase().endsWith('.m3u8')) {
    return await rewriteHlsPlaylist(c, upstream)
  }

  const controller = new AbortController()
  c.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true })
  const range = c.req.header('range')
  const upstreamRes = await fetch(upstream, { signal: controller.signal, headers: range ? { Range: range } : {} })
  if (!upstreamRes.ok || !upstreamRes.body) return c.json({ error: `upstream_${upstreamRes.status}` }, 502)

  const headers = new Headers()
  headers.set('Content-Type', upstreamRes.headers.get('content-type') ?? 'application/octet-stream')
  for (const h of ['content-length', 'content-range', 'accept-ranges']) {
    const v = upstreamRes.headers.get(h)
    if (v) headers.set(h, v)
  }
  headers.set('Cache-Control', 'no-store')

  return new Response(upstreamRes.body, { status: upstreamRes.status, headers })
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
