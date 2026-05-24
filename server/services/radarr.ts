// Radarr fetch helper. Same pattern as sonarr — the API key is held by
// this process only.

import { env } from '../env.js'
import { fetchWithTimeout, LAN_TIMEOUT_MS } from './upstream.js'

export type RootFolder = {
  id: number
  path: string
  freeSpace?: number
  totalSpace?: number
}

export async function radarrFetch(
  path: string,
  init: RequestInit = {},
  query?: URLSearchParams,
): Promise<Response> {
  const url = new URL(`${env.radarrUrl}${path}`)
  if (query) {
    for (const [k, v] of query.entries()) url.searchParams.set(k, v)
  }
  return fetchWithTimeout(
    url.toString(),
    {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        'X-Api-Key': env.radarrApiKey,
        Accept: 'application/json',
      },
    },
    LAN_TIMEOUT_MS,
    'radarr',
  )
}

export async function radarrRootFolders(): Promise<RootFolder[]> {
  const r = await radarrFetch('/api/v3/rootfolder')
  if (!r.ok) throw new Error(`radarr rootfolder ${r.status}`)
  return (await r.json()) as RootFolder[]
}
