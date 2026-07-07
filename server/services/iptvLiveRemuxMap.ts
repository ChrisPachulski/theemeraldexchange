// Live remux (AVPlayer HLS) session index. Extracted from routes/iptv.ts.
//
// Maps (streamId, sub) → the active ffmpeg remux session so repeated
// manifest polls from the same viewer reuse one transcode instead of
// spawning a new ffmpeg per poll. The underlying process lifecycle
// (spawn / heartbeat / idle-reap) lives in iptvRemux.ts; this module
// only owns the lookup index and the manifest/segment naming glue.

import fs from 'node:fs'
import path from 'node:path'
import { env } from '../env.js'
import { signStreamToken } from './iptvStreamToken.js'
import {
  channelIsDeadFeed,
  channelNeedsReencode,
  listRemuxSessions,
  startRemuxSession,
  stopRemuxSession,
} from './iptvRemux.js'

export type LiveRemuxEntry = {
  sessionId: string
  dir: string
  manifestPath: string
  // The channel the VIEWER tuned — the client-facing id. Stays constant across
  // a dead-feed failover so the manifest/segment URLs, the (streamId, sub)
  // index key, and dropOtherLiveRemuxSessions all keep referring to the tuned
  // channel even when the underlying upstream is a sibling feed.
  streamId: string
  // The feed stream_id we ACTUALLY dialed upstream. Equals `streamId` normally;
  // a sibling id after a dead-feed failover. Used to attribute a dead-feed
  // death to the right variant on the next ensure.
  dialedStreamId: string
  sub: string
  // segFile -> the fully-tokenised /remux/seg URL minted the FIRST time that
  // segment appeared in the manifest. Reused on every later poll so a given
  // segment's URL is byte-identical across playlist reloads (HLS / RFC 8216
  // §6.3.4: a Media Segment's URI must not change for the same Media Sequence
  // Number, or AVPlayer rejects the reloaded live playlist with
  // "-12312 Media Entry URL not match previous playlist" and stalls forever).
  // Self-pruned to the live window by rewriteRemuxManifest.
  segUrlCache: Map<string, string>
}

const liveRemuxIndex = new Map<string, LiveRemuxEntry>()

// ── Reconnect throttle (provider abuse-block guard) ──────────────────────────
//
// The provider caps simultaneous connections (a 1–2 connection plan) and, far
// worse, PUNISHES rapid re-dialing: open upstream connections too fast and it
// starts feeding CORRUPT, undecodable video to everyone until it cools down.
// The old failure mode: a corrupt feed makes ffmpeg exit 255 before it can build
// a starting window → the route forgets the session → the client retries → a NEW
// upstream connection opens within ~15s → more abuse → more corruption (a self-
// sustaining 255→respawn→corrupt→255 cycle that reads to the viewer as constant
// stutter / replay / eject / "can't find source").
//
// So: never re-dial a given channel faster than a backoff that WIDENS with each
// fast failure. The first connect is immediate (no added tune latency); a
// session that dies young (< FAST_FAIL_MS) escalates the gap; a session that ran
// healthily resets it. While a channel is in cooldown, ensureLiveRemuxEntry
// returns null and the caller serves a graceful retry instead of dialing again.
const RECONNECT_BASE_MS = 5_000
const RECONNECT_MAX_MS = 30_000
const FAST_FAIL_MS = 20_000

const lastConnectAt = new Map<string, number>() // key -> ms of the last upstream dial
const sessionSpawnAt = new Map<string, number>() // key -> ms the live session was spawned
const failStreak = new Map<string, number>() // key -> consecutive fast-fail count

