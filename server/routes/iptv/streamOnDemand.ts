// /api/iptv streamOnDemand routes, split from the former single iptv.ts (paths unchanged).

import { Hono } from 'hono'
import { requireAuth } from '../../middleware/auth.js'
import { requireSection } from '../../services/userPolicies.js'
import { capBlocksUnrated } from '../../services/parentalRating.js'
import { credsFromEnv } from '../../services/xtream.js'
import { iptvDb } from '../../services/iptvDbSingleton.js'
import { getVodDetail } from '../../services/iptvCatalog.js'
import { signStreamToken, verifyStreamToken } from '../../services/iptvStreamToken.js'
import { checkReplay } from '../../services/tokenReplayCache.js'
import { resolveSourcePrecedence } from '../../services/sourcePrecedence.js'
import { streamConcurrency } from '../../services/iptvConcurrency.js'
import { isPublicUpstream, guardedFetch, SsrfBlockedError } from '../../services/ssrfGuard.js'
import { fetchAndRewriteHlsPlaylist, proxyRangeableUpstream } from '../../services/iptvHlsProxy.js'
import { parseSegmentOwner } from '../../services/iptvHlsRewrite.js'
import { containerExtensionRow } from '../../services/iptvRows.js'
import { env } from '../../env.js'
import { type Env } from '../../middleware/auth.js'
import { clientIp, sessionTitle, enrichSessionsFor, userOf, checkToken } from './shared.js'

export const iptv = new Hono<Env>()

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
    return c.json({ ...acquired, sessions: enrichSessionsFor(acquired.sessions, sub, c.get('session').role === 'admin') }, 429)
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
    // b5fa8293: an HLS VOD never comes back to this route — hls.js fetches the
    // VOD playlist once (#EXT-X-ENDLIST ⇒ no reload) and then talks only to
    // /stream/segment. Tag the rewritten URLs with this grant so those fetches
    // heartbeat the slot the heartbeat above can no longer reach.
    return await fetchAndRewriteHlsPlaylist({
      upstreamUrl,
      sub: v.sub,
      clientSignal: c.req.raw.signal,
      owner: { kind: 'vod', id: streamId },
    })
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
    return c.json({ ...acquired, sessions: enrichSessionsFor(acquired.sessions, sub, c.get('session').role === 'admin') }, 429)
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
    // b5fa8293 — same as VOD: the segment fetches are the only signal that this
    // episode is still playing, so they must carry the grant they belong to.
    return await fetchAndRewriteHlsPlaylist({
      upstreamUrl,
      sub: v.sub,
      clientSignal: c.req.raw.signal,
      owner: { kind: 'series', id: episodeId },
    })
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

  // b5fa8293: for HLS VOD/series this route IS the playback — the owning
  // /stream/vod|series/:id/m3u8 route runs once and never again, so without
  // this the grant's slot was idle-swept ~30s into a movie and the
  // IPTV_MAX_CONCURRENT_STREAMS cap silently stopped counting an active
  // viewer (the same defect already fixed for remux, live and progressive).
  // `sub` comes from the verified token, so a tampered ok/oid can only ever
  // touch the caller's own sessions; parseSegmentOwner still rejects any tag
  // that isn't a well-formed vod/series id before it reaches the tracker.
  const owner = parseSegmentOwner(c.req.query('ok'), c.req.query('oid'))
  if (owner) streamConcurrency().heartbeatByResource(claims.sub, owner.kind, owner.id)

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
  if (!isPublicUpstream(url)) {
    return c.json({ error: 'bad_upstream' }, 400)
  }

  if (url.pathname.toLowerCase().endsWith('.m3u8')) {
    // Carry the owner down the master → variant → media-segment chain, or the
    // heartbeat dies one level below the master playlist.
    return await fetchAndRewriteHlsPlaylist({
      upstreamUrl: upstream,
      sub: claims.sub,
      clientSignal: c.req.raw.signal,
      owner,
    })
  }

  const controller = new AbortController()
  c.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true })
  const range = c.req.header('range')
  // guardedFetch re-validates resolved IPs + every redirect hop on this
  // attacker-influenceable segment URL (the isPublicUpstream check above
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
