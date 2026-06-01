import { throwApiError } from './errors'
import { apiUrl } from './base'

// Mirror of server's GrabEvent type (server/services/grabLog.ts). Kept in
// sync by hand; grabs.driftguard.test.ts asserts this union matches the
// server's member-for-member so a new server event type can't silently
// resolve to undefined in GrabActivityPanel's exhaustive label/tone maps.
export type GrabEventType =
  | 'grab_started'
  | 'search_failed'
  | 'no_releases'
  | 'all_rejected_by_cap'
  | 'all_rejected_by_profile'
  | 'planned_size_exceeds_free_space'
  | 'grab_succeeded'
  | 'grab_failed'

export type GrabEvent = {
  ts: string
  app: 'sonarr' | 'radarr'
  itemId: number
  type: GrabEventType
  title?: string
  capGb?: number
  status?: number
  scanned?: number
  eligible?: number
  release?: {
    title: string
    sizeBytes: number
    qualityWeight: number
    seasonNumber?: number
  }
  error?: string
}

async function get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  const res = await fetch(apiUrl(path, params), { credentials: 'include' })
  if (!res.ok) await throwApiError(res, path)
  return res.json() as Promise<T>
}

export const grabs = {
  recent: (limit = 20) => get<GrabEvent[]>('/api/grabs/recent', { limit }),
  byItem: (app: 'sonarr' | 'radarr', itemId: number, limit = 20) =>
    get<GrabEvent[]>('/api/grabs/by-item', { app, itemId, limit }),
}