// ── Cross-session media-sequence continuity (sibling-failover -12312 guard) ───
//
// A session swap — dead-feed failover to a sibling, or any respawn — starts a
// BRAND-NEW ffmpeg in a fresh dir whose HLS muxer restarts at
// #EXT-X-MEDIA-SEQUENCE:0 with all-new segment files. Served naively at the SAME
// manifest URL, the client-facing media sequence would jump BACKWARDS and every
// segment URL would change at once — AVPlayer rejects that reloaded live playlist
// ("-12312 Media Entry URL not match previous playlist") and freezes on a single
// frame until the client's stall watchdog tears the whole item down (~12-36s),
// even though a healthy sibling was already producing segments.
//
// So we keep the client-facing sequence MONOTONIC across swaps: per (streamId,
// sub) we carry an offset added to ffmpeg's local MEDIA-SEQUENCE, advanced on each
// swap to continue just past the highest sequence already served, plus an
// EXT-X-DISCONTINUITY-SEQUENCE bumped per swap so the player re-inits its decode
// timeline for the new feed instead of mis-splicing it. Steady state (no swap) is
// byte-for-byte unchanged: offset 0 and no discontinuity-sequence tag emitted.
type SequenceContinuity = {
  sessionId: string // the session `offset` was computed for; a change = a swap
  offset: number // added to ffmpeg's local MEDIA-SEQUENCE
  discontinuitySeq: number // EXT-X-DISCONTINUITY-SEQUENCE (0 until the first swap)
  lastServedMax: number // highest client-facing sequence served for this key (-1 = none)
}
const sequenceContinuity = new Map<string, SequenceContinuity>()

/** ffmpeg's local first-segment media sequence for this manifest (0 if absent). */
function parseLocalMediaSequence(text: string): number {
  const m = text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m)
  return m ? Number(m[1]) : 0
}

/** Backoff before the next upstream re-dial for a channel, by consecutive
 *  fast-failure count. 0 failures → 0 (immediate); then 5s, 10s, 20s, capped at
 *  30s. Pure so the throttle is unit-testable without a real clock. */
export function reconnectDelayMs(streak: number): number {
  if (streak <= 0) return 0
  return Math.min(RECONNECT_BASE_MS * 2 ** (streak - 1), RECONNECT_MAX_MS)
}

function remuxKey(streamId: string, sub: string): string {
  return `${streamId}:${sub}`
}

function isRemuxSessionActive(sessionId: string): boolean {
  return listRemuxSessions().some((s) => s.sessionId === sessionId)
}

/** Test seam: clear the index (the per-test remux mocks reset their own
 *  process state; this drops the route-layer lookup entries). */
export function _resetLiveRemuxIndexForTests(): void {
  liveRemuxIndex.clear()
  lastConnectAt.clear()
  sessionSpawnAt.clear()
  failStreak.clear()
  sequenceContinuity.clear()
}

export type EnsureLiveRemuxOpts = {
  streamId: string
  sub: string
  upstreamUrl: string
  // Dead-feed failover (optional; the route wires these, unit tests may not).
  // `siblingFeeds` returns the ORDERED candidate feed stream_ids for the tuned
  // channel — itself first, then siblings sharing epg_channel_id / normalized
  // name (see resolveSiblingFeeds). `upstreamUrlFor` builds the upstream URL for
  // a chosen candidate so a sibling can actually be dialed. Without them the
  // behaviour is unchanged: only the tuned feed is ever dialed.
  siblingFeeds?: () => string[]
  upstreamUrlFor?: (streamId: string) => string
}

/** The ordered candidate feeds for these opts (tuned feed first). */
function candidateFeeds(opts: EnsureLiveRemuxOpts): string[] {
  const list = opts.siblingFeeds?.()
  return list && list.length > 0 ? list : [opts.streamId]
}

/** Pick the first candidate feed NOT currently remembered as a dead placeholder,
 *  or null when EVERY candidate is a known dead feed (the channel is offline
 *  upstream — nothing left to dial). */
function pickLiveFeed(opts: EnsureLiveRemuxOpts): string | null {
  for (const cand of candidateFeeds(opts)) {
    if (!channelIsDeadFeed(cand)) return cand
  }
  return null
}

/** True when every candidate feed for `candidates` is a known dead placeholder,
 *  i.e. the channel is off the air upstream (terminal), as opposed to a session
 *  that is merely still warming. The manifest route uses this to split the two
 *  503s: `channel_offline_upstream` (terminal) vs `remux_warming` (retry). */
export function isChannelOfflineUpstream(candidates: string[]): boolean {
  return candidates.length > 0 && candidates.every((c) => channelIsDeadFeed(c))
}

