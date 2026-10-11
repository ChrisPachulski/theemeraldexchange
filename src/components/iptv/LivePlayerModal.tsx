import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import IptvPlayer, { type LiveLostReason } from '../player/IptvPlayer'
import { iptvApi, type StreamGrant } from '../../lib/api/iptv'
import { ApiError } from '../../lib/api/errors'
import { useModalA11y } from '../../lib/hooks/useModalA11y'
import { MiniGuide } from './MiniGuide'
import { OFFLINE_REPROBE_MS, RECONNECT_ATTEMPTS, reconnectWaitMs } from './liveReconnect'

// `recording`: a DVR recording (a finite .ts, played like catch-up).
export type LivePlaying = { grant: StreamGrant; title: string; itemId: string; live?: boolean; recording?: boolean }

type Cover =
  | { kind: 'reconnecting'; attempt: number }
  | { kind: 'lost'; message: string }
  | { kind: 'offline' }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// A fresh grant only helps when the server or the network failed; a 4xx
// (policy, auth, all slots in use) won't change by retrying.
function isTransient(err: unknown): boolean {
  return !(err instanceof ApiError) || err.status === 0 || err.status >= 500
}

// The player modal is a plain div (role=dialog/aria-modal) rather than a
// native <dialog> because it's a full-bleed layout, not a centered panel.
// useModalA11y supplies the focus trap, Escape-to-close, and focus restoration
// that aria-modal="true" promises but a bare div doesn't provide.
//
// Live channels get the Apple player's live machinery: a dropped feed keeps the
// surface up behind "Reconnecting… (n of N)" while a fresh grant is minted, an
// off-air channel shows "Channel offline" and is re-probed in the background,
// and a Guide strip (button or "g") surfs channels in place. Catch-up plays as
// a finite asset with none of that, and its natural end closes the player.
export function LivePlayerModal({
  playing,
  guideCategoryIds,
  favorites,
  onClose,
  onSurf,
  onGrant,
  onPositionUpdate,
  onEscalate,
}: {
  playing: LivePlaying
  guideCategoryIds: number[]
  favorites: ReadonlySet<number>
  onClose: () => void
  onSurf: (channel: { stream_id: number; name: string }) => void
  // Swaps a fresh grant into the playing item. Must be stable (useCallback).
  onGrant: (itemId: string, grant: StreamGrant) => void
  onPositionUpdate: (positionSecs: number, durationSecs: number | null) => void
  onEscalate?: () => void
}) {
  const modalRef = useModalA11y<HTMLDivElement>(onClose)
  const live = !!playing.live
  const { itemId } = playing
  const [guideOpen, setGuideOpen] = useState(false)
  const [cover, setCover] = useState<Cover | null>(null)
  const attempt = useRef(0)
  const busy = useRef(false)
  const alive = useRef(true)
  const sessionRef = useRef(playing.grant.sessionId)
  useEffect(() => {
    sessionRef.current = playing.grant.sessionId
  }, [playing.grant.sessionId])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // One attempt loop at a time; a drop reported while one runs is already
  // covered by it. Kill the old session, wait out backoff + slot grace, mint a
  // fresh grant and swap it in. The cover stays up until the engine plays.
  const reconnect = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    // An offline card stays up while a background re-probe runs behind it.
    const show = (next: Cover) => setCover((c) => (c?.kind === 'offline' ? c : next))
    try {
      for (;;) {
        const wait = reconnectWaitMs(attempt.current)
        if (wait == null) {
          show({ kind: 'lost', message: `Couldn’t reconnect after ${RECONNECT_ATTEMPTS} tries. Check your connection.` })
          return
        }
        show({ kind: 'reconnecting', attempt: attempt.current + 1 })
        const sid = sessionRef.current
        if (sid) await iptvApi.killSession(sid).catch(() => undefined)
        await sleep(wait)
        if (!alive.current) return
        attempt.current += 1
        try {
          const grant = await iptvApi.grantLive(itemId)
          if (alive.current) onGrant(itemId, grant)
          // Closed or surfed away meanwhile: don't leak the fresh session.
          else if (grant.sessionId) void iptvApi.killSession(grant.sessionId).catch(() => undefined)
          return
        } catch (err) {
          if (!alive.current) return
          if (!isTransient(err)) {
            show({
              kind: 'lost',
              message:
                err instanceof ApiError && err.status === 429
                  ? 'All playback slots are in use. Close another stream, then try again.'
                  : 'Couldn’t get a fresh channel grant. Try again.',
            })
            return
          }
        }
      }
    } finally {
      busy.current = false
    }
  }, [itemId, onGrant])

  const onLiveLost = useCallback(
    (reason: LiveLostReason) => {
      if (reason !== 'offline') {
        void reconnect()
        return
      }
      // Off the air: free the slot and stop dialing; the re-probe below keeps checking.
      const sid = sessionRef.current
      if (sid) void iptvApi.killSession(sid).catch(() => undefined)
      setCover({ kind: 'offline' })
    },
    [reconnect],
  )

  const onPlaying = useCallback(() => {
    attempt.current = 0
    setCover(null)
  }, [])

  const offline = cover?.kind === 'offline'
  useEffect(() => {
    if (!offline) return undefined
    const t = setInterval(() => {
      attempt.current = 0
      void reconnect()
    }, OFFLINE_REPROBE_MS)
    return () => clearInterval(t)
  }, [offline, reconnect])

  const tryAgain = () => {
    attempt.current = 0
    setCover(null)
    void reconnect()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!live || e.key !== 'g' || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
    setGuideOpen((open) => !open)
  }

  return (
    <div
      ref={modalRef}
      className="iptv-player-modal"
      role="dialog"
      aria-modal="true"
      aria-label={playing.title}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="iptv-player-modal__header">
        <h2>{playing.title}</h2>
        {live && (
          <button
            type="button"
            className="iptv-player-modal__guide"
            aria-expanded={guideOpen}
            title="Channel guide (G)"
            onClick={() => setGuideOpen((open) => !open)}
          >
            Guide
          </button>
        )}
        <button className="iptv-player-modal__close" type="button" onClick={onClose} aria-label="Close player">
          ×
        </button>
      </div>
      <div className="iptv-player-modal__stage">
        <IptvPlayer
          grant={playing.grant}
          autoPlay
          finite={!live}
          onEnded={live ? undefined : onClose}
          onPlaying={live ? onPlaying : undefined}
          onLiveLost={live ? onLiveLost : undefined}
          onPositionUpdate={onPositionUpdate}
          onDeliveryStruggling={onEscalate}
        />
        {cover && (
          <div className="iptv-live-cover" role={cover.kind === 'reconnecting' ? 'status' : 'alert'}>
            {cover.kind === 'reconnecting' ? (
              <p>Reconnecting… ({cover.attempt} of {RECONNECT_ATTEMPTS})</p>
            ) : (
              <>
                <h3>{cover.kind === 'offline' ? 'Channel offline' : 'Lost the channel'}</h3>
                <p>
                  {cover.kind === 'offline'
                    ? 'This channel is temporarily off the air. We’ll keep checking; try another channel in the meantime.'
                    : cover.message}
                </p>
                <div className="iptv-live-cover__actions">
                  {cover.kind === 'offline' && (
                    <button type="button" className="iptv-tab__retry" onClick={() => setGuideOpen(true)}>
                      Open guide
                    </button>
                  )}
                  <button type="button" className="iptv-tab__retry" onClick={tryAgain}>Try again</button>
                  <button type="button" className="iptv-tab__retry" onClick={onClose}>Leave</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      {live && guideOpen && (
        <MiniGuide
          categoryIds={guideCategoryIds}
          favorites={favorites}
          currentStreamId={Number(itemId)}
          onPick={(row) => onSurf({ stream_id: row.stream_id, name: row.name })}
          onClose={() => setGuideOpen(false)}
        />
      )}
    </div>
  )
}
