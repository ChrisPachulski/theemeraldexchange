import { createArrClient } from './arrClient'
import type {
  ArrCommandResult,
  ArrEditPatch,
  ArrGrabResult,
  ArrHistoryRecord,
  ArrRelease,
  SonarrRenameRow,
} from './arrAdvanced'

const { get, post, put, del } = createArrClient('Sonarr', '/api/sonarr/api/v3')

export type SystemStatus = {
  version: string
  appName: string
  instanceName: string
}

export type SeasonStatistics = {
  episodeCount?: number
  episodeFileCount?: number
  totalEpisodeCount?: number
  sizeOnDisk?: number
  percentOfEpisodes?: number
}

export type SeriesSearchResult = {
  tvdbId: number
  tmdbId?: number
  imdbId?: string
  title: string
  year: number
  overview?: string
  network?: string
  status?: string
  remotePoster?: string
  images?: Array<{ coverType: string; remoteUrl?: string; url?: string }>
  seasons?: Array<{ seasonNumber: number; monitored: boolean; statistics?: SeasonStatistics }>
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

/** Playability of an in-library Sonarr series — the TV counterpart of
 *  radarr's movieAvailability. A show with zero downloaded episodes has
 *  nothing to play anywhere (Plex included), so play affordances must
 *  not render for it. Missing statistics fail open as playable. */
export type SeriesAvailability = 'playable' | 'not_released' | 'missing'

export function seriesAvailability(
  s: Pick<Series, 'status' | 'statistics'>,
): SeriesAvailability {
  const files = s.statistics?.episodeFileCount
  if (files == null || files > 0) return 'playable'
  return s.status === 'upcoming' ? 'not_released' : 'missing'
}

export type QualityProfile = { id: number; name: string }
export type RootFolder = { id: number; path: string; freeSpace?: number }

export type Episode = {
  id: number
  seriesId: number
  seasonNumber: number
  episodeNumber: number
  title: string
  airDate?: string
  airDateUtc?: string
  overview?: string
  hasFile: boolean
  monitored: boolean
}

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
  // Sonarr's import-pipeline state. 'importPending'/'importBlocked' mean the
  // download finished but Sonarr can't move it into the library — these jam
  // the queue and are what the Downloads tab surfaces + clears.
  trackedDownloadState?: string
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
  monitorSeason: (seriesId: number, seasonNumber: number) =>
    post<{ ok: boolean; seriesId: number; seasonNumber: number }, Record<string, never>>(
      `/series/${seriesId}/seasons/${seasonNumber}/monitor`,
      {},
    ),
  episodes: (seriesId: number) => get<Episode[]>('/episode', { seriesId }),
  // Fetched with a large pageSize so a full HotD-style season cluster
  // (10+ records) is captured in one round-trip. We only need
  // downloadId + seriesId + seasonNumber, but Sonarr always returns
  // the full record shape.
  queue: () => get<SonarrQueuePage>('/queue', { pageSize: 200 }),
  // Admin: remove + blocklist + re-search every import-jammed record.
  clearStuck: () =>
    post<{ removed: number }, Record<string, never>>('/queue/clear-stuck', {}),

  // --- Advanced options (admin-only). Contract: S1–S7. ---

  // S1: fire an allowlisted command (RefreshSeries / SeriesSearch /
  // EpisodeSearch / RenameFiles). The backend rejects any other name (400).
  command: (body: {
    name: 'RefreshSeries' | 'SeriesSearch' | 'EpisodeSearch' | 'RenameFiles'
    seriesId?: number
    episodeIds?: number[]
    files?: number[]
  }) => post<ArrCommandResult, typeof body>('/command', body),

  // S2: interactive search — release list for a series/season.
  releases: (seriesId: number, seasonNumber?: number) =>
    get<ArrRelease[]>(
      '/release',
      seasonNumber === undefined ? { seriesId } : { seriesId, seasonNumber },
    ),

  // S3: grab a hand-picked release. seriesId (+ optional seasonNumber) scope
  // the upstream re-search the backend uses to validate the pick + cap.
  grabRelease: (
    seriesId: number,
    body: { guid: string; indexerId: number; allowOverCap?: boolean },
    seasonNumber?: number,
  ) =>
    post<ArrGrabResult, typeof body>(
      '/release',
      body,
      seasonNumber === undefined ? { seriesId } : { seriesId, seasonNumber },
    ),

  // S4: preview the rename diff for a series.
  renamePreview: (seriesId: number) => get<SonarrRenameRow[]>('/rename', { seriesId }),

  // S5: batch episode monitor toggle.
  monitorEpisodes: (episodeIds: number[], monitored: boolean) =>
    put<{ ok: boolean; updated: number }, { episodeIds: number[]; monitored: boolean }>(
      '/episode/monitor',
      { episodeIds, monitored },
    ),

  // S6: series download/import history, newest first.
  history: (seriesId: number) => get<ArrHistoryRecord[]>('/history/series', { seriesId }),

  // S7: edit allowlisted fields (monitored / qualityProfileId / rootFolderPath).
  editSeries: (id: number, patch: ArrEditPatch) =>
    put<Series, ArrEditPatch>(`/series/${id}`, patch),
}
