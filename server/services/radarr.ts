// Radarr fetch helper. Same pattern as sonarr — the API key is held by
// this process only.

import { env } from '../env.js'
import {
  fetchWithTimeout,
  LAN_TIMEOUT_MS,
  normalizeUpstreamAuthFailure,
  NotConfiguredError,
} from './upstream.js'

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
  timeoutMs: number = LAN_TIMEOUT_MS,
): Promise<Response> {
  // Radarr is optional (plan 006 Phase 0): unset key → typed 503 via onError.
  const apiKey = env.radarrApiKey
  if (!apiKey) throw new NotConfiguredError('radarr')
  const url = new URL(`${env.radarrUrl}${path}`)
  if (query) {
    for (const [k, v] of query.entries()) url.searchParams.set(k, v)
  }
  return normalizeUpstreamAuthFailure(
    await fetchWithTimeout(
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
      'radarr',
    ),
    'radarr',
  )
}

export async function radarrRootFolders(): Promise<RootFolder[]> {
  const r = await radarrFetch('/api/v3/rootfolder')
  if (!r.ok) throw new Error(`radarr rootfolder ${r.status}`)
  return (await r.json()) as RootFolder[]
}
