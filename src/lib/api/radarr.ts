import { createArrClient } from './arrClient'
import type {
  ArrCommandResult,
  ArrEditPatch,
  ArrGrabResult,
  ArrHistoryRecord,
  ArrRelease,
  RadarrRenameRow,
} from './arrAdvanced'

const { get, post, put, del } = createArrClient('Radarr', '/api/radarr/api/v3')

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
  /** True once Radarr has an actual file on disk for this movie. */
  hasFile?: boolean
  /** Radarr's minimum-availability gate (announced/inCinemas/released)
   *  has been met — the movie is at least theoretically obtainable. */
  isAvailable?: boolean
}

/** Playability of an in-library Radarr movie. "In library" only means
 *  TRACKED — an announced future title sits in the library with no file
 *  for months, and no play affordance can work for it: Plex can't have a
 *  file Radarr never downloaded (the Plex title-search fallback link
 *  would render a dead "Play in Plex" button for it).
 *    'playable'     — a file exists on disk
 *    'not_released' — no file, and the title isn't released yet
 *    'missing'      — released, but no file downloaded yet
 *  A payload without hasFile counts as playable so the buttons fail open
 *  exactly as they did before this gate existed. */
export type MovieAvailability = 'playable' | 'not_released' | 'missing'

export function movieAvailability(
  m: Pick<Movie, 'hasFile' | 'isAvailable' | 'status'>,
): MovieAvailability {
  if (m.hasFile === true) return 'playable'
  const notReleased =
    m.isAvailable === false || (m.status != null && m.status !== 'released')
  if (m.hasFile === false) return notReleased ? 'not_released' : 'missing'
  // hasFile null/undefined — Radarr /movie/lookup returns in-library matches
  // WITH the library id but hasFile:null, and that object reaches the modal
  // whenever a discover card is clicked before the library query resolves.
  // The release state alone still proves a future title can't have a file;
  // only a released title fails open as playable here.
  return notReleased ? 'not_released' : 'playable'
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
  upgrade: (id: number) =>
    post<
      | { status: 'grabbing'; title: string; sizeGb: number; qualityWeight: number }
      | { status: 'no_upgrade_available'; scanned: number; capGb: number }
      | { status: 'no_releases_found' },
      Record<string, never>
    >(`/movie/${id}/upgrade`, {}),

  // --- Advanced options (admin-only). Contract: R1–R6. ---

  // R1: fire an allowlisted command (RefreshMovie / MoviesSearch /
  // RenameMovie). The backend rejects any other name (400).
  command: (body: {
    name: 'RefreshMovie' | 'MoviesSearch' | 'RenameMovie'
    movieIds?: number[]
    files?: number[]
  }) => post<ArrCommandResult, typeof body>('/command', body),

  // R2: interactive search — release list for a movie.
  releases: (movieId: number) => get<ArrRelease[]>('/release', { movieId }),

  // R3: grab a hand-picked release. movieId scopes the upstream re-search the
  // backend uses to validate the pick + cap.
  grabRelease: (
    movieId: number,
    body: { guid: string; indexerId: number; allowOverCap?: boolean },
  ) => post<ArrGrabResult, typeof body>('/release', body, { movieId }),

  // R4: preview the rename diff for a movie.
  renamePreview: (movieId: number) => get<RadarrRenameRow[]>('/rename', { movieId }),

  // R5: movie download/import history, newest first.
  history: (movieId: number) => get<ArrHistoryRecord[]>('/history/movie', { movieId }),

  // R6: edit allowlisted fields (monitored / qualityProfileId / rootFolderPath).
  editMovie: (id: number, patch: ArrEditPatch) =>
    put<Movie, ArrEditPatch>(`/movie/${id}`, patch),
}
