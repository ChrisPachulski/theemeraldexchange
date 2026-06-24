// Live remux (AVPlayer HLS) session index. Extracted from routes/iptv.ts.
//
// Maps (streamId, sub) → the active ffmpeg remux session so repeated
// manifest polls from the same viewer reuse one transcode instead of
// spawning a new ffmpeg per poll. The underlying process lifecycle
// (spawn / heartbeat / idle-reap) lives in iptvRemux.ts; this module
// only owns the lookup index and the manifest/segment naming glue.

import path from 'node:path'
import { env } from '../env.js'
import { signStreamToken } from './iptvStreamToken.js'
import { channelNeedsReencode, listRemuxSessions, startRemuxSession, stopRemuxSession } from './iptvRemux.js'

export type LiveRemuxEntry = {
  sessionId: string
  dir: string
  manifestPath: string
  streamId: string
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
}

/**
 * Return the live entry for (streamId, sub), starting a new remux
 * session when none exists or the recorded one's ffmpeg has exited
 * (stale entries are dropped on sight).
 */
export function ensureLiveRemuxEntry(opts: {
  streamId: string
  sub: string
  upstreamUrl: string
}): LiveRemuxEntry {
  const key = remuxKey(opts.streamId, opts.sub)
  let entry = liveRemuxIndex.get(key)
  if (entry && !isRemuxSessionActive(entry.sessionId)) {
    liveRemuxIndex.delete(key)
    entry = undefined
  }
  if (!entry) {
    const session = startRemuxSession({
      streamId: opts.streamId,
      sub: opts.sub,
      upstreamUrl: opts.upstreamUrl,
      // Skip the doomed copy attempt if this channel was already seen as
      // non-H.264; the first such tune starts as copy, detects it, and respawns.
      reencodeVideo: channelNeedsReencode(opts.streamId),
    })
    entry = {
      sessionId: session.sessionId,
      dir: session.dir,
      manifestPath: session.manifestPath,
      streamId: opts.streamId,
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
  let seenSegment = false
  const out: string[] = []
  const present = new Set<string>()
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
    if (!line || line.startsWith('#')) {
      out.push(line)
      continue
    }
    const segFile = path.basename(line.trim())
    if (!/^seg_\d{5}\.ts$/.test(segFile)) {
      out.push(line)
      continue
    }
    seenSegment = true
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
  return out.join('\n')
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
