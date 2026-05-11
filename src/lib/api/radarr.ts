import { throwApiError } from './errors'
import { apiUrl } from './base'

const BASE = '/api/radarr/api/v3'

async function get<T>(path: string, params?: Record<string, string | number | boolean>): Promise<T> {
  const res = await fetch(apiUrl(`${BASE}${path}`, params), {
    credentials: 'include',
  })
  if (!res.ok) await throwApiError(res, `Radarr ${path}`)
  return res.json() as Promise<T>
}

async function post<T, B>(path: string, body: B): Promise<T> {
  const res = await fetch(apiUrl(`${BASE}${path}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!res.ok) await throwApiError(res, `Radarr ${path}`)
  return res.json() as Promise<T>
}

async function del(path: string, params?: Record<string, string | number | boolean>): Promise<void> {
  const res = await fetch(apiUrl(`${BASE}${path}`, params), {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!res.ok) await throwApiError(res, `Radarr ${path}`)
}

export type MovieSearchResult = {
  tmdbId: number
  imdbId?: string
  title: string
  year: number
  overview?: string
  studio?: string
  status?: string
  remotePoster?: string
  images?: Array<{ coverType: string; remoteUrl?: string; url?: string }>
  runtime?: number
  // Additional fields Radarr returns that we surface in the detail modal.
  genres?: string[]
  certification?: string
  originalTitle?: string
  inCinemas?: string
  digitalRelease?: string
  physicalRelease?: string
  ratings?: {
    imdb?: { value?: number; votes?: number }
    tmdb?: { value?: number; votes?: number }
    rottenTomatoes?: { value?: number }
  }
  collection?: { title?: string; tmdbId?: number }
}

export type Movie = MovieSearchResult & {
  id: number
  qualityProfileId: number
  rootFolderPath: string
  monitored: boolean
  added: string
}

export type QualityProfile = { id: number; name: string }
export type RootFolder = { id: number; path: string; freeSpace?: number }

// Slim subset of Radarr's queue record — same shape pattern as
// SonarrQueueRecord so the DownloadsTab can treat both uniformly.
export type RadarrQueueRecord = {
  id: number
  movieId?: number
  downloadId?: string
  size?: number
  title?: string
  status?: string
}

export type RadarrQueuePage = {
  page: number
  pageSize: number
  totalRecords: number
  records: RadarrQueueRecord[]
}

export const radarr = {
  systemStatus: () => get<{ version: string; appName: string }>('/system/status'),
  qualityProfiles: () => get<QualityProfile[]>('/qualityprofile'),
  rootFolders: () => get<RootFolder[]>('/rootfolder'),
  movies: () => get<Movie[]>('/movie'),
  lookup: (term: string) => get<MovieSearchResult[]>('/movie/lookup', { term }),
  addMovie: (body: Record<string, unknown>) => post<Movie, typeof body>('/movie', body),
  removeMovie: (id: number, deleteFiles = false) =>
    del(`/movie/${id}`, { deleteFiles, addImportExclusion: false }),
  queue: () => get<RadarrQueuePage>('/queue', { pageSize: 200 }),
}
