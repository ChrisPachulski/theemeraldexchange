import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import IptvPlayer from '../player/IptvPlayer'
import type { StreamGrant } from '../../lib/api/iptv'
import { mediaApi, type PlayableKind, type PlaybackGrant } from '../../lib/api/media'
import { useReportWatch } from '../../lib/hooks/useMediaLibrary'

const HEARTBEAT_INTERVAL_MS = 10_000
// Treat the title as finished when within this many seconds of the end so the
// trailing credits don't leave it stuck at "99% — resume".
const COMPLETE_TAIL_SECS = 30

type Props = {
  kind: PlayableKind
  id: number
  title: string
  /** Resume point from prior watch state (direct-play seeks here on load). */
  startPositionSecs?: number
  onClose: () => void
}

/**
 * Local-media player modal. Fetches a playback grant (direct-play or
 * transcoded HLS), reuses the shared IptvPlayer engine, persists watch progress
 * (throttled, with a final flush on close), and heartbeats transcode sessions
 * so they aren't reaped mid-watch.
 */
export function MediaPlayer({ kind, id, title, startPositionSecs, onClose }: Props) {
  const [grant, setGrant] = useState<PlaybackGrant | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [playbackEnded, setPlaybackEnded] = useState(false)
  const report = useReportWatch(kind, id)
  // Latest (position, duration) so unmount/close can flush an exact resume point.
  const latest = useRef<{ pos: number; dur: number | null }>({
    pos: startPositionSecs ?? 0,
    dur: null,
  })
  // Latest stopUrl in a ref so the unmount/pagehide cleanups can free the
  // transcoder slot without re-subscribing on every grant change.
  const stopUrlRef = useRef<string | null>(null)
  useEffect(() => {
    stopUrlRef.current = grant?.stopUrl ?? null
  }, [grant?.stopUrl])

  // Free the transcode session's concurrency slot. Idempotent (nulls the ref
  // after firing; the transcoder /stop is itself idempotent), so calling it
  // from onEnded AND unmount AND pagehide is safe.
  const stopSession = useCallback(() => {
    const url = stopUrlRef.current
    if (!url) return
    stopUrlRef.current = null
    void mediaApi.stop(url)
  }, [])

  // Fetch the grant once. Callers key this by title, so a new selection remounts
  // it fresh (state starts null) rather than mutating it here — no synchronous
  // reset needed.
  useEffect(() => {
    let cancelled = false
    mediaApi
      .playback(kind, id, undefined, startPositionSecs)
      .then((g) => {
        if (!cancelled) setGrant(g)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not start playback.')
      })
    return () => {
      cancelled = true
    }
  }, [kind, id, startPositionSecs])

  // Heartbeat the transcode session (direct-play grants have no heartbeatUrl).
  useEffect(() => {
    const url = grant?.heartbeatUrl
    if (playbackEnded) return undefined
    if (!url) return undefined
    const timer = window.setInterval(() => {
      void mediaApi.heartbeat(url)
    }, HEARTBEAT_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [grant?.heartbeatUrl, playbackEnded])

  // Esc closes the player.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Final flush on unmount so the resume point reflects where they actually
  // stopped, not the last throttled tick — and free the transcode slot.
  useEffect(() => {
    return () => {
      const { pos, dur } = latest.current
      if (pos > 0) {
        const completed = dur != null && pos >= Math.max(0, dur - COMPLETE_TAIL_SECS)
        report(pos, dur, completed, true)
      }
      stopSession()
    }
  }, [report, stopSession])

  // A hard page unload (tab close / navigation) doesn't run React cleanup, so
  // free the slot there too. mediaApi.stop uses keepalive to flush on unload.
  useEffect(() => {
    const onHide = () => stopSession()
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [stopSession])

  // Stable StreamGrant reference: a new object each render would make
  // IptvPlayer tear down and rebuild its (HLS) engine on every render.
  const streamGrant = useMemo<StreamGrant | null>(
    () => (grant ? { url: grant.url, delivery: grant.delivery } : null),
    [grant],
  )

  const onPositionUpdate = useCallback(
    (positionSecs: number, durationSecs: number | null) => {
      // For a transcoded (HLS) resume the backend bakes the offset into ffmpeg
      // (-ss start_secs), so the <video> timeline restarts near 0 — the real
      // content position is start_secs + currentTime. Direct-play (progressive)
      // serves the whole file with a true timeline, so currentTime is already
      // absolute. The HLS <video> "duration" is only the live window (or
      // Infinity), so trust the grant's full-title duration there too;
      // otherwise the completion check would fire seconds in.
      const isHls = grant?.delivery === 'hls'
      const offset = isHls ? (startPositionSecs ?? 0) : 0
      const absPos = offset + positionSecs
      const dur = isHls ? (grant?.durationSecs ?? null) : (durationSecs ?? grant?.durationSecs ?? null)
      latest.current = { pos: absPos, dur }
      const completed = dur != null && absPos >= Math.max(0, dur - COMPLETE_TAIL_SECS)
      report(absPos, dur, completed)
    },
    [report, grant?.delivery, grant?.durationSecs, startPositionSecs],
  )

  const onEnded = useCallback(() => {
    setPlaybackEnded(true)
    const dur = latest.current.dur ?? grant?.durationSecs ?? null
    report(latest.current.pos, dur, true, true)
    stopSession()
  }, [report, grant?.durationSecs, stopSession])

  return (
    <div className="iptv-player-modal" role="dialog" aria-modal="true" aria-label={title}>
      <div className="iptv-player-modal__header">
        <h2>{title}</h2>
        <button
          className="iptv-player-modal__close"
          type="button"
          onClick={onClose}
          aria-label="Close player"
        >
          ×
        </button>
      </div>
      {error && <p className="iptv-tab__status iptv-tab__status--error">{error}</p>}
      {!error && !streamGrant && <p className="iptv-tab__status">Starting playback…</p>}
      {streamGrant && (
        <IptvPlayer
          grant={streamGrant}
          autoPlay
          // Only the progressive (direct-play) path has a real, full-length
          // timeline to seek into. For HLS the resume offset is already baked
          // server-side via ffmpeg -ss, so a client seek would jump past the
          // live window's end and stall at a spinner (the de9411c regression).
          startPositionSecs={grant?.delivery === 'progressive' ? startPositionSecs : undefined}
          onPositionUpdate={onPositionUpdate}
          onEnded={onEnded}
        />
      )}
    </div>
  )
}

export default MediaPlayer
