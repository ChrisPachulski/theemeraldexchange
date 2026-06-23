// Shared client types for the Sonarr/Radarr Advanced-options surface. These
// mirror the backend projection in server/services/arrAdvanced.ts and the
// contract tables (S1–S7 / R1–R6) in the design spec. Both api/sonarr.ts and
// api/radarr.ts re-export the methods that consume these shapes.

/** A projected release row from the interactive search (S2 / R2). The
 *  backend adds `sizeGb` and `overCap` so the client never recomputes them. */
export type ArrRelease = {
  guid: string
  indexerId: number
  title: string
  size: number
  sizeGb: number
  seeders?: number
  protocol: string
  indexer?: string
  ageHours?: number
  quality: string
  qualityWeight: number
  languages: string[]
  /** Sonarr only. */
  fullSeason?: boolean
  /** Sonarr only. */
  seasonNumber?: number
  rejected: boolean
  rejections: string[]
  overCap: boolean
}

/** Result of an interactive grab (S3 / R3). */
export type ArrGrabResult = {
  status: 'grabbed'
  title: string
  sizeGb: number
}

/** A single history row (S6 / R5). */
export type ArrHistoryRecord = {
  date: string
  eventType: string
  sourceTitle: string
  quality: string
  seasonNumber?: number
  episodeId?: number
}

/** Fired command acknowledgement (S1 / R1). */
export type ArrCommandResult = {
  id?: number
  name?: string
  status?: string
}

/** Sonarr rename-preview row (S4). */
export type SonarrRenameRow = {
  episodeFileId?: number
  seasonNumber?: number
  existingPath?: string
  newPath?: string
}

/** Radarr rename-preview row (R4). */
export type RadarrRenameRow = {
  movieFileId?: number
  existingPath?: string
  newPath?: string
}

/** Allowlisted edit fields for S7 / R6. */
export type ArrEditPatch = {
  monitored?: boolean
  qualityProfileId?: number
  rootFolderPath?: string
}
