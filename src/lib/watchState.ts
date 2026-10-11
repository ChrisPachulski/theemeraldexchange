import type { MediaEpisode, WatchEntry } from './api/media'
import { formatPlaybackTime } from '../components/media/playbackSession'

// Watch-state selectors for the library posters and detail screens (Apple
// MediaLibraryStore.watchProgress + SeriesPlaybackSummary parity).

/** Watched fraction 0..1; 0 when the duration is unknown. */
export function watchFraction(row: WatchEntry | undefined): number {
  return row?.durationSecs ? Math.min(1, row.positionSecs / row.durationSecs) : 0
}

/** Poster/row overlay: a Watched mark once completed, else a resume bar while
 *  in progress (Apple hides bars under 1%). */
export function watchBadge(row: WatchEntry | undefined): { watched: boolean; progress: number | null } {
  const fraction = watchFraction(row)
  return {
    watched: row?.completed === true,
    progress: row && !row.completed && fraction > 0.01 ? fraction : null,
  }
}

/** Movie Play label: "Resume · 42 min left" when the duration is known (Plex
 *  captions time remaining), "Resume 12:34" when it isn't, else undefined (the
 *  caller's default). */
export function resumeLabel(row: WatchEntry | undefined): string | undefined {
  if (!row || row.completed || row.positionSecs <= 0) return undefined
  if (row.durationSecs && watchFraction(row) > 0.01) {
    const left = Math.floor((row.durationSecs - row.positionSecs) / 60)
    if (left > 0) return `Resume · ${left} min left`
  }
  return `Resume ${formatPlaybackTime(row.positionSecs)}`
}

export type SeriesPlayback = {
  /** The latest unfinished episode in (season, episode) order, else the first. */
  target: MediaEpisode | null
  isResume: boolean
  /** Season the browser opens on: the resume target's, else the last-watched
   *  one, else the first downloaded. null when nothing is downloaded. */
  defaultSeason: number | null
}

/** One-tap series play target + default season from the show's local
 *  episodes and the watch map (keyed `kind:id`). Specials (season 0) are
 *  never the target, as on Apple. */
export function seriesPlayback(
  episodes: ReadonlyArray<MediaEpisode>,
  watch: ReadonlyMap<string, WatchEntry> | undefined,
): SeriesPlayback {
  const ordered = episodes
    .filter((e) => e.season > 0)
    .sort((a, b) => a.season - b.season || a.episode - b.episode || a.id - b.id)
  const rowFor = (e: MediaEpisode) => watch?.get(`episode:${e.id}`)
  const unfinished = ordered.filter((e) => {
    const r = rowFor(e)
    return r != null && !r.completed && r.positionSecs > 0
  })
  const target = unfinished[unfinished.length - 1] ?? ordered[0] ?? null
  const isResume = unfinished.length > 0
  let lastWatched: MediaEpisode | null = null
  for (const e of ordered) {
    const at = rowFor(e)?.watchedAt
    if (at && (!lastWatched || at > (rowFor(lastWatched)?.watchedAt ?? ''))) lastWatched = e
  }
  return {
    target,
    isResume,
    defaultSeason: isResume && target ? target.season : (lastWatched?.season ?? target?.season ?? null),
  }
}