/**
 * Return the live entry for (streamId, sub), starting a new remux session when
 * none exists or the recorded one's ffmpeg has exited (stale entries are dropped
 * on sight).
 *
 * Dead-feed failover: when the feed we dialed EOF'd cleanly-and-fast (a
 * dead-channel placeholder — see iptvRemux's channelIsDeadFeed), the next dial
 * skips it and advances to a live sibling feed of the same channel. If every
 * candidate feed is dead, this returns null and the caller distinguishes the
 * terminal case via isChannelOfflineUpstream.
 *
 * Returns null when (a) the channel is in its reconnect-throttle cooldown after
 * a recent fast failure, or (b) every candidate feed is a known dead placeholder
 * (channel offline). The caller must NOT dial again on null — for (a) it serves a
 * short retry so the provider's abuse block can cool; for (b) it surfaces a
 * terminal channel_offline_upstream. `now` is injectable for tests.
 */
export function ensureLiveRemuxEntry(
  opts: EnsureLiveRemuxOpts,
  now: number = Date.now(),
): LiveRemuxEntry | null {
  const key = remuxKey(opts.streamId, opts.sub)
  let entry = liveRemuxIndex.get(key)
  if (entry && !isRemuxSessionActive(entry.sessionId)) {
    // The session's ffmpeg has exited. Classify it.
    if (channelIsDeadFeed(entry.dialedStreamId)) {
      // A dead-channel placeholder EOF'd cleanly — NOT a corrupt-feed fast-fail.
      // Don't widen the reconnect backoff (that guards rapid re-dials of the
      // SAME corrupt upstream; a sibling is a different connection) and clear
      // the last-dial gate so the immediate sibling dial isn't throttled. The
      // dead-feed memory TTL is what stops us hammering the dead variant.
      failStreak.delete(key)
      lastConnectAt.delete(key)
    } else {
      // A young death (corrupt feed / abuse block) widens the reconnect backoff;
      // a session that ran a healthy while clears it so a re-tune is immediate.
      const lived = now - (sessionSpawnAt.get(key) ?? now)
      if (lived < FAST_FAIL_MS) failStreak.set(key, (failStreak.get(key) ?? 0) + 1)
      else failStreak.delete(key)
    }
    liveRemuxIndex.delete(key)
    sessionSpawnAt.delete(key)
    entry = undefined
  }
  if (!entry) {
    // Throttle: refuse to re-dial the provider faster than this channel's
    // backoff. First connect (streak 0) is immediate.
    const delay = reconnectDelayMs(failStreak.get(key) ?? 0)
    if (delay > 0 && now - (lastConnectAt.get(key) ?? 0) < delay) return null
    // Choose the feed to dial, skipping any known dead-channel placeholder and
    // failing over to a live sibling. Null = every candidate is dead (offline).
    const dialStreamId = pickLiveFeed(opts)
    if (dialStreamId === null) return null
    const dialUrl =
      dialStreamId === opts.streamId
        ? opts.upstreamUrl
        : (opts.upstreamUrlFor?.(dialStreamId) ?? opts.upstreamUrl)
    const session = startRemuxSession({
      streamId: dialStreamId,
      sub: opts.sub,
      upstreamUrl: dialUrl,
      // Skip the doomed copy attempt if this channel was already seen as
      // non-H.264; the first such tune starts as copy, detects it, and respawns.
      reencodeVideo: channelNeedsReencode(dialStreamId),
    })
    // null = startRemuxSession is at the hard upstream-connection cap and evicted
    // a session to free a slot; the new dial is deferred to the next poll (once
    // the evicted child releases its provider connection) so we never briefly
    // hold cap+1 connections. Nothing was dialed — record no connect and let the
    // caller serve a transient remux_warming.
    if (!session) return null
    lastConnectAt.set(key, now)
    sessionSpawnAt.set(key, now)
    entry = {
      sessionId: session.sessionId,
      dir: session.dir,
      manifestPath: session.manifestPath,
      streamId: opts.streamId,
      dialedStreamId: dialStreamId,
      sub: opts.sub,
      segUrlCache: new Map(),
    }
    liveRemuxIndex.set(key, entry)
  }
  return entry
}

/** Look up the ACTIVE entry for (streamId, sub); a stale (ffmpeg-exited)
 *  entry is dropped and reported as missing. */
