import { useCallback, useEffect, useMemo, useRef, useState, type Ref } from 'react'
import IptvPlayer from '../player/IptvPlayer'
import { MediaControls } from './MediaControls'
import type { StreamGrant } from '../../lib/api/iptv'
import { mediaApi, type PlayableKind, type PlaybackGrant } from '../../lib/api/media'
import { useReportWatch } from '../../lib/hooks/useMediaLibrary'
import { useModalA11y } from '../../lib/hooks/useModalA11y'
import { ResumePrompt } from './ResumePrompt'
import {
  absoluteProgress,
  COMPLETE_TAIL_SECS,
  hlsPinnedDurationSecs,
  playerStartPosition,
  startPlaybackSession,
  type PlaybackSession,
} from './playbackSession'

type Props = {
  kind: PlayableKind
  id: number
  title: string
  /** Resume point from prior watch state. A positive value shows the
   *  resume-or-start-over prompt before any playback session starts. */
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
  /** Known total session duration for HLS grants — pins the player timeline
   *  to full length immediately (see hlsPinnedDurationSecs). */
  pinnedDurationSecs?: number | null
  /** Saved resume point awaiting a user choice: render the
   *  resume-or-start-over prompt instead of starting playback. */
  resumePromptSecs?: number | null
  /** Title time where the session's media timeline starts (-ss offset; 0 for
   *  fresh starts and progressive delivery). MediaControls adds it to the
   *  element position to display absolute title time. */
  sessionOffsetSecs?: number
  /** Full title length for the controls' scrubber/total readout. */
  titleDurationSecs?: number | null
  containerRef?: Ref<HTMLDivElement>
  onClose: () => void
  onRetry: () => void
  onResume?: () => void
  onStartOver?: () => void
  /** A scrub below the session's -ss floor — re-grant at the target. */
  onSeekBeforeStart?: (targetSecs: number) => void
  onPositionUpdate: (positionSecs: number, durationSecs: number | null) => void
  onEnded: () => void
  /** Progressive playback genuinely struggled — re-grant with buffered (HLS)
   *  delivery at the current position (stall-escalation, see IptvPlayer). */
  onDeliveryStruggling?: () => void
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
  pinnedDurationSecs,
  resumePromptSecs,
  sessionOffsetSecs,
  titleDurationSecs,
  containerRef,
  onClose,
  onRetry,
  onResume,
  onStartOver,
  onSeekBeforeStart,
  onPositionUpdate,
  onEnded,
  onDeliveryStruggling,
}: MediaPlayerViewProps) {
  const promptingResume = !error && !streamGrant && resumePromptSecs != null
  // The engine's <video> element, surfaced by IptvPlayer so the app-drawn
  // control bar (absolute timeline — see MediaControls) can drive it.
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  // Session-relative produced edge of the growing HLS transcode, reported by
  // IptvPlayer — lets the control bar re-grant a forward seek past what ffmpeg
  // has produced (a plain element seek there stalls / snaps back).
  const [seekableEndSecs, setSeekableEndSecs] = useState<number | null>(null)
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
      {promptingResume && (
        <ResumePrompt
          resumeSecs={resumePromptSecs}
          onResume={onResume ?? (() => undefined)}
          onStartOver={onStartOver ?? (() => undefined)}
        />
      )}
      {!error && !streamGrant && !promptingResume && (
        <p className="iptv-tab__status">Starting playback…</p>
      )}
      {streamGrant && (
        <>
          <IptvPlayer
            grant={streamGrant}
            autoPlay
            startPositionSecs={playerStartPosition(streamGrant.delivery, startPositionSecs)}
            pinnedDurationSecs={pinnedDurationSecs}
            vodHls
            nativeControls={false}
            onVideoElement={setVideoEl}
            onSeekableEndUpdate={setSeekableEndSecs}
            onPositionUpdate={onPositionUpdate}
            onEnded={onEnded}
            onDeliveryStruggling={onDeliveryStruggling}
          />
          {videoEl && (
            <MediaControls
              video={videoEl}
              offsetSecs={sessionOffsetSecs ?? 0}
              totalDurationSecs={titleDurationSecs ?? null}
              seekableEndSecs={seekableEndSecs}
              onSeekBelowOffset={onSeekBeforeStart ?? (() => undefined)}
            />
          )}
        </>
      )}
    </div>
  )
}

