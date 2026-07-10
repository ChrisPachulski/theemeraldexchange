// IPTV (MyBunny / Xtream) router. Mounted at /api/iptv. Currently only
// exposes a health smoke endpoint that surfaces the upstream Xtream
// account's expiry, connection cap, and status — the SPA uses it to
// warn when the panel is dead or the line is exhausted before the user
// tries to start a stream.

import { Hono, type Context } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'

// Async gzip so a ~28 MB EPG-grid compression runs on the libuv threadpool
// instead of blocking the event loop (and every other in-flight request) for
// the full synchronous compress.
const gzipAsync = promisify(gzip)
import { requireAuth, requireAdmin, type Env } from '../middleware/auth.js'
import { rateLimit } from '../middleware/rateLimit.js'
import { requireSection } from '../services/userPolicies.js'
import { capBlocksUnrated } from '../services/parentalRating.js'
import { getAccountInfo, credsFromEnv } from '../services/xtream.js'
import { nodeReadableToWebStream } from '../services/streamBridge.js'
import { iptvDb } from '../services/iptvDbSingleton.js'
import {
  listCategories,
  listLive,
  listVod,
  listSeries,
  getVodDetail,
  getSeriesDetail,
} from '../services/iptvCatalog.js'
import { epgChannelWindow, epgGrid, epgNow, epgSearch } from '../services/iptvEpgQuery.js'
import { signStreamToken, verifyStreamToken, type StreamKind } from '../services/iptvStreamToken.js'
import { checkReplay } from '../services/tokenReplayCache.js'
import { parseSub } from '../services/sub.js'
import { resolveSourcePrecedence } from '../services/sourcePrecedence.js'
import { streamConcurrency, type SessionView, type SessionKind } from '../services/iptvConcurrency.js'
import { postFeedback } from '../services/recommender.js'
import { recommenderCallerFromSession } from '../services/recommenderCaller.js'
import { type Session } from '../session.js'
import { crossedWatchThreshold, type WatchPoint } from '../services/watchSignal.js'
import {
  isPublicHttpsUpstream,
  guardedFetch,
  guardedFetchTrustedOrigin,
  SsrfBlockedError,
} from '../services/ssrfGuard.js'
import {
  heartbeatRemuxSession,
  channelIsDeadFeed,
  markChannelDeadFeed,
  DEAD_FEED_CLEAN_EOF_MS,
} from '../services/iptvRemux.js'
import {
  ensureLiveRemuxEntry,
  dropOtherLiveRemuxSessions,
  getActiveLiveRemuxEntry,
  forgetLiveRemuxEntry,
  isChannelOfflineUpstream,
  remuxManifestReady,
  remuxSegmentResource,
  rewriteRemuxManifest,
} from '../services/iptvLiveRemuxMap.js'
import { resolveSiblingFeeds } from '../services/iptvSiblingFeeds.js'
import {
  authorizePlaylistToken,
  buildPlaylistM3u,
  listPlaylistTokens,
  mintPlaylistToken,
  revokePlaylistToken,
} from '../services/iptvPlaylist.js'
import {
  fetchAndRewriteHlsPlaylist,
  proxyRangeableUpstream,
} from '../services/iptvHlsProxy.js'
import { getSyncJob, startSyncJob } from '../services/iptvSyncJobs.js'
import {
  channelArchiveRow,
  containerExtensionRow,
  episodeTitleRow,
  nameRow,
} from '../services/iptvRows.js'
import { env } from '../env.js'
import { parseLimitedJson } from '../services/parseLimitedJson.js'

export const iptv = new Hono<Env>()

const PLAYLIST_TOKEN_MAX_BODY_BYTES = 1024

function firstHeaderValue(value: string | undefined): string {
  return value?.split(',')[0]?.trim() ?? ''
}

function safeHost(value: string, fallback: string): string {
  if (!value) return fallback
  if (/[\s/\\]/.test(value)) return fallback
  return value
}

// X-Forwarded-Host / Host are attacker-controlled on any deploy where the
// backend is reachable without the trusted proxy in front, so a host is only
// echoed into minted playlist URLs when it belongs to the operator's
// configured ALLOWED_ORIGINS — either exactly, or as a subdomain (the API
// lives at api.<spa-domain> in the Netlify ↔ NAS split, while ALLOWED_ORIGINS
// carries the SPA origin). An attacker can't serve content from a subdomain
// of the operator's domain without controlling its DNS.
function isAllowedPublicHost(host: string): boolean {
  const hostname = host.toLowerCase().replace(/:\d+$/, '')
  for (const origin of env.allowedOrigins) {
    let originHostname: string
    try {
      originHostname = new URL(origin).hostname.toLowerCase()
    } catch {
      continue // malformed allowlist entry can never match
    }
    if (hostname === originHostname || hostname.endsWith(`.${originHostname}`)) return true
  }
  return false
}