export function getActiveLiveRemuxEntry(streamId: string, sub: string): LiveRemuxEntry | null {
  const key = remuxKey(streamId, sub)
  const entry = liveRemuxIndex.get(key)
  if (!entry) return null
  if (!isRemuxSessionActive(entry.sessionId)) {
    liveRemuxIndex.delete(key)
    return null
  }
  return entry
}

/** Drop the index entry AND stop the underlying remux session. */
export function forgetLiveRemuxEntry(streamId: string, sub: string, sessionId: string): void {
  liveRemuxIndex.delete(remuxKey(streamId, sub))
  stopRemuxSession(sessionId, 'forget')
}

/**
 * Stop every active live remux session for `sub` whose channel differs from
 * `keepStreamId`, freeing their upstream provider connections NOW instead of
 * waiting on the 30s/15s idle sweep. A viewer has one live tuner: tuning
 * channel X means any other live channel they had open (a channel switch, or a
 * ghost left by an app-close that an idle sweep hasn't reaped yet) must release
 * its upstream connection — on a 1–2 connection IPTV plan a lingering ghost is
 * exactly what triggers the provider's "max simultaneous connections" wall.
 * Returns the streamIds it stopped so the caller can also release their
 * concurrency slots.
 * ponytail: one live channel per sub; the provider's connection cap is the real
 * wall, so two live channels on one sub can't both stream regardless.
 */
export function dropOtherLiveRemuxSessions(sub: string, keepStreamId: string): string[] {
  const stopped: string[] = []
  for (const [key, entry] of liveRemuxIndex) {
    if (entry.sub === sub && entry.streamId !== keepStreamId) {
      liveRemuxIndex.delete(key)
      stopRemuxSession(entry.sessionId, 'drop-other')
      stopped.push(entry.streamId)
    }
  }
  return stopped
}

/** Rewrite the on-disk manifest's segment lines into tokenised
 *  `/remux/seg` proxy URLs bound to this session + viewer, and drop the
 *  spurious cold-start discontinuity (see below). */
