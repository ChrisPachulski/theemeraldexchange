// /api/iptv history routes, split from the former single iptv.ts (paths unchanged).

import { Hono } from 'hono'
import { requireAuth } from '../../middleware/auth.js'
import { requireSection } from '../../services/userPolicies.js'
import { iptvDb } from '../../services/iptvDbSingleton.js'
import { postFeedback } from '../../services/recommender.js'
import { recommenderCallerFromSession } from '../../services/recommenderCaller.js'
import { type Session } from '../../session.js'
import { crossedWatchThreshold, type WatchPoint } from '../../services/watchSignal.js'
import { env } from '../../env.js'
import { type Env } from '../../middleware/auth.js'
import { KINDS, HIST_KINDS, userOf } from './shared.js'

export const iptv = new Hono<Env>()

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

// Favorites + continue-watching ARE the live section's user data (the item IDs
// are live/vod/series rows from the same catalog), so they carry the same
// requireSection('live') gate as the catalog, EPG, and grant routes above.
// Without it a member denied Live TV could still read back — and keep writing —
// the very channels and titles the section gate cut them off from.
iptv.get('/favorites', requireAuth, requireSection('live'), (c) => {
  const { sub } = userOf(c)
  const rows = iptvDb().stmts.getFavorites.all(sub)
  return c.json(rows)
})

iptv.post('/favorites', requireAuth, requireSection('live'), async (c) => {
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

iptv.delete('/favorites/:kind/:itemId', requireAuth, requireSection('live'), (c) => {
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

iptv.get('/history', requireAuth, requireSection('live'), (c) => {
  const { sub } = userOf(c)
  const rows = iptvDb().stmts.getHistory.all(sub, parseHistoryLimit(c.req.query('limit')))
  return c.json(rows)
})

iptv.post('/history', requireAuth, requireSection('live'), async (c) => {
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
