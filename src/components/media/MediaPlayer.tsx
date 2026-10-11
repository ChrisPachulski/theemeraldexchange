import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Ref } from 'react'
import IptvPlayer from '../player/IptvPlayer'
import { MediaControls, type EpisodeNav } from './MediaControls'
import { episodeCode } from './EpisodePicker'
import type { StreamGrant } from '../../lib/api/iptv'
import {
  mediaApi,
  type MediaEpisode,
  type MediaMarker,
  type PlayableKind,
  type PlaybackGrant,
} from '../../lib/api/media'
import { useReportWatch } from '../../lib/hooks/useMediaLibrary'
import { useModalA11y } from '../../lib/hooks/useModalA11y'
import { getPlaybackPrefs, subtitleCueVars, usePlaybackPrefs } from '../../lib/playbackPrefs'
import { ResumePrompt } from './ResumePrompt'
import {
  absoluteProgress,
  COMPLETE_TAIL_SECS,
  createFrozenPlayheadWatchdog,
  episodeQueue,
  hlsPinnedDurationSecs,
  IDLE_GATE_MS,
  playerStartPosition,
  startPlaybackSession,
  STILL_WATCHING_AFTER,
  UP_NEXT_COUNTDOWN_SECS,
  upNextDue,
  type PlaybackSession,
} from './playbackSession'