export function rewriteRemuxManifest(
  text: string,
  streamId: string,
  sessionId: string,
  sub: string,
  // Per-session segFile -> tokenised URL cache. Pass the session's
  // entry.segUrlCache so a segment keeps one stable URL across polls. Omitted
  // by unit tests (whose signStreamToken mock is already deterministic).
  segUrlCache?: Map<string, string>,
): string {
  // Cross-session media-sequence continuity: decide this manifest's client-facing
  // first-segment sequence + discontinuity sequence BEFORE emitting the header, so
  // a session swap never resets the sequence backwards (the -12312 stall). See the
  // SequenceContinuity doc above. Keyed by the tuned (streamId, sub) so it survives
  // a dead-feed failover, whose sessionId change is exactly the swap signal.
  const contKey = remuxKey(streamId, sub)
  const localSeq = parseLocalMediaSequence(text)
  let cont = sequenceContinuity.get(contKey)
  if (!cont) {
    cont = { sessionId, offset: 0, discontinuitySeq: 0, lastServedMax: -1 }
    sequenceContinuity.set(contKey, cont)
  } else if (cont.sessionId !== sessionId) {
    // Session swap: continue just past the highest sequence we already served so
    // the client-facing sequence only ever increases, and bump the discontinuity
    // sequence so the player treats the new feed as a fresh timeline.
    cont.offset = Math.max(0, cont.lastServedMax + 1 - localSeq)
    cont.discontinuitySeq += 1
    cont.sessionId = sessionId
  }
  const adjustedFirst = localSeq + cont.offset

  let seenSegment = false
  let mediaSeqEmitted = false
  let segCount = 0
  const out: string[] = []
  const present = new Set<string>()
  // Emit the (possibly rewritten) MEDIA-SEQUENCE header + a DISCONTINUITY-SEQUENCE
  // when a swap has occurred. Idempotent via mediaSeqEmitted.
  const emitSequenceHeader = (): void => {
    if (mediaSeqEmitted) return
    out.push(`#EXT-X-MEDIA-SEQUENCE:${adjustedFirst}`)
    if (cont.discontinuitySeq > 0) out.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${cont.discontinuitySeq}`)
    mediaSeqEmitted = true
  }
  for (const line of text.split(/\r?\n/)) {
    // A `#EXT-X-DISCONTINUITY` before the FIRST segment is meaningless — the tag
    // describes a change BETWEEN two segments, and there is nothing before the
    // first. ffmpeg emits one at cold start from the initial PTS jump
    // (`+genpts`/`+discardcorrupt`). Apple's native HLS engine (AVPlayer on
    // tvOS/iOS) plays segment 0 then stalls on it FOREVER — the live channel
    // shows a single frozen frame and never advances; browsers' hls.js tolerates
    // it, which is why the web client works and Apple TV did not. The sliding
    // window eventually deletes segment 0 and the tag with it (~48 s), but a
    // viewer never waits that long. Drop the pre-first-segment discontinuity;
    // keep genuine mid-stream ones (provider splices/ad markers).
    if (!seenSegment && line.trim() === '#EXT-X-DISCONTINUITY') continue
    // Rewrite ffmpeg's local MEDIA-SEQUENCE to the monotonic client-facing value
    // (and inject the discontinuity sequence right after it on a swap).
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      emitSequenceHeader()
      continue
    }
    if (!line || line.startsWith('#')) {
      out.push(line)
      continue
    }
    const segFile = path.basename(line.trim())
    if (!/^seg_\d{5}\.ts$/.test(segFile)) {
      out.push(line)
      continue
    }
    // Defensive: a manifest with no MEDIA-SEQUENCE header still needs the swap's
    // sequence/discontinuity carried, so emit it just before the first segment.
    if (!seenSegment && (adjustedFirst > 0 || cont.discontinuitySeq > 0)) emitSequenceHeader()
    seenSegment = true
    segCount++
    present.add(segFile)
    // Reuse the URL minted on this segment's first appearance so it stays
    // byte-identical across reloads (see segUrlCache doc on LiveRemuxEntry).
    let url = segUrlCache?.get(segFile)
    if (!url) {
      const token = signStreamToken(env.streamTokenSecret, {
        kind: 'remux',
        resourceId: `${sessionId}/${segFile}`,
        sub,
        ttlSecs: env.IPTV_STREAM_TOKEN_TTL_SECS,
      })
      url = `/api/iptv/stream/live/${streamId}/remux/seg?t=${encodeURIComponent(token)}`
      segUrlCache?.set(segFile, url)
    }
    out.push(url)
  }
  // Drop cache entries for segments that have rolled off the sliding window so
  // the map stays bounded to the live set (≤ hls_list_size), not the whole
  // session history.
  if (segUrlCache) {
    for (const key of segUrlCache.keys()) {
      if (!present.has(key)) segUrlCache.delete(key)
    }
  }
  // Remember the highest client-facing sequence served so the NEXT session swap
  // continues above it. Only advance when this manifest actually carried segments.
  if (segCount > 0) {
    cont.lastServedMax = Math.max(cont.lastServedMax, adjustedFirst + segCount - 1)
  }
  return out.join('\n')
}

/** True once the on-disk manifest lists at least `minSegments` media segments.
 *  Returning the manifest the instant index.m3u8 first appears hands the player a
 *  one-segment playlist, and hls.js needs a few segments to establish the live
 *  edge or it errors on the very first load — the "first channel click fails, a
 *  second click works" report (the retry found the window already filled). Gate
 *  the first response on a small starting window instead. */
export function remuxManifestReady(manifestPath: string, minSegments: number): boolean {
  let text: string
  try {
    text = fs.readFileSync(manifestPath, 'utf-8')
  } catch {
    return false // not written yet
  }
  let count = 0
  for (const line of text.split(/\r?\n/)) {
    if (/^seg_\d{5}\.ts$/.test(line.trim()) && ++count >= minSegments) return true
  }
  return false
}

/** Parse a remux segment token's resource id (`<sessionId>/<segFile>`).
 *  Returns null on any malformed shape (no traversal past the session dir). */
export function remuxSegmentResource(
  resourceId: string,
): { sessionId: string; segFile: string } | null {
  const slash = resourceId.lastIndexOf('/')
  if (slash <= 0 || slash === resourceId.length - 1) return null
  const sessionId = resourceId.slice(0, slash)
  const segFile = resourceId.slice(slash + 1)
  if (!/^seg_\d{5}\.ts$/.test(segFile)) return null
  return { sessionId, segFile }
}
