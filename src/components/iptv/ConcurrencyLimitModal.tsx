import type { ApiError } from '../../lib/api/errors'
import type { SessionRow } from '../../lib/api/iptv'
import { useKillIptvSession } from '../../lib/hooks/useIptvSessions'

// Shown when a stream grant 429s because the upstream's connection cap
// is full. The 429 body now embeds the active sessions so we can render
// "kick" buttons inline — no extra round trip to /api/iptv/sessions
// needed before the user makes a decision.

export type ConcurrencyLimitPayload = {
  limit: number
  current: number
  sessions: SessionRow[]
}

export function concurrencyPayloadFromError(e: unknown): ConcurrencyLimitPayload | null {
  if (!e || typeof e !== 'object') return null
  const err = e as ApiError
  if (err.status !== 429) return null
  const d = err.details ?? {}
  if ((d as { reason?: string }).reason !== 'iptv_concurrency_limit') return null
  const sessions = Array.isArray((d as { sessions?: unknown }).sessions)
    ? ((d as { sessions: SessionRow[] }).sessions)
    : []
  return {
    limit: Number((d as { limit?: number }).limit ?? 0),
    current: Number((d as { current?: number }).current ?? sessions.length),
    sessions,
  }
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3_600_000)}h ago`
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

export function ConcurrencyLimitModal({
  payload,
  onClose,
  onAfterKick,
}: {
  payload: ConcurrencyLimitPayload
  onClose: () => void
  onAfterKick?: () => void
}) {
  return (
    <div className="iptv-conn-modal" role="dialog" aria-modal="true" aria-label="Connection limit reached">
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
