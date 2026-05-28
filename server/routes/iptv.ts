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
import { signStreamToken, verifyStreamToken, verifyStreamTokenDualKey, type StreamKind } from '../services/iptvStreamToken.js'
import { checkReplay } from '../services/tokenReplayCache.js'
import { tryNormaliseLegacySub } from '../services/sub.js'
import { resolveSourcePrecedence } from '../services/sourcePrecedence.js'
import { streamConcurrency, type SessionView, type SessionKind } from '../services/iptvConcurrency.js'
import { rewriteManifest } from '../services/iptvHlsRewrite.js'
import {
  heartbeatRemuxSession,
  listRemuxSessions,
  startRemuxSession,
  stopRemuxSession,
} from '../services/iptvRemux.js'
import { env } from '../env.js'

export const iptv = new Hono<Env>()

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

// Best-effort client IP. Cloudflare Tunnel terminates TLS at the edge
// and forwards the original visitor IP in CF-Connecting-IP. X-Forwarded-For
// is the fallback for non-CF deploys. Used to label active sessions so the
// user can tell "the browser I'm sitting at" from "that phone in the
// kitchen" when deciding which slot to free.
function clientIp(c: Context<Env>): string | null {
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    null
  )
}

// Title resolver for the sessions widget. Called only when listing — keeps
// the tracker itself ignorant of catalog schema. Tolerant of missing rows
// (cleaned catalog, deleted item) by returning null so the UI just shows
// the resourceId.
function sessionTitle(kind: SessionKind, resourceId: string): string | null {
  const db = iptvDb().raw
  try {
    if (kind === 'live' || kind === 'remux') {
      const row = db
        .prepare('SELECT name FROM channels WHERE stream_id = ?')
        .get(Number(resourceId)) as { name: string } | undefined
      return row?.name ?? null
    }
    if (kind === 'vod') {
      const row = db
        .prepare('SELECT name FROM vod WHERE stream_id = ?')
        .get(Number(resourceId)) as { name: string } | undefined
      return row?.name ?? null
    }
    if (kind === 'series') {
      const row = db
        .prepare('SELECT title, series_id FROM series_episodes WHERE episode_id = ?')
        .get(resourceId) as { title: string | null; series_id: number } | undefined
      if (!row) return null
      const series = db
        .prepare('SELECT name FROM series WHERE series_id = ?')
        .get(row.series_id) as { name: string } | undefined
      return series ? `${series.name}${row.title ? ` — ${row.title}` : ''}` : row.title
    }
    if (kind === 'catchup') {
      // catchup resourceId encoded as streamId|startUtc|durationMin
      const sid = Number(resourceId.split('|')[0])
      const row = db
        .prepare('SELECT name FROM channels WHERE stream_id = ?')
        .get(sid) as { name: string } | undefined
      return row?.name ?? null
    }
  } catch {
    return null
  }
  return null
}

function enrichSessions(list: SessionView[]): Array<SessionView & { resolvedTitle: string | null }> {
  return list.map((s) => ({ ...s, resolvedTitle: s.title ?? sessionTitle(s.kind, s.resourceId) }))
}

// Connection diagnostics: surface our concurrency tracker + the upstream's
// own active_cons/max_connections counters so the SPA can show "1 of 2
// slots in use" and let the user kick whichever of OUR sessions is holding
// a slot. Doesn't (and can't) kick sessions from other IPTV apps using the
// same mybunny credentials directly — those are invisible to us. UI should
// explain that distinction.
iptv.get('/sessions', requireAuth, async (c) => {
  const { sub } = userOf(c)
  const ours = enrichSessions(streamConcurrency().list())
  let upstream: { activeConnections: number; maxConnections: number; status: string } | null
  try {
    const info = await getAccountInfo()
    upstream = {
      activeConnections: info.activeConnections,
      maxConnections: info.maxConnections,
      status: info.status,
    }
  } catch {
    // Upstream probe failures shouldn't block the local sessions list —
    // they're the more interesting half anyway.
    upstream = null
  }
  return c.json({
    self: sub,
    upstream,
    ours,
  })
})

