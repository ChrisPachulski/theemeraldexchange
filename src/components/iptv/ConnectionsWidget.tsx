import { useState } from 'react'
import type { SessionRow } from '../../lib/api/iptv'
import { useIptvSessions, useKillIptvSession } from '../../lib/hooks/useIptvSessions'
import { useModalA11y } from '../../lib/hooks/useModalA11y'

// Pill at the top-right of the IPTV shell showing "N / M slots" against
// the mybunny upstream account cap. Tap to open the sessions panel; from
// there the user can kick one of OUR sessions to free a slot. Sessions
// from other IPTV apps using the same mybunny credentials directly (e.g.
// KSPlayer on a phone) are invisible to us — the panel explains that and
// surfaces the upstream's reported active_cons so the gap is visible.

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function kindLabel(kind: SessionRow['kind']): string {
  switch (kind) {
    case 'live': return 'Live'
    case 'remux': return 'Live (Apple)'
    case 'vod': return 'Movie'
    case 'series': return 'Episode'
    case 'catchup': return 'Catchup'
    default: return kind
  }
}

export function ConnectionsWidget() {
  const [open, setOpen] = useState(false)
  const { data } = useIptvSessions()

  const ours = data?.ours ?? []
  const upstreamActive = data?.upstream?.activeConnections ?? null
  const upstreamMax = data?.upstream?.maxConnections ?? null

  // Three displayed numbers, chosen for honesty: prefer the upstream's own
  // count when we have it (matches the cap mybunny enforces), fall back to
  // our local tracker otherwise.
  const usedDisplay = upstreamActive ?? ours.length
  const capDisplay = upstreamMax ?? '?'
  const atCap = upstreamMax != null && usedDisplay >= upstreamMax

  return (
    <>
      <button
        type="button"
        className={`iptv-conn-pill ${atCap ? 'iptv-conn-pill--full' : ''}`}
        onClick={() => setOpen(true)}
        aria-label="Connections"
        title="Connections in use against your mybunny account"
      >
        <span className="iptv-conn-pill__dot" aria-hidden />
        {usedDisplay}/{capDisplay}
      </button>

      {open && (
        <ConnectionsPanel
          ours={ours}
          upstreamActive={upstreamActive}
          upstreamMax={upstreamMax}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function ConnectionsPanel({
  ours,
  upstreamActive,
  upstreamMax,
  onClose,
}: {
  ours: SessionRow[]
  upstreamActive: number | null
  upstreamMax: number | null
  onClose: () => void
}) {
  // Plain-div dialog: useModalA11y supplies the focus trap, Escape-to-close,
  // and focus restore that aria-modal promises.
  const modalRef = useModalA11y<HTMLDivElement>(onClose)
  return (
    <div ref={modalRef} className="iptv-conn-modal" role="dialog" aria-modal="true" aria-label="Active connections">
      <div className="iptv-conn-modal__panel">
        <header className="iptv-conn-modal__header">
          <h2>Active connections</h2>
          <button
            type="button"
            className="iptv-conn-modal__close"
            onClick={onClose}
            aria-label="Close"
          >×</button>
        </header>

        <p className="iptv-conn-modal__summary">
          Upstream account allows <strong>{upstreamMax ?? '?'}</strong> simultaneous streams.
          {' '}<strong>{upstreamActive ?? '?'}</strong> currently in use upstream.
          {' '}<strong>{ours.length}</strong> opened from this dashboard.
        </p>

        {ours.length === 0 ? (
          <p className="iptv-conn-modal__empty">
            No sessions opened from this dashboard. If the upstream count is
            above zero, the slot is held by another IPTV app (e.g. on a
            phone). Close that app or restart the device to free it.
          </p>
        ) : (
          <ul className="iptv-conn-modal__list">
            {ours.map((s) => <ConnectionRow key={s.sessionId} session={s} />)}
          </ul>
        )}
      </div>
    </div>
  )
}

function ConnectionRow({ session }: { session: SessionRow }) {
  const kill = useKillIptvSession()
  const title = session.resolvedTitle ?? session.title ?? `#${session.resourceId}`
  return (
    <li className="iptv-conn-row">
      <div className="iptv-conn-row__main">
        <span className="iptv-conn-row__kind">{kindLabel(session.kind)}</span>
        <span className="iptv-conn-row__title" title={title}>{title}</span>
      </div>
      <div className="iptv-conn-row__meta">
        <span>{session.ip ?? 'unknown ip'}</span>
        <span>started {relativeTime(session.startedAt)}</span>
        <span>last seen {relativeTime(session.lastSeen)}</span>
      </div>
      <button
        type="button"
        className="iptv-conn-row__kick"
        disabled={kill.isPending}
        onClick={() => kill.mutate(session.sessionId)}
      >
        {kill.isPending ? 'Kicking…' : 'Kick'}
      </button>
    </li>
  )
}