export function publicBaseUrl(c: Context): string {
  const requestUrl = new URL(c.req.url)
  const forwardedProto = firstHeaderValue(c.req.header('x-forwarded-proto')).toLowerCase()
  const proto = forwardedProto === 'http' || forwardedProto === 'https'
    ? `${forwardedProto}:`
    : requestUrl.protocol
  const host = safeHost(
    firstHeaderValue(c.req.header('x-forwarded-host')) ||
      firstHeaderValue(c.req.header('host')) ||
      requestUrl.host,
    requestUrl.host,
  )
  // No allowlist configured (dev / direct-LAN deploys): header passthrough.
  if (env.allowedOrigins.length === 0) return `${proto}//${host}`
  if (isAllowedPublicHost(host)) return `${proto}//${host}`
  // Forwarded host doesn't belong to the operator — never echo it into a
  // minted URL. Fall back to the first parseable configured origin; if every
  // entry is malformed, use the socket-level request host (not the headers).
  for (const origin of env.allowedOrigins) {
    try {
      return new URL(origin).origin
    } catch {
      continue
    }
  }
  return `${proto}//${requestUrl.host}`
}

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
export function clientIp(c: Context<Env>): string | null {
  const cf = c.req.header('cf-connecting-ip')?.trim()
  if (cf) return cf
  const firstForwarded = c.req.header('x-forwarded-for')
    ?.split(',')
    .map((part) => part.trim())
    .find(Boolean)
  return firstForwarded ?? null
}

// Title resolver for the sessions widget. Called only when listing — keeps
// the tracker itself ignorant of catalog schema. Tolerant of missing rows
// (cleaned catalog, deleted item) by returning null so the UI just shows
// the resourceId.
function sessionTitle(kind: SessionKind, resourceId: string): string | null {
  const db = iptvDb().raw
  try {
    if (kind === 'live' || kind === 'remux') {
      const row = nameRow(db.prepare('SELECT name FROM channels WHERE stream_id = ?').get(Number(resourceId)))
      return row?.name ?? null
    }
    if (kind === 'vod') {
      const row = nameRow(db.prepare('SELECT name FROM vod WHERE stream_id = ?').get(Number(resourceId)))
      return row?.name ?? null
    }
    if (kind === 'series') {
      const row = episodeTitleRow(
        db.prepare('SELECT title, series_id FROM series_episodes WHERE episode_id = ?').get(resourceId),
      )
      if (!row) return null
      const series = nameRow(db.prepare('SELECT name FROM series WHERE series_id = ?').get(row.series_id))
      return series ? `${series.name}${row.title ? ` — ${row.title}` : ''}` : row.title
    }
    if (kind === 'catchup') {
      // catchup resourceId encoded as streamId|startUtc|durationMin
      const sid = Number(resourceId.split('|')[0])
      const row = nameRow(db.prepare('SELECT name FROM channels WHERE stream_id = ?').get(sid))
      return row?.name ?? null
    }
  } catch {
    return null
  }
  return null
}

// Test-only export: sessionTitle is module-private to keep the session tracker
// ignorant of catalog schema, but its series branch (episode→series join, with
// null-title and missing-row fallbacks) is non-trivial and worth unit-pinning.
export const __test = { sessionTitle }

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
  const isAdmin = c.get('session').role === 'admin'
  const all = streamConcurrency().list()
  const target = all.find((s) => s.sessionId === sessionId)
  if (!target) return c.json({ error: 'not_found' }, 404)
  if (!isAdmin && target.sub !== sub) return c.json({ error: 'forbidden' }, 403)
  streamConcurrency().release(sessionId)
  // A remux (AVPlayer live) slot is backed by an ffmpeg process holding a live
  // upstream provider connection, tracked SEPARATELY from the concurrency slot.
  // Releasing the slot alone leaves that ffmpeg alive until the 90s idle sweep,
  // so freeing a session in the sessions widget did not actually free the
  // provider connection. Stop the matching remux session now (keyed by the
  // slot's resourceId=streamId + sub) so the connection releases immediately.
  if (target.kind === 'remux') {
    const entry = getActiveLiveRemuxEntry(target.resourceId, target.sub)
    if (entry) forgetLiveRemuxEntry(target.resourceId, target.sub, entry.sessionId)
  }
  return c.json({ ok: true, released: sessionId })
})

const KINDS = new Set(['live', 'vod', 'series'])
const HIST_KINDS = new Set(['live', 'vod', 'series_episode'])

// Forward a watch as a 'watched' positive to the recommender, exactly once on
// the transition into "qualified" (not on every 5s progress tick). Resolves the
// IPTV item_id to its TMDB id (vod -> movie, series_episode -> parent series tv;
// live is skipped — no tmdb_id, no completion). Best-effort and fire-and-forget:
// a recommender hiccup must never break watch-history persistence.
function maybeEmitWatched(
  session: Session,
  requestId: string | undefined,
  kind: string,
  itemId: string,
  now: WatchPoint,
  prior: WatchPoint | undefined,
): void {
  try {
    if (!crossedWatchThreshold(prior, now)) return

    const db = iptvDb()
    let tmdbId: number | null = null
    let recKind: 'movie' | 'tv' | null = null
    if (kind === 'vod') {
      const streamId = Number(itemId)
      if (!Number.isInteger(streamId)) return
      const row = db.stmts.vodTmdbByStreamId.get({ stream_id: streamId }) as { tmdb_id: number | null } | undefined
      tmdbId = row?.tmdb_id ?? null
      recKind = 'movie'
    } else if (kind === 'series_episode') {
      const row = db.stmts.episodeSeriesTmdbByEpisodeId.get({ episode_id: itemId }) as { tmdb_id: number | null } | undefined
      tmdbId = row?.tmdb_id ?? null
      recKind = 'tv'
    }
    if (recKind == null || tmdbId == null || !Number.isInteger(tmdbId) || tmdbId <= 0) return

    const caller = recommenderCallerFromSession(session, requestId)
    void postFeedback({ sub: session.sub, kind: recKind, tmdb_id: tmdbId, signal: 'watched' }, caller)
  } catch {
    // best-effort training signal; never surface to the watch-history write
  }
}

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

