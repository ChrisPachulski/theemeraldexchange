import type { SessionRow } from '../../lib/api/iptv'

// Shared session-display helpers for the IPTV connection UIs (ConnectionsWidget
// and ConcurrencyLimitModal), which previously held their own copies. This
// relativeTime is the 4-branch form (down to days) — the modal's old copy
// stopped at hours, so very old sessions now read "1d ago" instead of "30h
// ago"; strictly a display improvement, no behavioural change.
export function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export function kindLabel(kind: SessionRow['kind']): string {
  switch (kind) {
    case 'live': return 'Live'
    case 'remux': return 'Live (Apple)'
    case 'vod': return 'Movie'
    case 'series': return 'Episode'
    case 'catchup': return 'Catchup'
    default: return kind
  }
}
