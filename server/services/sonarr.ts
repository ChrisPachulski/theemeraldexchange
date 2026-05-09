// Sonarr fetch helper. The backend is the only thing that ever holds
// the X-Api-Key — it never leaves this process.

import { env } from '../env.js'

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
): Promise<Response> {
  const url = new URL(`${env.sonarrUrl}${path}`)
  if (query) {
    for (const [k, v] of query.entries()) url.searchParams.set(k, v)
  }
  return fetch(url.toString(), {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      'X-Api-Key': env.sonarrApiKey,
      Accept: 'application/json',
    },
  })
}

export async function sonarrRootFolders(): Promise<RootFolder[]> {
  const r = await sonarrFetch('/api/v3/rootfolder')
  if (!r.ok) throw new Error(`sonarr rootfolder ${r.status}`)
  return (await r.json()) as RootFolder[]
}
