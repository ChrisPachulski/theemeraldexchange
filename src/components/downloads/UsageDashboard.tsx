import { useQuery } from '@tanstack/react-query'
import { apiUrl } from '../../lib/api/base'
import { throwApiError } from '../../lib/api/errors'
import { useDocumentVisible } from '../../lib/hooks/useVisibility'
import { fmtCost } from '../../lib/fmtCost'
import './UsageDashboard.css'

// Admin-only roster of per-user Anthropic API spend. Mirrors the
// GrabActivityPanel pattern: collapsible disclosure on the Downloads
// tab, 10s refetch while visible, table layout (not posters).
//
// Each row: avatar/initial · username · calls · errors · cost. Sorted
// by cost descending so the heaviest user surfaces first.

type UsageRow = {
  sub: string
  username: string
  calls: number
  errors: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  costCents: number
}

type FunnelRate = { n: number; d: number; rate: number; ci95: [number, number] }
type FunnelMetrics = {
  window_days: number
  impressions: number
  metrics: {
    added_rate: FunnelRate
    click_rate: FunnelRate
    like_rate: FunnelRate
    dislike_rate: FunnelRate
  }
}

async function fetchAdminUsage(): Promise<UsageRow[]> {
  const r = await fetch(apiUrl('/api/usage/admin'), { credentials: 'include' })
  if (!r.ok) await throwApiError(r, 'Usage admin')
  return (await r.json()) as UsageRow[]
}

async function fetchFunnelMetrics(): Promise<FunnelMetrics> {
  const r = await fetch(apiUrl('/api/recommender/metrics', { windowDays: 30 }), {
    credentials: 'include',
  })
  if (!r.ok) await throwApiError(r, 'Recommendation metrics')
  return (await r.json()) as FunnelMetrics
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function UsageDashboard() {
  const visible = useDocumentVisible()
  const query = useQuery({
    queryKey: ['usage', 'admin'],
    queryFn: fetchAdminUsage,
    refetchInterval: visible ? 15_000 : false,
    refetchIntervalInBackground: false,
    staleTime: 10_000,
  })
  const funnel = useQuery({
    queryKey: ['recommender', 'metrics', 30],
    queryFn: fetchFunnelMetrics,
    refetchInterval: visible ? 60_000 : false,
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  })

  const totalCents = (query.data ?? []).reduce((sum, r) => sum + r.costCents, 0)
  const totalCalls = (query.data ?? []).reduce((sum, r) => sum + r.calls, 0)

  return (
    <details className="usage-dashboard">
      <summary className="usage-dashboard__summary">
        <span className="usage-dashboard__title">Recommendation health &amp; AI usage (30d)</span>
        <span className="usage-dashboard__total">
          {funnel.data
            ? `${funnel.data.impressions} impressions · ${(funnel.data.metrics.added_rate.rate * 100).toFixed(1)}% added`
            : query.data
              ? `${totalCalls} calls · ${fmtCost(totalCents)}`
              : '—'}
        </span>
      </summary>

      <div className="usage-dashboard__body">
        {funnel.data && (
          <dl className="usage-dashboard__funnel">
            {(
              [
                ['Clicked', funnel.data.metrics.click_rate],
                ['Added', funnel.data.metrics.added_rate],
                ['Liked', funnel.data.metrics.like_rate],
                ['Disliked', funnel.data.metrics.dislike_rate],
              ] as const
            ).map(([label, metric]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{(metric.rate * 100).toFixed(1)}%</dd>
                <span>{metric.n}/{metric.d}</span>
              </div>
            ))}
          </dl>
        )}
        {funnel.error && (
          <p className="usage-dashboard__error">Couldn't load recommendation health.</p>
        )}
        {query.isPending && <p className="usage-dashboard__empty">Loading…</p>}
        {query.error && (
          <p className="usage-dashboard__error">
            Couldn't load usage: {String(query.error)}
          </p>
        )}
        {query.data && query.data.length === 0 && (
          <p className="usage-dashboard__empty">
            No AI calls in the last 30 days. Users need to set their own
            key in the user menu to enable personalized picks.
          </p>
        )}

        {query.data && query.data.length > 0 && (
          <table className="usage-dashboard__table">
            <thead>
              <tr>
                <th>User</th>
                <th>Calls</th>
                <th>Errors</th>
                <th>Input tk</th>
                <th>Cache hit</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {query.data.map((row) => (
                <tr key={row.sub}>
                  <td>{row.username}</td>
                  <td className="usage-dashboard__num">{row.calls}</td>
                  <td className={`usage-dashboard__num${row.errors > 0 ? ' usage-dashboard__num--warn' : ''}`}>
                    {row.errors}
                  </td>
                  <td className="usage-dashboard__num">{fmtTokens(row.inputTokens)}</td>
                  <td className="usage-dashboard__num">{fmtTokens(row.cacheReadInputTokens)}</td>
                  <td className="usage-dashboard__num usage-dashboard__cost">{fmtCost(row.costCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </details>
  )
}
