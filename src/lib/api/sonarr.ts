import { throwApiError } from './errors'
import { apiUrl } from './base'

const BASE = '/api/sonarr/api/v3'

async function get<T>(path: string, params?: Record<string, string | number | boolean>): Promise<T> {
  const res = await fetch(apiUrl(`${BASE}${path}`, params), {
    credentials: 'include',
  })
  if (!res.ok) await throwApiError(res, `Sonarr ${path}`)
  return res.json() as Promise<T>
}

async function post<T, B>(path: string, body: B): Promise<T> {
  const res = await fetch(apiUrl(`${BASE}${path}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!res.ok) await throwApiError(res, `Sonarr ${path}`)
  return res.json() as Promise<T>
}

async function del(path: string, params?: Record<string, string | number | boolean>): Promise<void> {
  const res = await fetch(apiUrl(`${BASE}${path}`, params), {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!res.ok) await throwApiError(res, `Sonarr ${path}`)
}

export type SystemStatus = {
  version: string
  appName: string
  instanceName: string
}

export type SeriesSearchResult = {
  tvdbId: number
  imdbId?: string
  title: string
  year: number
  overview?: string
  network?: string
  status?: string
  remotePoster?: string
  images?: Array<{ coverType: string; remoteUrl?: string; url?: string }>
  seasons?: Array<{ seasonNumber: number; monitored: boolean }>
}

export type Series = SeriesSearchResult & {
  id: number
  qualityProfileId: number
  rootFolderPath: string
  monitored: boolean
  added: string
}

export type QualityProfile = { id: number; name: string }
export type RootFolder = { id: number; path: string; freeSpace?: number }

export const sonarr = {
  systemStatus: () => get<SystemStatus>('/system/status'),
  qualityProfiles: () => get<QualityProfile[]>('/qualityprofile'),
  rootFolders: () => get<RootFolder[]>('/rootfolder'),
  series: () => get<Series[]>('/series'),
  lookup: (term: string) => get<SeriesSearchResult[]>('/series/lookup', { term }),
  addSeries: (body: Record<string, unknown>) => post<Series, typeof body>('/series', body),
  removeSeries: (id: number, deleteFiles = false) =>
    del(`/series/${id}`, { deleteFiles, addImportListExclusion: false }),
}
