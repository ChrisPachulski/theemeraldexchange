// server/services/mediaLibraryDbSingleton.ts
//
// Lazy cached handle for media-core's read-only media.db, mirroring
// iptvDbSingleton.ts. Unlike the IPTV singleton, this one degrades
// GRACEFULLY: if the file is missing (media-core not deployed / never
// scanned) or the open fails for any reason, mediaLibraryDb() returns
// null instead of throwing. Callers (the recommender availability tagger)
// treat null as "no local library available" and leave items untouched.
//
// IMPORT RULE: see the header note in mediaLibraryDb.ts — any future
// principal/JWE need must come from contractsBinding.ts (createRequire),
// never a bare `import * as '@emerald/contracts-napi'`.

import { env } from '../env.js'
import { openMediaLibraryDb, type MediaLibraryDb } from './mediaLibraryDb.js'

let cached: MediaLibraryDb | null = null
// Once we've failed to open (e.g. file absent), remember it so we don't
// re-stat the filesystem on every suggestions request.
let openFailed = false

export function mediaLibraryDb(): MediaLibraryDb | null {
  if (cached) return cached
  if (openFailed) return null
  try {
    cached = openMediaLibraryDb(env.MEDIA_DB_PATH)
    return cached
  } catch (err) {
    openFailed = true
    console.warn(
      `[mediaLibraryDb] media.db unavailable at ${env.MEDIA_DB_PATH}; local availability tagging disabled`,
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

export function closeMediaLibraryDb(): void {
  if (cached) {
    cached.close()
    cached = null
  }
  // Allow a subsequent mediaLibraryDb() to retry the open (e.g. after
  // media-core comes online and creates the file).
  openFailed = false
}
