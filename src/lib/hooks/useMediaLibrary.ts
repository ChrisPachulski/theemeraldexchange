import { useCallback, useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { mediaApi, type PlayableKind } from '../api/media'

// tmdbId -> local media-core movie id, for matching a discover/Radarr title to
// a locally-available file (powers the DetailModal "Play Direct here" button).
// `enabled` gates it on mediaEnabled so deployments without media-core don't
// fire a 404. Uses allMovies (paged past the 50/200 list cap) so the index
// covers the WHOLE library — calling /movies with no limit only returned the
// first 50, so Play Direct silently vanished for every title past that page.
export function useLocalMovieIndex(enabled: boolean) {
  return useQuery({
    queryKey: ['media', 'movies', 'index'],
    queryFn: ({ signal }) => mediaApi.allMovies({ signal }),
    staleTime: 60_000,
    enabled,
    select: (data): Map<number, number> => {
      const m = new Map<number, number>()
      for (const mv of data) if (mv.tmdbId) m.set(mv.tmdbId, mv.id)
      return m
    },
  })
}

// tmdbId -> local media-core show id, for matching a discover/Sonarr show to a
// locally-available one (powers the show DetailModal "Watch episodes" button).
// Paged (allShows) for the same whole-library reason as useLocalMovieIndex.
export function useLocalShowIndex(enabled: boolean) {
  return useQuery({
    queryKey: ['media', 'shows', 'index'],
    queryFn: ({ signal }) => mediaApi.allShows({ signal }),
    staleTime: 60_000,
    enabled,
    select: (data): Map<number, number> => {
      const m = new Map<number, number>()
      for (const s of data) if (s.tmdbId) m.set(s.tmdbId, s.id)
      return m
    },
  })
}

// Episodes for one show, fetched lazily when an episode picker opens.
export function useMediaEpisodes(showId: number | null) {
  return useQuery({
    queryKey: ['media', 'episodes', showId ?? -1],
    queryFn: ({ signal }) => mediaApi.episodes(showId as number, { signal }),
    enabled: showId != null,
    staleTime: 60_000,
  })
}

// Throttled watch-progress reporter, mirroring useReportPosition (IPTV). The
// player calls the returned fn on every <video> timeupdate (~4×/s); we persist
// at most every 10s, except when `force` is set (pause / ended / player close)
// so the final resume point is always accurate.
const WATCH_REPORT_INTERVAL_MS = 10_000

export function useReportWatch(kind: PlayableKind, id: number) {
  const qc = useQueryClient()
  const lastReportTs = useRef(0)
  const { mutate } = useMutation({
    mutationFn: (input: {
      kind: PlayableKind
      id: number
      positionSecs: number
      durationSecs?: number | null
      completed?: boolean
    }) => mediaApi.saveWatch(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['media', 'watch'] }),
  })

  useEffect(() => {
    lastReportTs.current = 0
  }, [kind, id])

  return useCallback(
    (
      positionSecs: number,
      durationSecs?: number | null,
      completed?: boolean,
      force = false,
    ) => {
      const now = Date.now()
      if (!force && now - lastReportTs.current < WATCH_REPORT_INTERVAL_MS) return
      lastReportTs.current = now
      mutate({ kind, id, positionSecs, durationSecs, completed })
    },
    [kind, id, mutate],
  )
}