// Force-release. Admins can release any session; everyone else only their
// own. We trust sessionId to be opaque, so no admin can stomp anonymous
// sessions by guessing IDs — the session must exist.
iptv.delete('/sessions/:sessionId', requireAuth, (c) => {
  const sessionId = c.req.param('sessionId')
  const { sub } = userOf(c)
  const isAdmin = ((c.var as Record<string, unknown>).user as { role?: string } | undefined)?.role === 'admin'
  const all = streamConcurrency().list()
  const target = all.find((s) => s.sessionId === sessionId)
  if (!target) return c.json({ error: 'not_found' }, 404)
  if (!isAdmin && target.sub !== sub) return c.json({ error: 'forbidden' }, 403)
  streamConcurrency().release(sessionId)
  return c.json({ ok: true, released: sessionId })
})

const KINDS = new Set(['live', 'vod', 'series'])
const FAV_KINDS = new Set(['live', 'vod', 'series'])
const HIST_KINDS = new Set(['live', 'vod', 'series_episode'])

iptv.get('/categories', requireAuth, (c) => {
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

iptv.get('/live', requireAuth, (c) => c.json(listLive(iptvDb(), parseListOpts(c))))
iptv.get('/vod', requireAuth, (c) => c.json(listVod(iptvDb(), parseListOpts(c))))
iptv.get('/series', requireAuth, (c) => c.json(listSeries(iptvDb(), parseListOpts(c))))

iptv.get('/epg/now', requireAuth, (c) => {
  const ids = (c.req.query('channelIds') ?? '')
    .split(',')
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)
  return c.json(epgNow(iptvDb(), ids))
})

iptv.get('/epg/channel/:channelId', requireAuth, (c) => {
  const channelId = Number(c.req.param('channelId'))
  if (!Number.isInteger(channelId) || channelId <= 0) return c.json({ error: 'invalid_id' }, 400)

  const from = c.req.query('from') ?? new Date().toISOString()
  const to = c.req.query('to') ?? new Date(Date.now() + 24 * 3600_000).toISOString()
  return c.json(epgChannelWindow(iptvDb(), channelId, from, to))
})

iptv.get('/epg/grid', requireAuth, (c) => {
  const from = c.req.query('from') ?? new Date().toISOString()
  const to = c.req.query('to') ?? new Date(Date.now() + 4 * 3600_000).toISOString()
  const rawCategoryId = c.req.query('categoryId')
  const categoryId = rawCategoryId != null && rawCategoryId !== '' ? Number(rawCategoryId) : undefined
  if (categoryId != null && (!Number.isInteger(categoryId) || categoryId <= 0)) {
    return c.json({ error: 'invalid_category' }, 400)
  }
  return c.json(epgGrid(iptvDb(), from, to, categoryId))
})

iptv.get('/vod/:streamId', requireAuth, (c) => {
  const id = Number(c.req.param('streamId'))
  if (!Number.isFinite(id)) return c.json({ error: 'invalid_id' }, 400)
  const detail = getVodDetail(iptvDb(), id)
  return detail ? c.json(detail) : c.json({ error: 'not_found' }, 404)
})

iptv.get('/series/:seriesId', requireAuth, (c) => {
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

iptv.post('/playlist/token', requireAuth, async (c) => {
  const { sub } = userOf(c)
  // Optional device label — free-form string, max 120 chars. Returned in the
  // response so the admin list can show "iPhone 15 (kitchen)" next to the jti.
  const body = await c.req.json().catch(() => ({})) as { deviceName?: unknown }
  const deviceName = typeof body.deviceName === 'string'
    ? body.deviceName.trim().slice(0, 120)
    : undefined
  // 90-day TTL per §5.6 / D12. M1 used 30 days; updated to contract value.
  const ttl = 90 * 24 * 3600
  const jti = randomUUID()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttl * 1000)
  const token = signStreamToken(env.streamTokenSecret, {
    kind: 'playlist', resourceId: 'iptv-channels-all', sub, ttlSecs: ttl, jti,
  })
  // Persist the token row so the verifier can check revocation (§6.2).
  iptvDb().stmts.insertPlaylistToken.run({
    jti,
    sub,
    device_name: deviceName ?? null,
    issued_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  })
  const requestUrl = new URL(c.req.url)
  const host = c.req.header('host') ?? requestUrl.host
  const baseUrl = `${requestUrl.protocol}//${host}`
  return c.json({
    jti,
    deviceName: deviceName ?? null,
    url: `${baseUrl}/api/iptv/playlist.m3u?t=${token}`,
    expiresAt: expiresAt.toISOString(),
  })
})

// Hit by external players (VLC, iPlayTV, TiviMate) that have no session
// cookie. Token-in-URL is the auth; see comment on /stream/live/:id.ts.
iptv.get('/playlist.m3u', (c) => {
  const t = c.req.query('t') ?? ''
  let claims: ReturnType<typeof verifyStreamToken>
  try {
    claims = verifyStreamTokenDualKey(env.streamTokenSecret, env.sessionSecret, t)
    if (claims.k !== 'playlist') throw new Error('kind_mismatch')
    // §16 D-row: canonical rid is 'iptv-channels-all'. M1-era tokens
    // carry 'all'. Both are accepted during the D2a secret-migration window
    // (90-day expiry window). Once all M1 tokens have expired naturally this
    // fallback can be dropped.
    if (claims.rid !== 'iptv-channels-all' && claims.rid !== 'all') {
      throw new Error('resource_mismatch')
    }
  } catch (err) {
    return c.json({ error: 'invalid_token', detail: err instanceof Error ? err.message : String(err) }, 401)
  }

  // Persistent revocation check (§6.2 / D12). Tokens issued by D12+ carry a
  // jti claim that maps to a row in iptv_playlist_tokens. A revoked_at IS NOT
  // NULL row is a hard reject regardless of the HMAC signature being valid.
  // M1-era tokens without jti bypass this check (they will expire naturally;
  // D2b removes the fallback path once the 90-day window closes).
  if (claims.jti != null) {
    const row = iptvDb().stmts.getPlaylistToken.get(claims.jti) as
      | { jti: string; sub: string; issued_at: string; expires_at: string; revoked_at: string | null }
      | undefined
    if (!row) {
      return c.json({ error: 'token_not_found' }, 401)
    }
    if (row.revoked_at != null) {
      return c.json({ error: 'token_revoked' }, 401)
    }
  }

  const channels = iptvDb().raw
    .prepare(`SELECT stream_id, num, name, stream_icon, epg_channel_id, category_id FROM channels ORDER BY num, name`)
    .all() as Array<{ stream_id: number; num: number; name: string; stream_icon: string | null; epg_channel_id: string | null; category_id: number | null }>
  const catNames = new Map<number, string>()
  for (const row of iptvDb().raw.prepare(`SELECT category_id, name FROM categories WHERE kind='live'`).all() as Array<{ category_id: number; name: string }>) {
    catNames.set(row.category_id, row.name)
  }

  // Per-channel segment grants: 300-second TTL per §5.6 / D12.
  // M1 used 30 days here; that was wrong — external players re-fetch the M3U
  // frequently enough that 300 s is fine, and shorter TTL limits credential
  // exposure if the M3U body leaks.
  const requestUrl = new URL(c.req.url)
  const host = c.req.header('host') ?? requestUrl.host
  const baseUrl = `${requestUrl.protocol}//${host}`
  const chTtl = 300
  const lines: string[] = ['#EXTM3U']
  for (const ch of channels) {
    const chToken = signStreamToken(env.streamTokenSecret, {
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

iptv.get('/favorites', requireAuth, (c) => {
  const { sub } = userOf(c)
  const rows = iptvDb().stmts.getFavorites.all(sub)
  return c.json(rows)
})

iptv.post('/favorites', requireAuth, async (c) => {
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

iptv.delete('/favorites/:kind/:itemId', requireAuth, (c) => {
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

iptv.get('/history', requireAuth, (c) => {
  const { sub } = userOf(c)
  const rows = iptvDb().stmts.getHistory.all(sub, parseHistoryLimit(c.req.query('limit')))
  return c.json(rows)
})

iptv.post('/history', requireAuth, async (c) => {
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

iptv.post('/stream/live/:streamId/grant', requireAuth, async (c) => {
  const streamId = c.req.param('streamId')
  if (!/^\d+$/.test(streamId)) return c.json({ error: 'invalid_id' }, 400)

  // §9 Resolution A: probe sources in precedence order before acquiring a
  // concurrency slot. If no source is reachable, surface source_unavailable
  // so the client can prompt the user for an explicit action rather than
  // silently failing mid-stream.
  const precedence = await resolveSourcePrecedence({ kind: 'live', id: streamId })
  if (!precedence.resolved) {
    return c.json(
      { ok: false, reason: 'source_unavailable', available_alternatives: precedence.alternatives },
      503,
    )
  }

  const { sub } = userOf(c)
  const sessionId = `live:${streamId}:${sub}:${Date.now()}`
  const acquired = streamConcurrency().tryAcquire({
    sub,
    sessionId,
    kind: clientWantsAvplayer(c) ? 'remux' : 'live',
    resourceId: streamId,
    ip: clientIp(c),
    title: sessionTitle('live', streamId),
  })
  if (!acquired.ok) {
    // source_unavailable (503) is handled above by resolveSourcePrecedence before
    // tryAcquire is called. The only reason tryAcquire returns ok=false is
    // iptv_concurrency_limit, which is 429 (rate-limited, not upstream-down).
    if (acquired.reason !== 'iptv_concurrency_limit') {
      return c.json({ ok: false, reason: acquired.reason }, 503)
    }
    return c.json({ ...acquired, sessions: enrichSessions(acquired.sessions) }, 429)
  }

  if (clientWantsAvplayer(c)) {
    const token = signStreamToken(env.streamTokenSecret, {
      kind: 'remux', resourceId: streamId, sub, ttlSecs: env.IPTV_STREAM_TOKEN_TTL_SECS,
    })
    return c.json({
      url: `/api/iptv/stream/live/${streamId}/remux/index.m3u8?t=${token}`,
      delivery: 'hls', sessionId,
    })
  }

  const token = signStreamToken(env.streamTokenSecret, {
    kind: 'live', resourceId: streamId, sub, ttlSecs: env.IPTV_STREAM_TOKEN_TTL_SECS,
  })
  return c.json({
    url: `/api/iptv/stream/live/${streamId}.ts?t=${token}`,
    delivery: 'mpegts', sessionId,
  })
})

iptv.post('/stream/catchup/:streamId/grant', requireAuth, async (c) => {
  const streamId = c.req.param('streamId')
  if (!/^\d+$/.test(streamId)) return c.json({ error: 'invalid_id' }, 400)

  const startUtc = c.req.query('startUtc') ?? ''
  const durationMin = parsePositiveInt(c.req.query('durationMin') ?? '')
  const startDate = new Date(startUtc)
  if (!startUtc || Number.isNaN(startDate.getTime()) || durationMin == null) {
    return c.json({ error: 'invalid_params' }, 400)
  }
  // The catchup rid is pipe-delimited: streamId|startUtc|durationMin.
  // A startUtc containing '|' would inject extra segments, corrupting the
  // rid parse in sessionTitle and any verifier that splits on '|'.
  if (startUtc.includes('|')) {
    return c.json({ error: 'rid_invalid' }, 400)
  }

  const channel = iptvDb().raw
    .prepare(`SELECT tv_archive, tv_archive_duration FROM channels WHERE stream_id = ?`)
    .get(Number(streamId)) as { tv_archive: number; tv_archive_duration: number | null } | undefined
  if (!channel) return c.json({ error: 'not_found' }, 404)
  if (channel.tv_archive !== 1) return c.json({ error: 'catchup_unavailable' }, 400)

  const archiveCutoff = Date.now() - (channel.tv_archive_duration ?? 7) * 24 * 3600_000
  if (startDate.getTime() < archiveCutoff) return c.json({ error: 'beyond_archive_window' }, 400)

  // §9 Resolution A: probe sources before acquiring a concurrency slot.
  const precedence = await resolveSourcePrecedence({ kind: 'catchup', id: streamId })
  if (!precedence.resolved) {
    return c.json(
      { ok: false, reason: 'source_unavailable', available_alternatives: precedence.alternatives },
      503,
    )
  }

  const { sub } = userOf(c)
  const sessionId = `catchup:${streamId}:${startUtc}:${sub}:${Date.now()}`
  const resourceId = `${streamId}|${startUtc}|${durationMin}`
  const acquired = streamConcurrency().tryAcquire({
    sub,
    sessionId,
    kind: 'catchup',
    resourceId,
    ip: clientIp(c),
    title: sessionTitle('catchup', resourceId),
  })
  if (!acquired.ok) {
    // tryAcquire only ever returns iptv_concurrency_limit on failure
    // here — source_unavailable is produced by a different code path
    // upstream. Narrow the union explicitly so TS can see `sessions`.
    if (acquired.reason !== 'iptv_concurrency_limit') {
      return c.json({ ok: false, reason: acquired.reason }, 503)
    }
    return c.json({ ...acquired, sessions: enrichSessions(acquired.sessions) }, 429)
  }

  const token = signStreamToken(env.streamTokenSecret, {
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

function checkToken(c: Context<Env>, expectKind: StreamKind, resourceId: string): { ok: true; sub: string } | { ok: false; resp: Response } {
  const t = c.req.query('t') ?? ''
  try {
    const claims = verifyStreamTokenDualKey(env.streamTokenSecret, env.sessionSecret, t)
    if (claims.k !== expectKind || claims.rid !== resourceId) {
      return { ok: false, resp: c.json({ error: 'token_mismatch' }, 401) }
    }
    // Per-kind replay enforcement. 'playlist' tokens are not routed through
    // checkToken (they have their own inline path) so the cast is always safe.
    if (claims.k !== 'playlist') {
      const replay = checkReplay(claims.jti, claims.exp, claims.k)
      if (!replay.allowed) {
        return { ok: false, resp: c.json({ error: replay.reason }, 401) }
      }
    }
    // Stream-token grace path (§8.2): M1 HMAC tokens may carry an
    // unprefixed `sub`. Normalise bare numeric ids to `plex:<id>` during
    // the 30-day grace window. Any sub written from this normalised
    // value (e.g. into watch history on heartbeat) uses the prefixed
    // form. Drop this block one cookie-TTL post-D7 alongside the
    // verifySession grace path.
    const parsed = tryNormaliseLegacySub(claims.sub)
    if (!parsed) {
      return { ok: false, resp: c.json({ error: 'invalid_token', detail: 'sub_invalid_format' }, 401) }
    }
    return { ok: true, sub: parsed.raw }
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
      const token = signStreamToken(env.streamTokenSecret, {
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

async function rewriteHlsPlaylist(c: Context, upstreamUrl: string, sub: string): Promise<Response> {
  const upstream = await fetch(upstreamUrl)
  if (!upstream.ok) return c.json({ error: `upstream_${upstream.status}` }, 502)

  const text = await upstream.text()
  const sign = (url: string) =>
    signStreamToken(env.streamTokenSecret, {
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

// Stream-bytes endpoints are token-authed via the URL-signed HMAC, not
// cookie-authed. The grant POSTs above still require session auth so
// only a signed-in user can mint a token, but the actual <video> /
// hls.js / mpegts.js fetch is cross-origin from the SPA (theemerald
// exchange.com → api.theemeraldexchange.com) and the browser does NOT
// attach cookies on those requests. requireAuth here would 401 every
// playback attempt before checkToken ever runs.
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
  // X-Accel-Buffering: no tells nginx-class reverse proxies not to
  // buffer the response. Cloudflare honors it on the tunnel path,
  // which keeps stream chunks flowing client-ward instead of waiting
  // to fill an edge buffer before delivering — exactly what live
  // playback can't tolerate. Cache-Control: no-store + no-transform
  // additionally prevents any intermediary from rewriting (compressing,
  // segmenting) the MPEG-TS bytes.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      'Connection': 'keep-alive',
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
    claims = verifyStreamTokenDualKey(env.streamTokenSecret, env.sessionSecret, t)
    if (claims.k !== 'remux') throw new Error('kind_mismatch')
  } catch (err) {
    return c.json({ error: 'invalid_token', detail: err instanceof Error ? err.message : String(err) }, 401)
  }
  const remuxReplay = checkReplay(claims.jti, claims.exp, 'remux')
  if (!remuxReplay.allowed) return c.json({ error: remuxReplay.reason }, 401)


  const resource = remuxSegmentResource(claims.rid)
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

iptv.post('/stream/vod/:streamId/grant', requireAuth, async (c) => {
  const streamId = c.req.param('streamId')
  if (!/^\d+$/.test(streamId)) return c.json({ error: 'invalid_id' }, 400)
  const { sub } = userOf(c)
  const detail = getVodDetail(iptvDb(), Number(streamId))
  if (!detail) return c.json({ error: 'not_found' }, 404)

  // §9 Resolution A: probe sources before acquiring a concurrency slot.
  const precedence = await resolveSourcePrecedence({ kind: 'vod', id: streamId })
  if (!precedence.resolved) {
    return c.json(
      { ok: false, reason: 'source_unavailable', available_alternatives: precedence.alternatives },
      503,
    )
  }

  const ext = (detail.container_extension ?? 'mp4').toLowerCase()
  const sessionId = `vod:${streamId}:${sub}:${Date.now()}`
  const acquired = streamConcurrency().tryAcquire({
    sub,
    sessionId,
    kind: 'vod',
    resourceId: streamId,
    ip: clientIp(c),
    title: detail.name,
  })
  if (!acquired.ok) {
    if (acquired.reason !== 'iptv_concurrency_limit') {
      return c.json({ ok: false, reason: acquired.reason }, 503)
    }
    return c.json({ ...acquired, sessions: enrichSessions(acquired.sessions) }, 429)
  }

  const token = signStreamToken(env.streamTokenSecret, {
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
  if (ext === 'm3u8') return await rewriteHlsPlaylist(c, upstreamUrl, v.sub)

  const mime = ext === 'mkv' ? 'video/x-matroska' : 'video/mp4'
  return await proxyRangeable(c, upstreamUrl, mime)
})

iptv.post('/stream/series/:episodeId/grant', requireAuth, async (c) => {
  const episodeId = c.req.param('episodeId')
  if (!/^[\w-]+$/.test(episodeId)) return c.json({ error: 'invalid_id' }, 400)
  const { sub } = userOf(c)
  const row = iptvDb().raw
    .prepare('SELECT container_extension FROM series_episodes WHERE episode_id = ?')
    .get(episodeId) as { container_extension: string | null } | undefined
  if (!row) return c.json({ error: 'not_found' }, 404)

  // §9 Resolution A: probe sources before acquiring a concurrency slot.
  const precedence = await resolveSourcePrecedence({ kind: 'series', id: episodeId })
  if (!precedence.resolved) {
    return c.json(
      { ok: false, reason: 'source_unavailable', available_alternatives: precedence.alternatives },
      503,
    )
  }

  const ext = (row.container_extension ?? 'mp4').toLowerCase()
  const sessionId = `series:${episodeId}:${sub}:${Date.now()}`
  const acquired = streamConcurrency().tryAcquire({
    sub,
    sessionId,
    kind: 'series',
    resourceId: episodeId,
    ip: clientIp(c),
    title: sessionTitle('series', episodeId),
  })
  if (!acquired.ok) {
    if (acquired.reason !== 'iptv_concurrency_limit') {
      return c.json({ ok: false, reason: acquired.reason }, 503)
    }
    return c.json({ ...acquired, sessions: enrichSessions(acquired.sessions) }, 429)
  }

  const token = signStreamToken(env.streamTokenSecret, {
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
  if (ext === 'm3u8') return await rewriteHlsPlaylist(c, upstreamUrl, v.sub)

  const mime = ext === 'mkv' ? 'video/x-matroska' : 'video/mp4'
  return await proxyRangeable(c, upstreamUrl, mime)
})

iptv.get('/stream/segment', async (c) => {
  const t = c.req.query('u') ?? ''
  let claims: ReturnType<typeof verifyStreamToken>
  try {
    claims = verifyStreamTokenDualKey(env.streamTokenSecret, env.sessionSecret, t)
    if (claims.k !== 'segment') throw new Error('kind_mismatch')
  } catch (err) {
    return c.json({ error: 'invalid_token', detail: err instanceof Error ? err.message : String(err) }, 401)
  }
  // Segment tokens are strict single-use; replay here is a security violation.
  const segReplay = checkReplay(claims.jti, claims.exp, 'segment')
  if (!segReplay.allowed) return c.json({ error: segReplay.reason }, 401)

  const upstream = claims.rid
  const allowedHost = new URL(credsFromEnv().host).host
  let url: URL
  try {
    url = new URL(upstream)
  } catch {
    return c.json({ error: 'bad_upstream' }, 400)
  }
  void allowedHost

  if (url.pathname.toLowerCase().endsWith('.m3u8')) {
    return await rewriteHlsPlaylist(c, upstream, claims.sub)
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

iptv.get('/export/recommender', (c) => {
  const secret = c.req.header('x-iptv-export-secret') ?? ''
  if (!env.IPTV_RECOMMENDER_EXPORT_SECRET || secret !== env.IPTV_RECOMMENDER_EXPORT_SECRET) {
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

iptv.post('/admin/sync', requireAuth, requireAdmin, async (c) => {
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

iptv.get('/admin/sync/:id', requireAuth, requireAdmin, (c) => {
  const id = c.req.param('id')
  const job = jobs.get(id)
  if (!job) return c.json({ error: 'not_found' }, 404)
  return c.json(job)
})
