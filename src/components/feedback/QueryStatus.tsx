import type { UseQueryResult } from '@tanstack/react-query'
import { LoadingPulse } from './LoadingPulse'

type Props = {
  query: UseQueryResult<readonly unknown[]>
  /** Plural noun for the copy: "Loading albums", "Couldn't load albums." */
  what: string
  empty: string
}

/** Loading / error-with-retry / empty for a list query, so a failed fetch is
 *  never mistaken for an empty library. Renders nothing once there are rows. */
export function QueryStatus({ query, what, empty }: Props) {
  if (query.isPending) return <LoadingPulse>Loading {what}</LoadingPulse>
  if (query.isError) {
    return (
      <div className="iptv-tab__status iptv-tab__status--error" role="alert">
        <p>Couldn't load {what}.</p>
        <button type="button" className="iptv-tab__retry" onClick={() => void query.refetch()}>
          Retry
        </button>
      </div>
    )
  }
  if (query.data.length === 0) return <p className="iptv-tab__status">{empty}</p>
  return null
}
