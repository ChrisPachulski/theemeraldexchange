import type { ApiError } from '../../lib/api/errors'
import type { SessionRow } from '../../lib/api/iptv'

// Lives in its own file (not alongside ConcurrencyLimitModal) so the
// modal file only exports the React component — react-refresh requires
// component-only modules for HMR to work cleanly.

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