iptv.get('/epg/grid', requireAuth, async (c) => {
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
iptv.get('/epg/search', requireAuth, epgSearchRateLimit, async (c) => {
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

// Constant-time secret comparison (length-prefixed) so a shared-secret check
// doesn't leak via response timing. Mirrors how the other auth secrets compare.
function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

// Playlist-token lifecycle + M3U generation live in services/iptvPlaylist.ts;
// these handlers only parse the HTTP shape and map outcomes to statuses.
iptv.post('/playlist/token', requireAuth, async (c) => {
  const { sub } = userOf(c)
  // Optional device label — free-form string, max 120 chars. Returned in the
  // response so the admin list can show "iPhone 15 (kitchen)" next to the jti.
  const parsed = await parseLimitedJson(c, PLAYLIST_TOKEN_MAX_BODY_BYTES)
  if (parsed.tooLarge) return c.json({ error: 'body_too_large' }, 413)
  // The shared reader reports "no parseable body" as null; an absent body is
  // fine here (deviceName is optional), so normalize to an empty object.
  const body = (parsed.body ?? {}) as { deviceName?: unknown }
  const deviceName = typeof body.deviceName === 'string'
    ? body.deviceName.trim().slice(0, 120)
    : undefined
  return c.json(mintPlaylistToken({ sub, deviceName, baseUrl: publicBaseUrl(c) }))
})

iptv.get('/playlist/tokens', requireAuth, (c) => {
  const { sub } = userOf(c)
  return c.json({ tokens: listPlaylistTokens(sub) })
})

iptv.delete('/playlist/tokens/:jti', requireAuth, (c) => {
  const session = c.get('session')
  const outcome = revokePlaylistToken(c.req.param('jti'), {
    sub: session.sub,
    isAdmin: session.role === 'admin',
  })
  if (outcome === 'not_found') return c.json({ error: 'not_found' }, 404)
  if (outcome === 'forbidden') return c.json({ error: 'forbidden' }, 403)
  if (outcome === 'already_revoked') return c.json({ error: 'already_revoked' }, 409)
  return c.json({ ok: true })
})

// Hit by external players (VLC, iPlayTV, TiviMate) that have no session
// cookie. Token-in-URL is the auth; see comment on /stream/live/:id.ts.
iptv.get('/playlist.m3u', (c) => {
  const auth = authorizePlaylistToken(c.req.query('t') ?? '')
  if (!auth.ok) {
    return c.json(
      auth.detail ? { error: auth.error, detail: auth.detail } : { error: auth.error },
      401,
    )
  }
  return new Response(buildPlaylistM3u(auth.sub, publicBaseUrl(c)), {
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
  if (typeof body.kind !== 'string' || !KINDS.has(body.kind)) return c.json({ error: 'invalid_kind' }, 400)
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
  if (!KINDS.has(kind)) return c.json({ error: 'invalid_kind' }, 400)
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
  const kind = body.kind
  const itemId = body.itemId

  const rawPos = Number(body.positionSecs ?? 0)
  const positionSecs = Number.isFinite(rawPos) ? Math.max(0, Math.floor(rawPos)) : 0
  const rawDur = body.durationSecs == null ? null : Number(body.durationSecs)
  const durationSecs = rawDur != null && Number.isFinite(rawDur) ? Math.max(0, Math.floor(rawDur)) : null
  const completed = body.completed ? 1 : 0

  const db = iptvDb()
  // Snapshot the prior watch row BEFORE the upsert so the implicit 'watched'
  // signal fires exactly once — on the transition into "qualified" — rather
  // than on every throttled 5s progress tick.
  const prior = db.stmts.getHistoryItem.get({ sub, kind, item_id: itemId }) as
    | { position_secs: number; duration_secs: number | null; completed: number }
    | undefined

  db.stmts.putHistory.run({
    sub,
    kind,
    item_id: itemId,
    position_secs: positionSecs,
    duration_secs: durationSecs,
    watched_at: new Date().toISOString(),
    completed,
  })

  if (env.useLocalRecommender && kind !== 'live') {
    maybeEmitWatched(
      c.get('session'),
      c.get('requestId'),
      kind,
      itemId,
      { position_secs: positionSecs, duration_secs: durationSecs, completed },
      prior,
    )
  }
  return c.body(null, 201)
})

function clientWantsAvplayer(c: Context<Env>): boolean {
  return c.req.query('client') === 'avplayer'
}

// A pass-through TransformStream that invokes `onChunk` for each chunk that
// flows through it. Used to heartbeat a long-lived byte stream's concurrency
// slot (finding 8-1) without buffering or copying the payload. `onChunk` is
// throttled to once per HEARTBEAT_THROTTLE_MS so a high-bitrate stream doesn't
// hammer the tracker Map on every TS packet.
const HEARTBEAT_THROTTLE_MS = 5_000
function makeHeartbeatStream(
  onChunk: () => void,
  // Fires once when the UPSTREAM side closes cleanly (EOF), NOT on client abort
  // or upstream error — the transform's flush() only runs on a normal readable
  // completion. The live .ts proxy uses this to tag a dead-placeholder feed.
  onUpstreamEof?: () => void,
): TransformStream<Uint8Array, Uint8Array> {
  let lastBeat = 0
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const now = Date.now()
      if (now - lastBeat >= HEARTBEAT_THROTTLE_MS) {
        lastBeat = now
        try {
          onChunk()
        } catch {
          // Heartbeat is best-effort; never let it break the byte stream.
        }
      }
      controller.enqueue(chunk)
    },
    flush() {
      if (!onUpstreamEof) return
      try {
        onUpstreamEof()
      } catch {
        // Best-effort dead-feed bookkeeping; never let it break teardown.
      }
    },
  })
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

iptv.post('/stream/live/:streamId/grant', requireAuth, requireSection('live'), async (c) => {
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
  const wantsRemux = clientWantsAvplayer(c)
  // A guide PREVIEW grant (GuidePreview focuses a channel to paint a thumbnail)
  // is NOT a watch: it must not run the one-tuner teardown below, or focusing a
  // channel in the guide on one device would evict this same account's actively-
  // watched channel on another device — which then respawns from its own poll
  // and the two flap. Only a real watch grant tears the account's other tuners
  // down. The client signals its intent via ?intent=preview (GuidePreview).
  const isPreview = c.req.query('intent') === 'preview'
  const sessionId = `live:${streamId}:${sub}:${Date.now()}`
  const acquired = streamConcurrency().tryAcquire({
    sub,
    sessionId,
    kind: wantsRemux ? 'remux' : 'live',
    resourceId: streamId,
    ip: clientIp(c),
    title: sessionTitle('live', streamId),
    // A remux grant opens a live upstream connection that is HARD-capped at
    // IPTV_MAX_UPSTREAM_CONNECTIONS (ffmpeg). Cap concurrent remux grants at
    // that ceiling so the surplus viewer gets a clean iptv_concurrency_limit
    // 429 here instead of being silently ffmpeg-evicted mid-stream once the
    // upstream cap is exceeded. Must satisfy CONCURRENT ≤ UPSTREAM for remux.
    kindCap: wantsRemux
      ? Math.min(env.IPTV_MAX_CONCURRENT_STREAMS, env.IPTV_MAX_UPSTREAM_CONNECTIONS)
      : undefined,
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

  if (wantsRemux) {
    // One live tuner per viewer: selecting a channel tears down this user's
    // OTHER live remux channels (the channel they were on, or a ghost from a
    // prior app-close) and frees their upstream provider connections + slots
    // NOW, instead of waiting on the idle sweep — so a 1–2 connection provider
    // sees the old connection close first rather than momentarily needing two.
    // This runs ONCE per channel selection (here), never on the manifest poll:
    // a lingering poll from the channel being left can respawn its own ffmpeg
    // but can no longer kill the freshly-tuned one, so the two never ping-pong.
    // Skipped for a preview grant (see isPreview above) so guide browsing never
    // evicts the household's active watch.
    if (!isPreview) {
      for (const goneStreamId of dropOtherLiveRemuxSessions(sub, streamId)) {
        streamConcurrency().releaseByResource(sub, 'remux', goneStreamId)
      }
    }
    const token = signStreamToken(env.streamTokenSecret, {
      kind: 'remux', resourceId: streamId, sub, ttlSecs: env.IPTV_LIVE_TOKEN_TTL_SECS,
    })
    return c.json({
      url: `/api/iptv/stream/live/${streamId}/remux/index.m3u8?t=${token}`,
      delivery: 'hls', sessionId,
    })
  }

  const token = signStreamToken(env.streamTokenSecret, {
    kind: 'live', resourceId: streamId, sub, ttlSecs: env.IPTV_LIVE_TOKEN_TTL_SECS,
  })
  return c.json({
    url: `/api/iptv/stream/live/${streamId}.ts?t=${token}`,
    delivery: 'mpegts', sessionId,
  })
})

iptv.post('/stream/catchup/:streamId/grant', requireAuth, requireSection('live'), async (c) => {
  // Catchup is time-shifted live-channel content, so it belongs to the same
  // `live` section as the live grant: a member whose policy denies Live TV must
  // not be able to play a channel's last-7-days archive either. Enforced on the
  // grant (the sole token-mint point) so a tampered client can't bypass it.
  // IPTV provider content is UNRATED (star ratings, never certifications) —
  // a parental rating cap therefore blocks these grants wholesale (fail
  // closed, same rule the clients apply to unrated titles).
  if (await capBlocksUnrated(c.get('session'))) {
    return c.json({ error: 'rating_blocked' }, 403)
  }
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

  const channel = channelArchiveRow(
    iptvDb().raw
      .prepare(`SELECT tv_archive, tv_archive_duration FROM channels WHERE stream_id = ?`)
      .get(Number(streamId)),
  )
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
    // On-demand (finite archive) playback re-presents this token on every
    // seek/reconnect for the whole runtime — the 300s finite-asset TTL froze
    // it at ~5min. Use the playback-duration TTL, like VOD/series and local
    // media.
    ttlSecs: env.IPTV_ONDEMAND_TOKEN_TTL_SECS,
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
    const claims = verifyStreamToken(env.streamTokenSecret, t)
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
    // The sub claim must be canonical namespaced form (§8). The M1
    // bare-numeric grace normalization is gone — its 30-day window closed.
    let sub: string
    try {
      sub = parseSub(claims.sub).raw
    } catch {
      return { ok: false, resp: c.json({ error: 'invalid_token', detail: 'sub_invalid_format' }, 401) }
    }
    return { ok: true, sub }
  } catch (err) {
    return { ok: false, resp: c.json({ error: 'invalid_token', detail: err instanceof Error ? err.message : String(err) }, 401) }
  }
}

// The live remux session index (which viewer owns which ffmpeg session,
// manifest/segment URL rewriting) lives in services/iptvLiveRemuxMap.ts.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Upstream HLS rewrite + rangeable progressive proxying live in
// services/iptvHlsProxy.ts (Hono-free, unit-testable); the handlers below
// pass the request signal/range through explicitly.

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
  // Finding 8-1: a long live view whose player never re-grants was idle-reaped
  // after 30s while bytes still flowed. The live .ts byte stream is one long
  // open fetch, so heartbeat the grant session now AND on each streamed chunk
  // (see liveHeartbeatStream below), and release the slot when the client
  // disconnects so it frees immediately on tab-close / player teardown. The
  // grant for non-AVPlayer live acquired kind 'live' on resourceId=streamId,
  // which this resource-keyed path matches without needing the opaque
  // sessionId (the stream token is crate-canonical and carries no sid claim).
  streamConcurrency().heartbeatByResource(v.sub, 'live', streamId)
  const creds = credsFromEnv()
  const upstreamUrlFor = (sid: string) =>
    `${creds.host}/live/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${sid}.ts`

  // Dead-feed failover parity with the remux path (Fox Soccer Plus incident).
  // Chrome/Firefox/Edge live viewers get this raw .ts proxy, never the remux
  // manifest, so without candidate iteration a granted-but-dead feed could never
  // fail over to a live sibling and re-opening the channel stayed permanently
  // dead on the web while it worked on the TV. Walk the ordered candidate feeds
  // (self first, then siblings sharing epg_channel_id / normalized name), skip
  // any remembered as a dead placeholder, and dial the first that answers.
  const candidateFeeds = resolveSiblingFeeds(iptvDb().raw, streamId)

  const controller = new AbortController()
  let clientAborted = false
  c.req.raw.signal.addEventListener('abort', () => {
    clientAborted = true
    controller.abort()
    // Client gone — free the slot now rather than waiting for the idle sweep.
    streamConcurrency().releaseByResource(v.sub, 'live', streamId)
  }, { once: true })

  // SSRF: trusted creds origin, but re-validate any upstream-issued redirect
  // so a panel can't bounce the live byte stream into the internal network.
  let upstream: Response | null = null
  let dialedFeed: string | null = null
  for (const feed of candidateFeeds) {
    if (channelIsDeadFeed(feed)) continue
    let resp: Response
    try {
      resp = await guardedFetchTrustedOrigin(upstreamUrlFor(feed), {
        signal: controller.signal,
        headers: { 'User-Agent': 'IPTVSmarters' },
      })
    } catch (err) {
      if (err instanceof SsrfBlockedError) continue // a bad candidate — try the next sibling
      throw err
    }
    if (resp.ok && resp.body) {
      upstream = resp
      dialedFeed = feed
      break
    }
    // Non-2xx / bodyless: this feed is down right now — fall through to the next
    // sibling rather than surfacing a hard 502 the client can never recover from.
  }
  if (!upstream || !upstream.body || !dialedFeed) {
    // Every candidate feed is dead or down: the channel is off the air upstream,
    // a TERMINAL state distinct from a transient per-feed hiccup. Emit the same
    // channel_offline_upstream contract the remux path uses (503) so the client
    // stops retrying and offers an alternative instead of the old 502 that
    // looped mpegts.js into a frozen spinner.
    return c.json({ error: 'channel_offline_upstream' }, 503)
  }
  const feed = dialedFeed
  const dialedAt = Date.now()
  // X-Accel-Buffering: no tells nginx-class reverse proxies not to
  // buffer the response. Cloudflare honors it on the tunnel path,
  // which keeps stream chunks flowing client-ward instead of waiting
  // to fill an edge buffer before delivering — exactly what live
  // playback can't tolerate. Cache-Control: no-store + no-transform
  // additionally prevents any intermediary from rewriting (compressing,
  // segmenting) the MPEG-TS bytes.
  // Heartbeat the grant slot on every streamed chunk so a multi-minute live
  // view holds its concurrency slot past the 30s idle window (finding 8-1).
  //
  // Dead-placeholder detection (byte-proxy analogue of the remux path's
  // ffmpeg-exit-0-under-60s check): a real live feed streams unbounded, but a
  // dead-channel placeholder plays a ~30s slate loop then EOFs cleanly. If the
  // UPSTREAM closes cleanly within the clean-EOF window and the client did NOT
  // disconnect, remember the dialed feed as dead so the client's next reload
  // (mpegts.js recover()) skips it and fails over to a live sibling.
  const heartbeatBody = upstream.body.pipeThrough(
    makeHeartbeatStream(
      () => streamConcurrency().heartbeatByResource(v.sub, 'live', streamId),
      () => {
        if (clientAborted) return
        if (Date.now() - dialedAt <= DEAD_FEED_CLEAN_EOF_MS) markChannelDeadFeed(feed)
      },
    ),
  )
  return new Response(heartbeatBody, {
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

  // Keep the concurrency slot acquired at grant alive on every manifest poll.
  // AVPlayer re-fetches index.m3u8 periodically; without this the 'remux' slot
  // is idle-swept after ~30s and the IPTV_MAX_CONCURRENT_STREAMS cap is silently
  // defeated — every other delivery kind heartbeats its slot, remux did not, so
  // concurrent AVPlayer viewers each held an unaccounted upstream connection.
  streamConcurrency().heartbeatByResource(v.sub, 'remux', streamId)

  const creds = credsFromEnv()
  const upstreamUrlFor = (sid: string) =>
    `${creds.host}/live/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${sid}.ts`
  const upstreamUrl = upstreamUrlFor(streamId)

  // Dead-feed failover (Fox Soccer Plus incident): the ordered candidate feeds
  // for this channel (itself first, then siblings sharing epg_channel_id /
  // normalized name). ensureLiveRemuxEntry skips any candidate remembered as a
  // dead placeholder and dials a live sibling; if ALL candidates are dead the
  // channel is offline upstream (terminal), which we surface distinctly below.
  const candidateFeeds = resolveSiblingFeeds(iptvDb().raw, streamId)
  const ensureOpts = {
    streamId,
    sub: v.sub,
    upstreamUrl,
    siblingFeeds: () => candidateFeeds,
    upstreamUrlFor,
  }

  // NOTE: freeing the viewer's OTHER live channels happens once at GRANT time
  // (see the avplayer branch of POST .../grant), NOT here. AVPlayer re-fetches
  // this manifest every ~2s; doing the teardown on this hot path made two
  // overlapping live sessions for one sub (a channel switch where the old
  // player fires one more poll, or a second device) mutually annihilate — each
  // poll killed the other's ffmpeg, so neither ever built a segment window and
  // every channel showed infinite buffering / black screen.
  let entry = ensureLiveRemuxEntry(ensureOpts)
  // null has two causes, which the client must handle DIFFERENTLY:
  //  - channel_offline_upstream (terminal): every candidate feed is a dead
  //    placeholder — the channel is off the air upstream. No Retry-After; the
  //    client should stop polling and offer the user an alternative, not spin.
  //  - remux_warming (transient): the channel is merely in its reconnect-
  //    throttle cooldown after a fast failure. Short Retry-After; re-dialing
  //    here is the churn that trips the provider abuse block, so we don't.
  if (!entry) {
    if (isChannelOfflineUpstream(candidateFeeds)) {
      return c.json({ error: 'channel_offline_upstream' }, 503)
    }
    c.header('Retry-After', '3')
    return c.json({ error: 'remux_warming' }, 503)
  }

  heartbeatRemuxSession(entry.sessionId)
  // 15s, not 8s: a larger ffmpeg probe ceiling (see iptvRemux's -analyzeduration
  // 10M, needed for late-declaring HEVC channels) can push the first segment past
  // 8s, and an initial-load 504 is fatal to AVPlayer. The client's own readiness
  // watchdog still gives up at 25s, so this stays well inside that.
  // Wait for a small STARTING WINDOW, not just for index.m3u8 to appear: a
  // one-segment playlist makes hls.js error on the first load (the "first click
  // fails, second works" report). 15s ceiling, well inside the client's 25s
  // readiness watchdog and enough for ~4 × 2s segments plus a slow cold probe.
  const START_SEGMENTS = 4
  const deadline = Date.now() + 15_000
  while (!remuxManifestReady(entry.manifestPath, START_SEGMENTS) && Date.now() < deadline) {
    await sleep(200)
    // A copy session can kill itself on detecting a non-H.264 input (it can't
    // produce playable Apple HLS then). Re-ensure each tick so it respawns as a
    // re-encode session and we wait on the NEW manifest — all in this request.
    // ensureLiveRemuxEntry returns the same entry while the session is alive,
    // and null while a just-died session is in reconnect cooldown — in which
    // case stop waiting rather than busy-loop, and let the client retry.
    const next = ensureLiveRemuxEntry(ensureOpts)
    if (!next) break
    entry = next
    heartbeatRemuxSession(entry.sessionId)
  }
  // A slow channel may have <START_SEGMENTS at the deadline; serve whatever it
  // has rather than fail. Only a manifest that never appeared at all is a retry.
  // Do NOT forget/stop the session here: it may still be slowly producing, and
  // forgetting it just feeds the respawn churn. Answer 503 so the client polls
  // again (the reconnect throttle gates any actual re-dial) — UNLESS every
  // candidate feed is a dead placeholder, in which case surface the terminal
  // channel_offline_upstream instead of an indistinguishable warming retry.
  if (!entry || !fs.existsSync(entry.manifestPath)) {
    if (isChannelOfflineUpstream(candidateFeeds)) {
      return c.json({ error: 'channel_offline_upstream' }, 503)
    }
    c.header('Retry-After', '3')
    return c.json({ error: 'remux_warming' }, 503)
  }

  const rewritten = rewriteRemuxManifest(
    fs.readFileSync(entry.manifestPath, 'utf-8'),
    streamId,
    entry.sessionId,
    v.sub,
    entry.segUrlCache,
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
    claims = verifyStreamToken(env.streamTokenSecret, t)
    if (claims.k !== 'remux') throw new Error('kind_mismatch')
  } catch (err) {
    return c.json({ error: 'invalid_token', detail: err instanceof Error ? err.message : String(err) }, 401)
  }
  const remuxReplay = checkReplay(claims.jti, claims.exp, 'remux')
  if (!remuxReplay.allowed) return c.json({ error: remuxReplay.reason }, 401)


  const resource = remuxSegmentResource(claims.rid)
  if (!resource) return c.json({ error: 'bad_resource' }, 400)

  const entry = getActiveLiveRemuxEntry(streamId, claims.sub)
  if (!entry || entry.sessionId !== resource.sessionId) return c.json({ error: 'session_gone' }, 410)

  const filePath = path.join(entry.dir, resource.segFile)
  if (!fs.existsSync(filePath)) return c.json({ error: 'segment_gone' }, 404)

  heartbeatRemuxSession(entry.sessionId)
  // Refresh the concurrency slot on each segment fetch too, so a steadily-
  // playing AVPlayer that polls segments faster than the manifest still keeps
  // its slot accounted against the cap.
  streamConcurrency().heartbeatByResource(claims.sub, 'remux', streamId)
  const stream = fs.createReadStream(filePath)
  return new Response(nodeReadableToWebStream(stream), {
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

  const resourceId = `${streamId}|${startUtc}|${durationMin}`
  const v = checkToken(c, 'catchup', resourceId)
  if (!v.ok) return v.resp
  // Finding 8-1: keep the grant slot alive while catch-up bytes flow.
  streamConcurrency().heartbeatByResource(v.sub, 'catchup', resourceId)

  const creds = credsFromEnv()
  const upstreamUrl =
    `${creds.host}/streaming/timeshift.php?username=${encodeURIComponent(creds.username)}` +
    `&password=${encodeURIComponent(creds.password)}&stream=${streamId}&start=${xtreamStart}&duration=${durationMin}`

  const controller = new AbortController()
  c.req.raw.signal.addEventListener('abort', () => {
    controller.abort()
    streamConcurrency().releaseByResource(v.sub, 'catchup', resourceId)
  }, { once: true })
  // SSRF: trusted creds origin, redirect targets re-validated (findings 8-0/16-0).
  let upstream: Response
  try {
    upstream = await guardedFetchTrustedOrigin(upstreamUrl, { signal: controller.signal })
  } catch (err) {
    if (err instanceof SsrfBlockedError) return c.json({ error: 'bad_upstream' }, 400)
    throw err
  }
  if (!upstream.ok || !upstream.body) return c.json({ error: `upstream_${upstream.status}` }, 502)

  const heartbeatBody = upstream.body.pipeThrough(
    makeHeartbeatStream(() => streamConcurrency().heartbeatByResource(v.sub, 'catchup', resourceId)),
  )
  return new Response(heartbeatBody, {
    status: 200,
    headers: {
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'no-store',
    },
  })
})

iptv.post('/stream/vod/:streamId/grant', requireAuth, requireSection('live'), async (c) => {
  // IPTV VOD lives under the same `live` section as the live/catchup grants
  // (the whole IPTV catalog is surfaced under the client's Live tab), so a
  // member whose policy denies Live TV must not be able to mint a VOD stream
  // token either. Enforced on the grant (the sole token-mint point) so a
  // tampered client or replayed API call can't bypass it.
  // IPTV provider content is UNRATED (star ratings, never certifications) —
  // a parental rating cap therefore blocks these grants wholesale (fail
  // closed, same rule the clients apply to unrated titles).
  if (await capBlocksUnrated(c.get('session'))) {
    return c.json({ error: 'rating_blocked' }, 403)
  }
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
    // On-demand playback re-presents this token on every range GET / HLS
    // segment fetch across the whole runtime — the 300s finite-asset TTL froze
    // playback at ~5min. Playback-duration TTL, like local media.
    kind: 'vod', resourceId: streamId, sub, ttlSecs: env.IPTV_ONDEMAND_TOKEN_TTL_SECS,
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
  // MED/LOW-24: streamId and ext are interpolated RAW into the upstream provider
  // URL (`${host}/movie/${u}/${p}/${streamId}.${ext}`). A `%3F`-decoded `?` (or
  // other specials) in ext would inject query params into that request. Hono's
  // single-segment param already blocks `/`, but constrain both to plain tokens
  // before they reach the URL — same guard the series route uses on episodeId.
  if (!/^[\w-]+$/.test(streamId) || !/^[a-z0-9]{1,5}$/.test(ext)) {
    return c.json({ error: 'invalid_id' }, 400)
  }
  const v = checkToken(c, 'vod', streamId)
  if (!v.ok) return v.resp
  // Finding 8-1: each range request heartbeats the grant slot so a long VOD
  // playback (or a player paused >30s then resumed) keeps its slot.
  streamConcurrency().heartbeatByResource(v.sub, 'vod', streamId)

  const creds = credsFromEnv()
  const upstreamUrl = `${creds.host}/movie/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${streamId}.${ext}`
  if (ext === 'm3u8') {
    return await fetchAndRewriteHlsPlaylist({ upstreamUrl, sub: v.sub, clientSignal: c.req.raw.signal })
  }

  const mime = ext === 'mkv' ? 'video/x-matroska' : 'video/mp4'
  return await proxyRangeableUpstream({
    upstreamUrl,
    mime,
    range: c.req.header('range') ?? null,
    clientSignal: c.req.raw.signal,
    // Client gone mid-stream → free the slot now (same as live/catchup).
    onClientAbort: () => streamConcurrency().releaseByResource(v.sub, 'vod', streamId),
  })
})

iptv.post('/stream/series/:episodeId/grant', requireAuth, requireSection('live'), async (c) => {
  // IPTV series episodes live under the same `live` section as the live/catchup
  // grants (the whole IPTV catalog is surfaced under the client's Live tab), so
  // a member whose policy denies Live TV must not be able to mint a series
  // stream token either. Enforced on the grant (the sole token-mint point) so a
  // tampered client or replayed API call can't bypass it.
  // IPTV provider content is UNRATED (star ratings, never certifications) —
  // a parental rating cap therefore blocks these grants wholesale (fail
  // closed, same rule the clients apply to unrated titles).
  if (await capBlocksUnrated(c.get('session'))) {
    return c.json({ error: 'rating_blocked' }, 403)
  }
  const episodeId = c.req.param('episodeId')
  if (!/^[\w-]+$/.test(episodeId)) return c.json({ error: 'invalid_id' }, 400)
  const { sub } = userOf(c)
  const row = containerExtensionRow(
    iptvDb().raw
      .prepare('SELECT container_extension FROM series_episodes WHERE episode_id = ?')
      .get(episodeId),
  )
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
    // On-demand playback re-presents this token on every range GET / HLS
    // segment fetch across the whole runtime — the 300s finite-asset TTL froze
    // playback at ~5min. Playback-duration TTL, like local media.
    kind: 'series', resourceId: episodeId, sub, ttlSecs: env.IPTV_ONDEMAND_TOKEN_TTL_SECS,
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
  // MED/LOW-24: episodeId and ext are interpolated RAW into the upstream provider
  // URL (`${host}/series/${u}/${p}/${episodeId}.${ext}`). A `%3F`-decoded `?` (or
  // other specials) in ext would inject query params into that request. Hono's
  // single-segment param already blocks `/`, but constrain both to plain tokens
  // before they reach the URL — the same guard the VOD byte route applies.
  if (!/^[\w-]+$/.test(episodeId) || !/^[a-z0-9]{1,5}$/.test(ext)) {
    return c.json({ error: 'invalid_id' }, 400)
  }
  const v = checkToken(c, 'series', episodeId)
  if (!v.ok) return v.resp
  // Finding 8-1: heartbeat the grant slot on each series byte/range request.
  streamConcurrency().heartbeatByResource(v.sub, 'series', episodeId)

  const creds = credsFromEnv()
  const upstreamUrl = `${creds.host}/series/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${episodeId}.${ext}`
  if (ext === 'm3u8') {
    return await fetchAndRewriteHlsPlaylist({ upstreamUrl, sub: v.sub, clientSignal: c.req.raw.signal })
  }

  const mime = ext === 'mkv' ? 'video/x-matroska' : 'video/mp4'
  return await proxyRangeableUpstream({
    upstreamUrl,
    mime,
    range: c.req.header('range') ?? null,
    clientSignal: c.req.raw.signal,
    // Client gone mid-stream → free the slot now (same as live/catchup).
    onClientAbort: () => streamConcurrency().releaseByResource(v.sub, 'series', episodeId),
  })
})

iptv.get('/stream/segment', async (c) => {
  const t = c.req.query('u') ?? ''
  let claims: ReturnType<typeof verifyStreamToken>
  try {
    claims = verifyStreamToken(env.streamTokenSecret, t)
    if (claims.k !== 'segment') throw new Error('kind_mismatch')
  } catch (err) {
    return c.json({ error: 'invalid_token', detail: err instanceof Error ? err.message : String(err) }, 401)
  }
  // Segment tokens are multi-use within their 300s TTL (MED-17): HLS players
  // legitimately re-fetch a segment on seek-back / buffer recovery. The token is
  // bound to one segment URL and short-lived, so this is a secondary expiry
  // check, not a single-use gate.
  const segReplay = checkReplay(claims.jti, claims.exp, 'segment')
  if (!segReplay.allowed) return c.json({ error: segReplay.reason }, 401)

  const upstream = claims.rid
  let url: URL
  try {
    url = new URL(upstream)
  } catch {
    return c.json({ error: 'bad_upstream' }, 400)
  }
  // SSRF containment: a segment token's `rid` is derived from upstream-
  // provider-controlled HLS manifest lines (rewriteManifest → resolveUrl,
  // where an *absolute* URL in the manifest overrides our base). Without a
  // guard, a malicious or compromised IPTV panel — or any redirect in the
  // manifest chain — could point a segment at a link-local / internal host
  // (e.g. 169.254.169.254 cloud-metadata, container-internal services like
  // recommender:8000, the docker gateway) and we would proxy it straight
  // back to the caller. We can't pin to a single host (legit providers serve
  // segments from separate public CDNs), so we enforce the standard SSRF
  // defense: https only, and reject any host that resolves to a private,
  // loopback, link-local, or otherwise non-public address.
  if (!isPublicHttpsUpstream(url)) {
    return c.json({ error: 'bad_upstream' }, 400)
  }

  if (url.pathname.toLowerCase().endsWith('.m3u8')) {
    return await fetchAndRewriteHlsPlaylist({
      upstreamUrl: upstream,
      sub: claims.sub,
      clientSignal: c.req.raw.signal,
    })
  }

  const controller = new AbortController()
  c.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true })
  const range = c.req.header('range')
  // guardedFetch re-validates resolved IPs + every redirect hop on this
  // attacker-influenceable segment URL (the isPublicHttpsUpstream check above
  // is the cheap up-front string reject) — findings 8-0/16-0.
  let upstreamRes: Response
  try {
    upstreamRes = await guardedFetch(upstream, { signal: controller.signal, headers: range ? { Range: range } : {} })
  } catch (err) {
    if (err instanceof SsrfBlockedError) return c.json({ error: 'bad_upstream' }, 400)
    throw err
  }
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
