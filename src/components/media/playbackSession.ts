// Framework-free playback-session controller for MediaPlayer. The grant /
// heartbeat / stop lifecycle lives here, dependency-injected at the
// api-client boundary, so the node vitest environment (no DOM — component
// effects can't be mounted) can drive every branch directly.

import type { PlayableKind, PlaybackCaps, PlaybackGrant } from '../../lib/api/media'

export const HEARTBEAT_INTERVAL_MS = 10_000

// Treat the title as finished when within this many seconds of the end so the
// trailing credits don't leave it stuck at "99% — resume".
export const COMPLETE_TAIL_SECS = 30

/** The slice of mediaApi the session drives (the mock boundary in tests). */
export type PlaybackSessionApi = {
  playback: (
    kind: PlayableKind,
    id: number,
    caps?: PlaybackCaps,
    startPositionSecs?: number,
    forceHls?: boolean,
  ) => Promise<PlaybackGrant>
  /** Resolves to the HTTP status, or undefined on network failure. */
  heartbeat: (url: string) => Promise<number | undefined>
  stop: (url: string) => unknown
}

export type PlaybackSessionHandlers = {
  onGrant: (grant: PlaybackGrant) => void
  onGrantError: (message: string) => void
  /** A heartbeat answered 404: the transcoder reaped the session, so the
   *  stream is a corpse. Heartbeats have already stopped; surface a
   *  re-grant-able error instead of silently freezing. */
  onSessionLost: () => void
}

export type PlaybackSession = {
  /** Stop heartbeating and free the transcoder slot. Idempotent (the stop URL
   *  is dropped before firing; the transcoder /stop is itself idempotent), so
   *  onEnded AND unmount AND pagehide can all call it safely. */
  stop: () => void
  /** stop() + suppress every still-pending callback. Call on unmount. */
  dispose: () => void
}

export function startPlaybackSession(args: {
  kind: PlayableKind
  id: number
  startPositionSecs?: number
  /** Demand buffered (HLS) delivery — the stall-escalation re-grant path. */
  forceHls?: boolean
  api: PlaybackSessionApi
  handlers: PlaybackSessionHandlers
  heartbeatIntervalMs?: number
}): PlaybackSession {
  const { api, handlers } = args
  const intervalMs = args.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
  let disposed = false
  let stopped = false
  let stopUrl: string | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  const clearHeartbeat = () => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  const stop = () => {
    stopped = true
    clearHeartbeat()
    const url = stopUrl
    stopUrl = null
    if (url) void api.stop(url)
  }

  void api
    .playback(args.kind, args.id, undefined, args.startPositionSecs, args.forceHls)
    .then((grant) => {
      if (disposed || stopped) {
        // Closed before the grant resolved — free the slot it just claimed
        // instead of leaking it to the transcoder's idle reaper.
        if (grant.stopUrl) void api.stop(grant.stopUrl)
        return
      }
      stopUrl = grant.stopUrl ?? null
      const heartbeatUrl = grant.heartbeatUrl
      if (heartbeatUrl) {
        timer = setInterval(() => {
          void api.heartbeat(heartbeatUrl).then((status) => {
            // A network blip (undefined) or any non-404 status keeps beating;
            // only a definitive 404 means the session is gone.
            if (disposed || stopped || status !== 404) return
            // Stop heartbeating the corpse and drop the stop URL — it points
            // at the same dead session.
            clearHeartbeat()
            stopUrl = null
            handlers.onSessionLost()
          })
        }, intervalMs)
      }
      handlers.onGrant(grant)
    })
    .catch((e: unknown) => {
      if (disposed || stopped) return
      handlers.onGrantError(e instanceof Error ? e.message : 'Could not start playback.')
    })

  return {
    stop,
    dispose: () => {
      disposed = true
      stop()
    },
  }
}

// ── Pure playback math (shared by MediaPlayer's progress reporting) ───

/** Only the progressive (direct-play) path has a real, full-length timeline
 *  to seek into. For HLS the resume offset is already baked server-side via
 *  ffmpeg -ss, so a client seek would jump past the live window's end and
 *  stall at a spinner (the de9411c regression). Accepts the wider IPTV
 *  StreamDelivery so the shared-player view can call it directly. */
export function playerStartPosition(
  delivery: PlaybackGrant['delivery'] | 'mpegts',
  startPositionSecs?: number,
): number | undefined {
  return delivery === 'progressive' ? startPositionSecs : undefined
}

/** Timeline length for a transcoded (HLS) grant, used to pin
 *  MediaSource.duration so the player's total time reads full-length from the
 *  first frame instead of creeping up with the growing transcode playlist
 *  (see IptvPlayer's createHlsDurationPin). The hls.js engine presents the
 *  session at ABSOLUTE title time (`timelineOffset` shifts the -ss session to
 *  its real start), so the pin is the FULL title duration — the absolute end
 *  of the timeline — regardless of any resume offset. Null (no pin) for
 *  progressive delivery — the original file already reports its true
 *  duration — and whenever the grant carries no duration. */
export function hlsPinnedDurationSecs(args: {
  delivery: PlaybackGrant['delivery']
  grantDurationSecs: number | null
}): number | null {
  if (args.delivery !== 'hls' || args.grantDurationSecs == null) return null
  const dur = args.grantDurationSecs
  return Number.isFinite(dur) && dur > 0 ? dur : null
}

/** Which timeline the <video> element reports for an HLS session:
 *  'absolute' — the hls.js (MSE) engine applies `timelineOffset`, so
 *  currentTime is already real title time; 'session' — the native-HLS engine
 *  (iOS Safari, no hls.js) plays the raw -ss session, whose timeline restarts
 *  at 0 and needs the resume offset added back. */
export type PlayerTimelineMode = 'absolute' | 'session'

/** Map the <video> element's (position, duration) to absolute title progress.
 *  For a transcoded (HLS) session the offset handling depends on the engine's
 *  timeline mode (see PlayerTimelineMode): in 'session' mode the real content
 *  position is start_secs + currentTime; in 'absolute' mode currentTime is
 *  already title time and adding the offset would double-count. Either way
 *  the element "duration" is only the live window (or Infinity), so the
 *  grant's full-title duration is authoritative. Direct-play (progressive)
 *  serves the whole file with a true timeline, so currentTime is already
 *  absolute. */
export function absoluteProgress(args: {
  delivery: PlaybackGrant['delivery']
  grantDurationSecs: number | null
  startPositionSecs?: number
  positionSecs: number
  durationSecs: number | null
  timelineMode?: PlayerTimelineMode
}): { pos: number; dur: number | null; completed: boolean } {
  const isHls = args.delivery === 'hls'
  const offset = isHls && args.timelineMode !== 'absolute' ? (args.startPositionSecs ?? 0) : 0
  const pos = offset + args.positionSecs
  const dur = isHls
    ? args.grantDurationSecs
    : (args.durationSecs ?? args.grantDurationSecs ?? null)
  const completed = dur != null && pos >= Math.max(0, dur - COMPLETE_TAIL_SECS)
  return { pos, dur, completed }
}

/** Human playback clock for the resume prompt: H:MM:SS past the hour, M:SS
 *  under it (1:02:05, 13:24, 0:42) — matching how native controls render. */
export function formatPlaybackTime(secs: number): string {
  const total = Math.max(0, Math.floor(secs))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
