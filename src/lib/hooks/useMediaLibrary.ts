import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { mediaApi } from '../api/media'

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

// Admin-only trigger for a background library re-scan. Invalidates the
// whole ['media'] subtree so movies/shows refetch once the scan lands.
export function useMediaScan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => mediaApi.scan(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['media'] }),
  })
}
