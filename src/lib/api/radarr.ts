const BASE = '/api/radarr/api/v3'

async function get<T>(path: string, params?: Record<string, string | number | boolean>): Promise<T> {
  const url = new URL(`${BASE}${path}`, window.location.origin)
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  }
  const res = await fetch(url.toString().replace(window.location.origin, ''))
  if (!res.ok) throw new Error(`Radarr ${path}: ${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

async function post<T, B>(path: string, body: B): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Radarr ${path}: ${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

async function del(path: string, params?: Record<string, string | number | boolean>): Promise<void> {
  const url = new URL(`${BASE}${path}`, window.location.origin)
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  }
  const res = await fetch(url.toString().replace(window.location.origin, ''), { method: 'DELETE' })
  if (!res.ok) throw new Error(`Radarr ${path}: ${res.status} ${res.statusText}`)
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

export const radarr = {
  systemStatus: () => get<{ version: string; appName: string }>('/system/status'),
  qualityProfiles: () => get<QualityProfile[]>('/qualityprofile'),
  rootFolders: () => get<RootFolder[]>('/rootfolder'),
  movies: () => get<Movie[]>('/movie'),
  lookup: (term: string) => get<MovieSearchResult[]>('/movie/lookup', { term }),
  addMovie: (body: Record<string, unknown>) => post<Movie, typeof body>('/movie', body),
  removeMovie: (id: number, deleteFiles = false) =>
    del(`/movie/${id}`, { deleteFiles, addImportExclusion: false }),
}
