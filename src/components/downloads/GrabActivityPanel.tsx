import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { grabs, type GrabEvent, type GrabEventType } from '../../lib/api/grabs'
import { useDocumentVisible } from '../../lib/hooks/useVisibility'
import './GrabActivityPanel.css'

// Admin-only diagnostic surface. Renders the last 20 grab events from
// the backend's JSONL log so the admin can answer "why didn't X grab?"
// without SSHing to the NAS. Defaults to collapsed — this is a tool,
// not a daily-driver widget. Polls every 10s while the tab is visible.

const STATUS_LABEL: Record<GrabEventType, string> = {
  grab_started: 'searching',
  search_failed: 'indexer error',
  no_releases: 'no releases',
  all_rejected_by_cap: 'over cap',
  all_rejected_by_profile: 'profile rejected',
  planned_size_exceeds_free_space: 'low disk space',
  grab_succeeded: 'grabbed',
  grab_failed: 'grab failed',
}

// Pill modifier — emerald success / red failure / amber empty-or-rejected
// / muted info-only. Keeps the at-a-glance read fast.
const STATUS_TONE: Record<GrabEventType, 'ok' | 'err' | 'warn' | 'info'> = {
  grab_started: 'info',
  search_failed: 'err',
  no_releases: 'warn',
  all_rejected_by_cap: 'warn',
  all_rejected_by_profile: 'info',
  planned_size_exceeds_free_space: 'warn',
  grab_succeeded: 'ok',
  grab_failed: 'err',
}

const GB = 1024 * 1024 * 1024

function fmtSize(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return ''
  return `${(bytes / GB).toFixed(2)} GB`
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function buildDetail(e: GrabEvent): string {
  // One-line summary appropriate to the event type. Falls back to '' so
  // the empty cell collapses visually instead of showing literal "n/a".
  switch (e.type) {
    case 'grab_started':
      return ''
    case 'search_failed':
      return e.status ? `HTTP ${e.status}` : ''
    case 'no_releases':
      return `${e.scanned ?? 0} scanned`
    case 'all_rejected_by_cap':
      return `${e.scanned ?? 0} scanned · cap ${e.capGb ?? '?'} GB`
    case 'all_rejected_by_profile':
      return `${e.eligible ?? 0} cap-eligible, all rejected`
    case 'planned_size_exceeds_free_space':
      return `${e.eligible ?? 0} eligible · insufficient free space`
    case 'grab_succeeded':
    case 'grab_failed': {
      const parts: string[] = []
      if (e.release) {
        const r = e.release
        const head = r.seasonNumber !== undefined ? `S${r.seasonNumber} · ` : ''
        parts.push(`${head}${fmtSize(r.sizeBytes)}`.trim())
      }
      if (e.type === 'grab_failed' && e.status) parts.push(`HTTP ${e.status}`)
      if (e.type === 'grab_failed' && e.error) parts.push(e.error.slice(0, 60))
      return parts.filter(Boolean).join(' · ')
    }
  }
}

export function GrabActivityPanel() {
  const visible = useDocumentVisible()
  const [expanded, setExpanded] = useState<string | null>(null)
  const query = useQuery({
    queryKey: ['grabs', 'recent'],
    queryFn: () => grabs.recent(20),
    refetchInterval: visible ? 10_000 : false,
    refetchIntervalInBackground: false,
    staleTime: 5_000,
  })

  return (
    <details className="grab-activity">
      <summary className="grab-activity__summary">
        <span className="grab-activity__title">Grab activity</span>
        <span className="grab-activity__count">
          {query.data ? `last ${query.data.length}` : '—'}
        </span>
      </summary>

      <div className="grab-activity__body">
        {query.isPending && <p className="grab-activity__empty">Loading…</p>}
        {query.error && (
          <p className="grab-activity__error">
            Couldn't load grab events: {String(query.error)}
          </p>
        )}
        {query.data && query.data.length === 0 && (
          <p className="grab-activity__empty">
            No grab events yet. Add something to start populating the log.
          </p>
        )}

        {query.data && query.data.length > 0 && (
          <ul className="grab-activity__list">
            {query.data.map((e) => {
              const rowKey = `${e.ts}-${e.app}-${e.itemId}-${e.type}`
              const tone = STATUS_TONE[e.type]
              const detail = buildDetail(e)
              const isOpen = expanded === rowKey
              return (
                <li key={rowKey} className="grab-activity__row">
                  <button
                    type="button"
                    className="grab-activity__row-button"
                    onClick={() => setExpanded(isOpen ? null : rowKey)}
                    aria-expanded={isOpen}
                  >
                    <span className="grab-activity__time">{fmtTime(e.ts)}</span>
                    <span className={`grab-activity__app grab-activity__app--${e.app}`}>
                      {e.app === 'sonarr' ? 'TV' : 'Mov'}
                    </span>
                    <span className="grab-activity__title-cell" title={e.title}>
                      {e.title ?? `id ${e.itemId}`}
                    </span>
                    <span className={`grab-activity__pill grab-activity__pill--${tone}`}>
                      {STATUS_LABEL[e.type]}
                    </span>
                    <span className="grab-activity__detail">{detail}</span>
                  </button>
                  {isOpen && (
                    <pre className="grab-activity__json">{JSON.stringify(e, null, 2)}</pre>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </details>
  )
}
