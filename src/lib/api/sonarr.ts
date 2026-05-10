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
  // Additional fields Sonarr returns that we surface in the detail modal.
  genres?: string[]
  runtime?: number
  certification?: string
  firstAired?: string
  ratings?: { value?: number; votes?: number }
  statistics?: {
    seasonCount?: number
    episodeCount?: number
    episodeFileCount?: number
    totalEpisodeCount?: number
    sizeOnDisk?: number
    percentOfEpisodes?: number
  }
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

// Slim subset of Sonarr's queue record — just what the dashboard
// needs to map SAB slots back to series/season for the active card.
export type SonarrQueueRecord = {
  id: number
  seriesId?: number
  seasonNumber?: number
  episodeId?: number
  downloadId?: string
  size?: number
  title?: string
  status?: string
}

export type SonarrQueuePage = {
  page: number
  pageSize: number
  totalRecords: number
  records: SonarrQueueRecord[]
}

export const sonarr = {
  systemStatus: () => get<SystemStatus>('/system/status'),
  qualityProfiles: () => get<QualityProfile[]>('/qualityprofile'),
  rootFolders: () => get<RootFolder[]>('/rootfolder'),
  series: () => get<Series[]>('/series'),
  lookup: (term: string) => get<SeriesSearchResult[]>('/series/lookup', { term }),
  addSeries: (body: Record<string, unknown>) => post<Series, typeof body>('/series', body),
  removeSeries: (id: number, deleteFiles = false) =>
    del(`/series/${id}`, { deleteFiles, addImportListExclusion: false }),
  // Fetched with a large pageSize so a full HotD-style season cluster
  // (10+ records) is captured in one round-trip. We only need
  // downloadId + seriesId + seasonNumber, but Sonarr always returns
  // the full record shape.
  queue: () => get<SonarrQueuePage>('/queue', { pageSize: 200 }),
}
