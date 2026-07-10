import type Database from 'better-sqlite3'
import { crossedWatchThreshold, type WatchPoint } from './watchSignal.js'

type WatchBody = {
  media_kind?: unknown
  media_id?: unknown
  position_secs?: unknown
  duration_secs?: unknown
  completed?: unknown
}

export type LocalWatchedSignal = {
  kind: 'movie' | 'tv'
  tmdbId: number
}

/** Resolve a successful media-core watch upsert into one idempotent
 * recommender signal. The read happens before the proxy write so the 40%
 * transition is observable; callers emit only after media-core returns 2xx. */
export function resolveLocalWatchedSignal(
  db: Database.Database | null,
  sub: string,
  body: unknown,
): LocalWatchedSignal | null {
  if (!db || !body || typeof body !== 'object') return null
  const value = body as WatchBody
  const mediaId = value.media_id
  if (!Number.isSafeInteger(mediaId) || (mediaId as number) <= 0) return null
  if (value.media_kind !== 'movie' && value.media_kind !== 'episode') return null

  const position = Number(value.position_secs ?? 0)
  const duration = value.duration_secs == null ? null : Number(value.duration_secs)
  if (!Number.isFinite(position) || (duration !== null && !Number.isFinite(duration))) return null
  const now: WatchPoint = {
    position_secs: Math.max(0, Math.floor(position)),
    duration_secs: duration === null ? null : Math.max(0, Math.floor(duration)),
    completed: value.completed ? 1 : 0,
  }

  const identitySql =
    value.media_kind === 'movie'
      ? `SELECT m.tmdb_id,
                w.position_secs, w.duration_secs, w.completed
           FROM movies m
           LEFT JOIN media_watch_state w
             ON w.sub = ? AND w.media_kind = 'movie' AND w.media_id = m.id
          WHERE m.id = ?`
      : `SELECT s.tmdb_id,
                w.position_secs, w.duration_secs, w.completed
           FROM episodes e
           JOIN shows s ON s.id = e.show_id
           LEFT JOIN media_watch_state w
             ON w.sub = ? AND w.media_kind = 'episode' AND w.media_id = e.id
          WHERE e.id = ?`
  const row = db.prepare(identitySql).get(sub, mediaId) as
    | {
        tmdb_id: number | null
        position_secs: number | null
        duration_secs: number | null
        completed: number | null
      }
    | undefined
  if (!row || !Number.isSafeInteger(row.tmdb_id) || (row.tmdb_id as number) <= 0) return null
  const prior: WatchPoint | undefined =
    row.position_secs === null
      ? undefined
      : {
          position_secs: row.position_secs,
          duration_secs: row.duration_secs,
          completed: row.completed ?? 0,
        }
  if (!crossedWatchThreshold(prior, now)) return null
  return { kind: value.media_kind === 'movie' ? 'movie' : 'tv', tmdbId: row.tmdb_id as number }
}
