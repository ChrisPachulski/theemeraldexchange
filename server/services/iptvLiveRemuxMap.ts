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
import { listRemuxSessions, startRemuxSession, stopRemuxSession } from './iptvRemux.js'

export type LiveRemuxEntry = { sessionId: string; dir: string; manifestPath: string }

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
    })
    entry = { sessionId: session.sessionId, dir: session.dir, manifestPath: session.manifestPath }
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
  stopRemuxSession(sessionId)
}

/** Rewrite the on-disk manifest's segment lines into tokenised
 *  `/remux/seg` proxy URLs bound to this session + viewer. */
export function rewriteRemuxManifest(
  text: string,
  streamId: string,
  sessionId: string,
  sub: string,
): string {
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
