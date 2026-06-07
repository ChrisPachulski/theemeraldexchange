import { useCallback, useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { mediaApi, type PlayableKind } from '../api/media'

// Locally-available movies from media-core. Mirrors useRadarrLibrary's
// staleTime so a tab revisit doesn't refetch within the minute.
export function useMediaMovies(q?: string) {
  return useQuery({
    queryKey: ['media', 'movies', q ?? ''],
    queryFn: () => mediaApi.movies(q),
    staleTime: 60_000,
  })
}

export function useMediaShows(q?: string) {
  return useQuery({
    queryKey: ['media', 'shows', q ?? ''],
    queryFn: () => mediaApi.shows(q),
    staleTime: 60_000,
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

// Admin-only trigger for a background library re-scan. Invalidates the
// whole ['media'] subtree so movies/shows refetch once the scan lands.
export function useMediaScan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => mediaApi.scan(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['media'] }),
  })
}

// The current user's watch-progress rows, used to resume playback and badge
// in-progress titles. Short staleTime: a just-watched title should reflect new
// progress on a tab revisit, but we don't need to refetch mid-render.
export function useWatchState() {
  return useQuery({
    queryKey: ['media', 'watch'],
    queryFn: ({ signal }) => mediaApi.watch({ signal }),
    staleTime: 30_000,
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
