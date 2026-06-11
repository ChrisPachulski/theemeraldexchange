import { useCallback, useEffect, useMemo, useRef, useState, type Ref } from 'react'
import IptvPlayer from '../player/IptvPlayer'
import type { StreamGrant } from '../../lib/api/iptv'
import { mediaApi, type PlayableKind, type PlaybackGrant } from '../../lib/api/media'
import { useReportWatch } from '../../lib/hooks/useMediaLibrary'
import { useModalA11y } from '../../lib/hooks/useModalA11y'
import {
  absoluteProgress,
  COMPLETE_TAIL_SECS,
  playerStartPosition,
  startPlaybackSession,
  type PlaybackSession,
} from './playbackSession'

type Props = {
  kind: PlayableKind
  id: number
  title: string
  /** Resume point from prior watch state (direct-play seeks here on load). */
  startPositionSecs?: number
  onClose: () => void
}

export type MediaPlayerViewProps = {
  title: string
  error: string | null
  /** The transcoder reaped the session mid-watch — offer a re-grant. */
  sessionLost: boolean
  streamGrant: StreamGrant | null
  startPositionSecs?: number
  containerRef?: Ref<HTMLDivElement>
  onClose: () => void
  onRetry: () => void
  onPositionUpdate: (positionSecs: number, durationSecs: number | null) => void
  onEnded: () => void
}

/** Presentational half of the player modal, exported so the node vitest env
 *  (no DOM — the stateful component's effects can't be mounted) can assert
 *  every UI state via static markup. */
export function MediaPlayerView({
  title,
  error,
  sessionLost,
  streamGrant,
  startPositionSecs,
  containerRef,
  onClose,
  onRetry,
  onPositionUpdate,
  onEnded,
}: MediaPlayerViewProps) {
  return (
    <div
      ref={containerRef}
      className="iptv-player-modal"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
    >
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
      {error && (
        <div className="iptv-tab__status iptv-tab__status--error">
          <p>{error}</p>
          {sessionLost && (
            <button className="iptv-tab__retry" type="button" onClick={onRetry}>
              Play again
            </button>
          )}
        </div>
      )}
      {!error && !streamGrant && <p className="iptv-tab__status">Starting playback…</p>}
      {streamGrant && (
        <IptvPlayer
          grant={streamGrant}
          autoPlay
          startPositionSecs={playerStartPosition(streamGrant.delivery, startPositionSecs)}
          onPositionUpdate={onPositionUpdate}
          onEnded={onEnded}
        />
      )}
    </div>
  )
}

/**
 * Local-media player modal. Fetches a playback grant (direct-play or
 * transcoded HLS), reuses the shared IptvPlayer engine, persists watch progress
 * (throttled, with a final flush on close), and heartbeats transcode sessions
 * so they aren't reaped mid-watch. The grant/heartbeat/stop lifecycle lives in
 * startPlaybackSession (./playbackSession.ts) where it is unit-tested.
 */
export function MediaPlayer({ kind, id, title, startPositionSecs, onClose }: Props) {
  const [grant, setGrant] = useState<PlaybackGrant | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sessionLost, setSessionLost] = useState(false)
  // Bumped by "Play again" after a session-lost 404 to re-run the grant flow.
  const [sessionKey, setSessionKey] = useState(0)
  const report = useReportWatch(kind, id)
  // Latest (position, duration) so unmount/close can flush an exact resume point.
  const latest = useRef<{ pos: number; dur: number | null }>({
    pos: startPositionSecs ?? 0,
    dur: null,
  })
  // The live session in a ref so onEnded/pagehide can stop it without
  // re-subscribing on every grant change.
  const sessionRef = useRef<PlaybackSession | null>(null)

  // Plain-div dialog: useModalA11y supplies Escape-to-close, the focus trap,
  // and focus restoration that aria-modal="true" promises (LiveTab pattern).
  const modalRef = useModalA11y<HTMLDivElement>(onClose)

  // One playback session per (title, retry attempt). Callers key the player by
  // title, so a new selection remounts it fresh; "Play again" bumps sessionKey
  // to re-grant after the transcoder reaped the previous session.
  useEffect(() => {
    void sessionKey
    const session = startPlaybackSession({
      kind,
      id,
      startPositionSecs,
      api: mediaApi,
      handlers: {
        onGrant: setGrant,
        onGrantError: setError,
        onSessionLost: () => {
          // The stream is a corpse (transcoder 404). Tear the player down and
          // surface a re-grant-able error instead of a frozen video.
          setGrant(null)
          setSessionLost(true)
          setError('Playback session expired — the transcoder shut it down.')
        },
      },
    })
    sessionRef.current = session
    return () => {
      sessionRef.current = null
      session.dispose()
    }
  }, [kind, id, startPositionSecs, sessionKey])

  const retry = useCallback(() => {
    setError(null)
    setSessionLost(false)
    setSessionKey((key) => key + 1)
  }, [])

  // Final flush on unmount so the resume point reflects where they actually
  // stopped, not the last throttled tick. (The session's stop fires from the
  // session effect's own cleanup.)
  useEffect(() => {
    return () => {
      const { pos, dur } = latest.current
      if (pos > 0) {
        const completed = dur != null && pos >= Math.max(0, dur - COMPLETE_TAIL_SECS)
        report(pos, dur, completed, true)
      }
    }
  }, [report])

  // A hard page unload (tab close / navigation) doesn't run React cleanup, so
  // free the transcoder slot there too. mediaApi.stop uses keepalive to flush
  // on unload.
  useEffect(() => {
    const onHide = () => sessionRef.current?.stop()
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [])

  // Stable StreamGrant reference: a new object each render would make
  // IptvPlayer tear down and rebuild its (HLS) engine on every render.
  const streamGrant = useMemo<StreamGrant | null>(
    () => (grant ? { url: grant.url, delivery: grant.delivery } : null),
    [grant],
  )

  const onPositionUpdate = useCallback(
    (positionSecs: number, durationSecs: number | null) => {
      const { pos, dur, completed } = absoluteProgress({
        delivery: grant?.delivery ?? 'progressive',
        grantDurationSecs: grant?.durationSecs ?? null,
        startPositionSecs,
        positionSecs,
        durationSecs,
      })
      latest.current = { pos, dur }
      report(pos, dur, completed)
    },
    [report, grant?.delivery, grant?.durationSecs, startPositionSecs],
  )

  const onEnded = useCallback(() => {
    const dur = latest.current.dur ?? grant?.durationSecs ?? null
    report(latest.current.pos, dur, true, true)
    // Free the transcoder slot immediately (also stops the heartbeat).
    sessionRef.current?.stop()
  }, [report, grant?.durationSecs])

  return (
    <MediaPlayerView
      title={title}
      error={error}
      sessionLost={sessionLost}
      streamGrant={streamGrant}
      startPositionSecs={startPositionSecs}
      containerRef={modalRef}
      onClose={onClose}
      onRetry={retry}
      onPositionUpdate={onPositionUpdate}
      onEnded={onEnded}
    />
  )
}

export default MediaPlayer
