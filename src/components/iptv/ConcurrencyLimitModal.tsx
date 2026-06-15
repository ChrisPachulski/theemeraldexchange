import type { SessionRow } from '../../lib/api/iptv'
import { useKillIptvSession } from '../../lib/hooks/useIptvSessions'
import { useModalA11y } from '../../lib/hooks/useModalA11y'
import type { ConcurrencyLimitPayload } from './concurrencyLimit'
import { relativeTime, kindLabel } from './sessionFormatting'

// Shown when a stream grant 429s because the upstream's connection cap
// is full. The 429 body now embeds the active sessions so we can render
// "kick" buttons inline — no extra round trip to /api/iptv/sessions
// needed before the user makes a decision.
//
// ConcurrencyLimitPayload + concurrencyPayloadFromError live in
// ./concurrencyLimit.ts so this file is component-only (react-refresh
// requirement).

export function ConcurrencyLimitModal({
  payload,
  onClose,
  onAfterKick,
}: {
  payload: ConcurrencyLimitPayload
  onClose: () => void
  onAfterKick?: () => void
}) {
  // Plain-div dialog: useModalA11y supplies the focus trap, Escape-to-close,
  // and focus restore that aria-modal promises.
  const modalRef = useModalA11y<HTMLDivElement>(onClose)
  return (
    <div ref={modalRef} className="iptv-conn-modal" role="dialog" aria-modal="true" aria-label="Connection limit reached">
      <div className="iptv-conn-modal__panel">
        <header className="iptv-conn-modal__header iptv-conn-modal__header--alert">
          <h2>Connection limit reached</h2>
          <button
            type="button"
            className="iptv-conn-modal__close"
            onClick={onClose}
            aria-label="Close"
          >×</button>
        </header>
        <p className="iptv-conn-modal__summary">
          The mybunny account allows <strong>{payload.limit}</strong> simultaneous streams
          and <strong>{payload.current}</strong> are in use. Kick one to take its slot.
        </p>
        {payload.sessions.length === 0 ? (
          <p className="iptv-conn-modal__empty">
            All slots are held by IPTV apps outside this dashboard. Close one
            of those apps (or restart the device) to free a slot.
          </p>
        ) : (
          <ul className="iptv-conn-modal__list">
            {payload.sessions.map((s) => (
              <KickRow key={s.sessionId} session={s} onAfterKick={onAfterKick} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function KickRow({
  session,
  onAfterKick,
}: {
  session: SessionRow
  onAfterKick?: () => void
}) {
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
      </div>
      <button
        type="button"
        className="iptv-conn-row__kick"
        disabled={kill.isPending}
        onClick={() =>
          kill.mutate(session.sessionId, {
            onSuccess: () => onAfterKick?.(),
          })
        }
      >
        {kill.isPending ? 'Kicking…' : 'Kick'}
      </button>
    </li>
  )
}