/**
 * Local-media player modal. With a saved resume point it first asks
 * resume-or-start-over (nothing plays until the user picks); then fetches a
 * playback grant (direct-play or transcoded HLS), reuses the shared
 * IptvPlayer engine, persists watch progress (throttled, with a final flush
 * on close), and heartbeats transcode sessions so they aren't reaped
 * mid-watch. The grant/heartbeat/stop lifecycle lives in startPlaybackSession
 * (./playbackSession.ts) where it is unit-tested.
 */
export function MediaPlayer({ kind, id, title, startPositionSecs, onClose }: Props) {
  const [grant, setGrant] = useState<PlaybackGrant | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sessionLost, setSessionLost] = useState(false)
  // Bumped by "Play again" after a session-lost 404 to re-run the grant flow.
  const [sessionKey, setSessionKey] = useState(0)
  const report = useReportWatch(kind, id)
  // Where the CURRENT session starts in title time. null = a saved resume
  // point exists and the user hasn't chosen resume-or-start-over yet (no
  // session runs). Set by the prompt choice, then overwritten by stall
  // escalation or a below-floor back-seek (both re-grant at a new start).
  const hasResumePoint = (startPositionSecs ?? 0) > 0
  const [effectiveStartSecs, setEffectiveStartSecs] = useState<number | null>(
    hasResumePoint ? null : 0,
  )
  // Latest (position, duration) so unmount/close can flush an exact resume point.
  const latest = useRef<{ pos: number; dur: number | null }>({
    pos: startPositionSecs ?? 0,
    dur: null,
  })
  // The live session in a ref so onEnded/pagehide can stop it without
  // re-subscribing on every grant change.
  const sessionRef = useRef<PlaybackSession | null>(null)
  // Stall escalation (one-way, once per mount): when progressive playback
  // genuinely struggles, re-grant with buffered (HLS) delivery resumed at the
  // captured position.
  const forceHlsRef = useRef(false)
  // Ref twin of effectiveStartSecs for the stable callbacks below (they must
  // keep their identity across renders — IptvPlayer's engine effect lists
  // them — so they can't close over state).
  const effectiveStartRef = useRef<number | null>(hasResumePoint ? null : 0)

  // Plain-div dialog: useModalA11y supplies Escape-to-close, the focus trap,
  // and focus restoration that aria-modal="true" promises (LiveTab pattern).
  const modalRef = useModalA11y<HTMLDivElement>(onClose)

  // One playback session per (title, chosen start, retry attempt). Callers
  // key the player by title, so a new selection remounts it fresh; the resume
  // prompt gates the first session (null = still asking); "Play again" bumps
  // sessionKey to re-grant after the transcoder reaped the previous session.
  useEffect(() => {
    void sessionKey
    if (effectiveStartSecs == null) return undefined
    const session = startPlaybackSession({
      kind,
      id,
      // 0 (fresh start / start-over) goes as "no offset" so the grant wire
      // shape stays identical to a non-resumable title.
      startPositionSecs: effectiveStartSecs > 0 ? effectiveStartSecs : undefined,
      forceHls: forceHlsRef.current,
      api: mediaApi,
      handlers: {
        onGrant: setGrant,
        onGrantError: setError,
        onSessionLost: () => {
          // The stream is a corpse (transcoder 404). Tear the player down and
          // surface a re-grant-able error instead of a frozen video.
          setGrant(null)
          setSessionLost(true)
          setError('Playback session expired; the transcoder shut it down.')
        },
      },
    })
    sessionRef.current = session
    return () => {
      sessionRef.current = null
      session.dispose()
    }
  }, [kind, id, effectiveStartSecs, sessionKey])

  const retry = useCallback(() => {
    setError(null)
    setSessionLost(false)
    setSessionKey((key) => key + 1)
  }, [])

  // Resume prompt choices. Both set the session start; the session effect
  // takes it from there.
  const chooseStart = useCallback((startSecs: number) => {
    effectiveStartRef.current = startSecs
    setEffectiveStartSecs(startSecs)
  }, [])
  const onResume = useCallback(
    () => chooseStart(Math.floor(startPositionSecs ?? 0)),
    [chooseStart, startPositionSecs],
  )
  const onStartOver = useCallback(() => chooseStart(0), [chooseStart])

  // Progressive playback proved unhealthy (≥2 confirmed stall episodes —
  // IptvPlayer's escalator fires this at most once). Capture the playhead,
  // flip the session to forced-HLS, and remount via the existing sessionKey
  // machinery. setGrant(null) shows "Starting playback…" during the ~2-5 s
  // swap. Empty deps keep the identity stable across renders so IptvPlayer's
  // engine effect doesn't tear down on unrelated re-renders.
  const onDeliveryStruggling = useCallback(() => {
    if (forceHlsRef.current) return
    forceHlsRef.current = true
    const captured = Math.floor(latest.current.pos)
    effectiveStartRef.current = captured
    setGrant(null)
    setEffectiveStartSecs(captured)
    setSessionKey((key) => key + 1)
  }, [])

  // A scrub below the session's -ss floor (the MediaControls scrubber spans
  // the whole title, including the region before this session's start):
  // re-grant the session at the target so the whole seekbar is genuinely
  // playable.
  const onSeekBeforeStart = useCallback((targetSecs: number) => {
    effectiveStartRef.current = targetSecs
    latest.current.pos = targetSecs
    setGrant(null)
    setEffectiveStartSecs(targetSecs)
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
  // the unmount flush above never fires and the last resume point was lost.
  // Flush via mediaApi.flushWatch (fetch keepalive — see its doc for why not
  // sendBeacon) on pagehide, and also free the transcoder slot there
  // (mediaApi.stop keepalives too). visibilitychange→hidden additionally
  // flushes progress — it's the last event mobile browsers reliably fire
  // before killing a background tab — but must NOT stop the session: a
  // backgrounded tab may keep playing audio or come right back.
  useEffect(() => {
    const flushProgress = () => {
      const { pos, dur } = latest.current
      if (pos <= 0) return
      const completed = dur != null && pos >= Math.max(0, dur - COMPLETE_TAIL_SECS)
      mediaApi.flushWatch({ kind, id, positionSecs: pos, durationSecs: dur, completed })
    }
    const onPageHide = () => {
      flushProgress()
      sessionRef.current?.stop()
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushProgress()
    }
    window.addEventListener('pagehide', onPageHide)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [kind, id])

  // Stable StreamGrant reference: a new object each render would make
  // IptvPlayer tear down and rebuild its (HLS) engine on every render.
  const streamGrant = useMemo<StreamGrant | null>(
    () =>
      grant
        ? { url: grant.url, delivery: grant.delivery, subtitle: grant.subtitle ?? null }
        : null,
    [grant],
  )

  const onPositionUpdate = useCallback(
    (positionSecs: number, durationSecs: number | null) => {
      const { pos, dur, completed } = absoluteProgress({
        delivery: grant?.delivery ?? 'progressive',
        grantDurationSecs: grant?.durationSecs ?? null,
        // The session starts at the EFFECTIVE start (prompt choice, then
        // escalation/back-seek re-grants), not the original resume prop.
        startPositionSecs: effectiveStartRef.current ?? startPositionSecs,
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

  // Pin the HLS media timeline to the session's REMAINING length (the -ss
  // session starts at 0); MediaControls re-adds the offset for display.
  const pinnedDurationSecs = grant
    ? hlsPinnedDurationSecs({
        delivery: grant.delivery,
        grantDurationSecs: grant.durationSecs ?? null,
        startPositionSecs: effectiveStartSecs ?? 0,
      })
    : null

  // Where the session's media 0 sits in title time, for the control bar's
  // absolute display. Only HLS sessions are offset (-ss); progressive serves
  // the whole file, its element timeline is already absolute.
  const sessionOffsetSecs =
    grant?.delivery === 'hls' ? Math.max(0, effectiveStartSecs ?? 0) : 0

  return (
    <MediaPlayerView
      title={title}
      error={error}
      sessionLost={sessionLost}
      streamGrant={streamGrant}
      startPositionSecs={effectiveStartSecs ?? startPositionSecs}
      pinnedDurationSecs={pinnedDurationSecs}
      resumePromptSecs={effectiveStartSecs == null ? (startPositionSecs ?? null) : null}
      sessionOffsetSecs={sessionOffsetSecs}
      titleDurationSecs={grant?.durationSecs ?? null}
      containerRef={modalRef}
      onClose={onClose}
      onRetry={retry}
      onResume={onResume}
      onStartOver={onStartOver}
      onSeekBeforeStart={onSeekBeforeStart}
      onPositionUpdate={onPositionUpdate}
      onEnded={onEnded}
      onDeliveryStruggling={onDeliveryStruggling}
    />
  )
}

export default MediaPlayer