type Props = {
  kind: PlayableKind
  id: number
  title: string
  /** Resume point from prior watch state. A positive value shows the
   *  resume-or-start-over prompt before any playback session starts. */
  startPositionSecs?: number
  /** The show's episodes (kind 'episode'): enables Up Next, prev/next and the
   *  episode queue. Picking one calls onPlayEpisode; the owner passes the new
   *  id/title/resume back in and the player swaps it in place (fullscreen and
   *  the modal survive, unlike a remount). */
  episodes?: MediaEpisode[]
  onPlayEpisode?: (ep: MediaEpisode) => void
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
  /** The engine's <video>, owned by MediaPlayer (the binge gates and the
   *  frozen-playhead watchdog drive it too). */
  videoEl?: HTMLVideoElement | null
  onVideoElement?: (video: HTMLVideoElement | null) => void
  markers?: ReadonlyArray<MediaMarker>
  episodeNav?: EpisodeNav | null
  /** "Up next" card over the credits: the next episode and seconds left. */
  upNext?: { episode: MediaEpisode; secondsLeft: number } | null
  onUpNextPlay?: () => void
  onUpNextCancel?: () => void
  /** "Still watching?" gate (playback is paused while it shows). */
  stillWatching?: boolean
  onKeepWatching?: () => void
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
  videoEl,
  onVideoElement,
  markers,
  episodeNav,
  upNext,
  onUpNextPlay,
  onUpNextCancel,
  stillWatching,
  onKeepWatching,
}: MediaPlayerViewProps) {
  const promptingResume = !error && !streamGrant && resumePromptSecs != null
  // Session-relative produced edge of the growing HLS transcode, reported by
  // IptvPlayer — lets the control bar re-grant a forward seek past what ffmpeg
  // has produced (a plain element seek there stalls / snaps back).
  const [seekableEndSecs, setSeekableEndSecs] = useState<number | null>(null)
  const prefs = usePlaybackPrefs()
  // Subtitle appearance rides on CSS variables the ::cue rule reads (index.css).
  const cueVars = subtitleCueVars(prefs)
  return (
    <div
      ref={containerRef}
      className="iptv-player-modal"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      data-subtitle-style={cueVars ? '' : undefined}
      style={(cueVars ?? undefined) as CSSProperties | undefined}
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
            preferredAudioLanguage={prefs.audioLanguage || undefined}
            onVideoElement={onVideoElement}
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
              title={title}
              delivery={streamGrant.delivery === 'hls' ? 'hls' : 'progressive'}
              // Apple hides Skip while a binge overlay is up.
              markers={upNext || stillWatching ? undefined : markers}
              episodeNav={episodeNav}
            />
          )}
        </>
      )}
      {upNext && (
        <div className="media-up-next" role="group" aria-label="Up next">
          <div className="media-up-next__text">
            <p className="media-up-next__eyebrow">Up next</p>
            <p className="media-up-next__title">
              {episodeCode(upNext.episode)}
              {upNext.episode.title ? ` · ${upNext.episode.title}` : ''}
            </p>
            <p className="media-up-next__count" aria-live="polite">
              Playing in {upNext.secondsLeft}s
            </p>
          </div>
          <div className="media-up-next__actions">
            <button className="iptv-tab__retry" type="button" onClick={onUpNextPlay}>
              Play now
            </button>
            <button className="media-up-next__secondary" type="button" onClick={onUpNextCancel}>
              Watch credits
            </button>
          </div>
        </div>
      )}
      {stillWatching && (
        <div className="media-still-watching" role="group" aria-label="Still watching?">
          <p className="media-still-watching__title">Still watching?</p>
          <p>Playback paused after a long run.</p>
          <div className="media-resume__choices">
            <button className="iptv-tab__retry" type="button" onClick={onKeepWatching} autoFocus>
              Keep watching
            </button>
            <button className="iptv-tab__retry" type="button" onClick={onClose}>
              Stop
            </button>
          </div>
        </div>
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
 * (./playbackSession.ts) where it is unit-tested. With a show's `episodes` it
 * also runs the binge flow (Up Next, prev/next, queue, Still watching?).
 */
export function MediaPlayer({
  kind,
  id,
  title,
  startPositionSecs,
  episodes,
  onPlayEpisode,
  onClose,
}: Props) {
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
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const [markerState, setMarkerState] = useState<{ id: number; items: MediaMarker[] } | null>(null)
  // Binge state: the Up Next countdown (null = no card), the Still watching?
  // gate ('advance' = it is holding back an auto-advance), and refs for the
  // stable position callback.
  const [upNextSecs, setUpNextSecs] = useState<number | null>(null)
  const [stillWatching, setStillWatching] = useState<'idle' | 'advance' | null>(null)
  const upNextCancelledRef = useRef(false)
  const unattendedAdvancesRef = useRef(0)
  const lastInteractionRef = useRef(0)

  const queue = useMemo(
    () => (kind === 'episode' && episodes ? episodeQueue(episodes, id) : null),
    [kind, episodes, id],
  )
  const nextEpisode = queue?.next ?? null

  // In-place episode swap (Up Next, queue, prev/next): the owner hands in a new
  // id. Reset this render's session state for it (React's adjust-state-on-prop
  // pattern) and resume silently at the episode's saved point, as Apple's
  // binge swap does; the old session stops and its position flushes through
  // the effect cleanups below.
  const [shownId, setShownId] = useState(id)
  if (shownId !== id) {
    setShownId(id)
    setGrant(null)
    setError(null)
    setSessionLost(false)
    setEffectiveStartSecs(Math.floor(startPositionSecs ?? 0))
    setUpNextSecs(null)
    setStillWatching(null)
  }
  // The swapped-out engine can still deliver a queued timeupdate after the
  // commit; this (set synchronously at commit) lets its stale callback bail
  // instead of arming the new episode's Up Next from the old position.
  const activeIdRef = useRef(id)
  useLayoutEffect(() => {
    activeIdRef.current = id
  }, [id])
  // The ref half of that reset. Runs after every effect cleanup (so the old
  // episode's final flush has read `latest`) and before the session effect.
  const refsForIdRef = useRef(id)
  useEffect(() => {
    if (refsForIdRef.current === id) return
    refsForIdRef.current = id
    forceHlsRef.current = false
    effectiveStartRef.current = effectiveStartSecs
    latest.current = { pos: effectiveStartSecs ?? 0, dur: null }
    upNextCancelledRef.current = false
  }, [id, effectiveStartSecs])

  // Plain-div dialog: useModalA11y supplies Escape-to-close, the focus trap,
  // and focus restoration that aria-modal="true" promises (LiveTab pattern).
  const modalRef = useModalA11y<HTMLDivElement>(onClose)
  // An episode swap unmounts the control that was clicked (Play now, a queue
  // row); pull focus back into the dialog so Escape and the trap keep working.
  useEffect(() => {
    const modal = modalRef.current
    if (modal && !modal.contains(document.activeElement)) modal.focus()
  }, [id, modalRef])

  // One playback session per (title, chosen start, retry attempt). A new id
  // (episode swap) starts a fresh session; the resume prompt gates the first
  // session (null = still asking); "Play again" bumps sessionKey to re-grant
  // after the transcoder reaped the previous session.
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

  // Skip Intro / Skip Credits windows, once per title. Missing markers (or an
  // older media-core without the route) just mean no Skip button.
  useEffect(() => {
    let live = true
    mediaApi
      .markers(kind, id)
      .then((items) => {
        if (live) setMarkerState({ id, items })
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [kind, id])
  const markers = markerState?.id === id ? markerState.items : undefined

  // "Play again" (session lost or frozen) re-grants where playback stopped,
  // not where the session started.
  const retry = useCallback(() => {
    const resumeAt = Math.floor(latest.current.pos)
    effectiveStartRef.current = resumeAt
    setEffectiveStartSecs(resumeAt)
    setError(null)
    setSessionLost(false)
    setSessionKey((key) => key + 1)
  }, [])

  // Frozen-playhead watchdog (see createFrozenPlayheadWatchdog): a wedged
  // transcoder leaves the picture frozen with a healthy heartbeat. Free the
  // slot and offer the same re-grant as a reaped session.
  useEffect(() => {
    if (!videoEl || !grant) return undefined
    const frozen = createFrozenPlayheadWatchdog()
    const timer = setInterval(() => {
      const stalled = frozen({
        position: videoEl.currentTime,
        paused: videoEl.paused || videoEl.ended,
        // HAVE_FUTURE_DATA: below it the element is starved, waiting on data.
        starved: videoEl.readyState < 3,
        now: Date.now(),
      })
      if (!stalled) return
      sessionRef.current?.stop()
      setGrant(null)
      setSessionLost(true)
      setError('Playback stalled; the stream stopped delivering video.')
    }, 1000)
    return () => clearInterval(timer)
  }, [videoEl, grant])

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

  // Final flush on unmount, and for the outgoing episode on an in-place swap,
  // so the resume point reflects where they actually stopped, not the last
  // throttled tick. (The session's stop fires from the session effect's own
  // cleanup.)
  useEffect(() => {
    return () => {
      const { pos, dur } = latest.current
      if (pos > 0) {
        const completed = dur != null && pos >= Math.max(0, dur - COMPLETE_TAIL_SECS)
        report(pos, dur, completed, true)
      }
    }
  }, [report, kind, id])

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

  // Idle clock for the Still watching? gate: any click or key inside the
  // player counts as the viewer being present.
  useEffect(() => {
    const el = modalRef.current
    const touch = () => {
      lastInteractionRef.current = Date.now()
    }
    touch()
    el?.addEventListener('pointerdown', touch)
    el?.addEventListener('keydown', touch)
    return () => {
      el?.removeEventListener('pointerdown', touch)
      el?.removeEventListener('keydown', touch)
    }
  }, [modalRef])

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
      if (activeIdRef.current !== id) return
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
      // Binge gates (Apple's tickOverlays): nothing new arms while Still
      // watching? is up.
      if (stillWatching) return
      if (videoEl && !videoEl.paused && Date.now() - lastInteractionRef.current > IDLE_GATE_MS) {
        videoEl.pause()
        setUpNextSecs(null)
        setStillWatching('idle')
      } else if (
        nextEpisode &&
        !upNextCancelledRef.current &&
        getPlaybackPrefs().autoplayNext &&
        upNextDue(pos, dur)
      ) {
        setUpNextSecs((s) => s ?? UP_NEXT_COUNTDOWN_SECS)
      }
    },
    [report, grant?.delivery, grant?.durationSecs, startPositionSecs, id, stillWatching, nextEpisode, videoEl],
  )

  const onEnded = useCallback(() => {
    const dur = latest.current.dur ?? grant?.durationSecs ?? null
    report(latest.current.pos, dur, true, true)
    // Free the transcoder slot immediately (also stops the heartbeat).
    sessionRef.current?.stop()
  }, [report, grant?.durationSecs])

  // A tap (queue, prev/next, Play now) is attended and resets the binge count.
  const pickEpisode = useCallback(
    (ep: MediaEpisode) => {
      unattendedAdvancesRef.current = 0
      onPlayEpisode?.(ep)
    },
    [onPlayEpisode],
  )

  // Countdown ran out: advance, unless this would be the third unattended
  // advance in a row, in which case pause on Still watching? instead.
  const autoAdvance = useCallback(() => {
    setUpNextSecs(null)
    if (!nextEpisode) return
    if (unattendedAdvancesRef.current >= STILL_WATCHING_AFTER - 1) {
      videoEl?.pause()
      setStillWatching('advance')
      return
    }
    unattendedAdvancesRef.current += 1
    onPlayEpisode?.(nextEpisode)
  }, [nextEpisode, onPlayEpisode, videoEl])

  // The countdown runs from arming to zero on one interval; the latest
  // autoAdvance comes through a ref so owner re-renders don't restart it.
  const autoAdvanceRef = useRef(autoAdvance)
  useEffect(() => {
    autoAdvanceRef.current = autoAdvance
  })
  const upNextArmed = upNextSecs != null
  useEffect(() => {
    if (!upNextArmed) return undefined
    let left = UP_NEXT_COUNTDOWN_SECS
    const timer = setInterval(() => {
      left -= 1
      if (left > 0) {
        setUpNextSecs(left)
        return
      }
      clearInterval(timer)
      autoAdvanceRef.current()
    }, 1000)
    return () => clearInterval(timer)
  }, [upNextArmed])

  const keepWatching = () => {
    const gate = stillWatching
    unattendedAdvancesRef.current = 0
    lastInteractionRef.current = Date.now()
    setStillWatching(null)
    if (gate === 'advance' && nextEpisode) pickEpisode(nextEpisode)
    else void videoEl?.play().catch(() => undefined)
  }

  const episodeNav = useMemo<EpisodeNav | null>(
    () =>
      queue && onPlayEpisode
        ? { episodes: queue.episodes, currentId: id, prev: queue.prev, next: queue.next, onPick: pickEpisode }
        : null,
    [queue, id, onPlayEpisode, pickEpisode],
  )

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
      videoEl={videoEl}
      onVideoElement={setVideoEl}
      markers={markers}
      episodeNav={episodeNav}
      upNext={upNextSecs != null && nextEpisode ? { episode: nextEpisode, secondsLeft: upNextSecs } : null}
      onUpNextPlay={() => nextEpisode && pickEpisode(nextEpisode)}
      onUpNextCancel={() => {
        upNextCancelledRef.current = true
        setUpNextSecs(null)
      }}
      stillWatching={stillWatching != null}
      onKeepWatching={keepWatching}
    />
  )
}

export default MediaPlayer
