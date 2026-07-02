// Sonarr/Radarr fetch helpers — one parameterized client, two instances
// (the two files this replaces were line-for-line identical apart from
// env keys and names). The backend is the only thing that ever holds the
// X-Api-Key — it never leaves this process.

import { env } from '../env.js'
import { fetchWithTimeout, LAN_TIMEOUT_MS } from './upstream.js'

type RootFolder = {
  id: number
  path: string
  freeSpace?: number
  totalSpace?: number
}

type ArrService = 'sonarr' | 'radarr'

// env is read per call (not captured at module init) — same behavior as
// the per-service copies this replaces, so env stubbing in tests works.
function arrFetch(service: ArrService) {
  return (
    path: string,
    init: RequestInit = {},
    query?: URLSearchParams,
    timeoutMs: number = LAN_TIMEOUT_MS,
  ): Promise<Response> => {
    const base = service === 'sonarr' ? env.sonarrUrl : env.radarrUrl
    const url = new URL(`${base}${path}`)
    if (query) {
      for (const [k, v] of query.entries()) url.searchParams.set(k, v)
    }
    return fetchWithTimeout(
      url.toString(),
      {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          'X-Api-Key': service === 'sonarr' ? env.sonarrApiKey : env.radarrApiKey,
          Accept: 'application/json',
        },
      },
      timeoutMs,
      service,
    )
  }
}

function arrRootFolders(service: ArrService, doFetch: ReturnType<typeof arrFetch>) {
  return async (): Promise<RootFolder[]> => {
    const r = await doFetch('/api/v3/rootfolder')
    if (!r.ok) throw new Error(`${service} rootfolder ${r.status}`)
    return (await r.json()) as RootFolder[]
  }
}

export const sonarrFetch = arrFetch('sonarr')
export const radarrFetch = arrFetch('radarr')
export const sonarrRootFolders = arrRootFolders('sonarr', sonarrFetch)
export const radarrRootFolders = arrRootFolders('radarr', radarrFetch)
