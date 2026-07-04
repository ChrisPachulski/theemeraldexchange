// Sonarr fetch helper. The backend is the only thing that ever holds
// the X-Api-Key — it never leaves this process.

import { env } from '../env.js'
import { fetchWithTimeout, LAN_TIMEOUT_MS, NotConfiguredError } from './upstream.js'

export type RootFolder = {
  id: number
  path: string
  freeSpace?: number
  totalSpace?: number
}

export async function sonarrFetch(
  path: string,
  init: RequestInit = {},
  query?: URLSearchParams,
  timeoutMs: number = LAN_TIMEOUT_MS,
): Promise<Response> {
  // Sonarr is optional (plan 006 Phase 0): unset key → typed 503 via onError.
  const apiKey = env.sonarrApiKey
  if (!apiKey) throw new NotConfiguredError('sonarr')
  const url = new URL(`${env.sonarrUrl}${path}`)
  if (query) {
    for (const [k, v] of query.entries()) url.searchParams.set(k, v)
  }
  return fetchWithTimeout(
    url.toString(),
    {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        'X-Api-Key': apiKey,
        Accept: 'application/json',
      },
    },
    timeoutMs,
    'sonarr',
  )
}

export async function sonarrRootFolders(): Promise<RootFolder[]> {
  const r = await sonarrFetch('/api/v3/rootfolder')
  if (!r.ok) throw new Error(`sonarr rootfolder ${r.status}`)
  return (await r.json()) as RootFolder[]
}
