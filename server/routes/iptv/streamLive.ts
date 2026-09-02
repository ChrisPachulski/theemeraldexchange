// /api/iptv streamLive routes, split from the former single iptv.ts (paths unchanged).

import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { requireAuth } from '../../middleware/auth.js'
import { requireSection } from '../../services/userPolicies.js'
import { capBlocksUnrated } from '../../services/parentalRating.js'
import { credsFromEnv } from '../../services/xtream.js'
import { nodeReadableToWebStream } from '../../services/streamBridge.js'
import { iptvDb } from '../../services/iptvDbSingleton.js'
import { signStreamToken, verifyStreamToken } from '../../services/iptvStreamToken.js'
import { checkReplay } from '../../services/tokenReplayCache.js'
import { resolveSourcePrecedence } from '../../services/sourcePrecedence.js'
import { streamConcurrency } from '../../services/iptvConcurrency.js'
import { guardedFetchTrustedOrigin, SsrfBlockedError } from '../../services/ssrfGuard.js'
import { heartbeatRemuxSession, channelIsDeadFeed, markChannelDeadFeed, DEAD_FEED_CLEAN_EOF_MS } from '../../services/iptvRemux.js'
import { ensureLiveRemuxEntry, dropOtherLiveRemuxSessions, getActiveLiveRemuxEntry, isChannelOfflineUpstream, remuxManifestReady, remuxSegmentResource, rewriteRemuxManifest } from '../../services/iptvLiveRemuxMap.js'
import { resolveSiblingFeeds } from '../../services/iptvSiblingFeeds.js'
import { channelArchiveRow } from '../../services/iptvRows.js'
import { env } from '../../env.js'
import { type Env } from '../../middleware/auth.js'
import { clientIp, sessionTitle, enrichSessionsFor, userOf, clientWantsAvplayer, makeHeartbeatStream, formatXtreamTimeshiftStart, parsePositiveInt, checkToken, sleep } from './shared.js'

export const iptv = new Hono<Env>()

iptv.post('/stream/live/:streamId/grant', requireAuth, requireSection('live'), async (c) => {
  // IPTV provider content is UNRATED (star ratings, never certifications) —
  // a parental rating cap therefore blocks these grants wholesale (fail
  // closed, same rule the catchup / VOD / series grants apply to the same
  // unrated provider content). Live was the one hole: a capped member who
  // could not play a channel's catchup archive could still tune it live.
  if (await capBlocksUnrated(c.get('session'))) {
    return c.json({ error: 'rating_blocked' }, 403)
  }
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
    return c.json({ ...acquired, sessions: enrichSessionsFor(acquired.sessions, sub, c.get('session').role === 'admin') }, 429)
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
    return c.json({ ...acquired, sessions: enrichSessionsFor(acquired.sessions, sub, c.get('session').role === 'admin') }, 429)
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
