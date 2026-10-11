import { useQuery } from '@tanstack/react-query'
import { fetchPerson, fetchRelated, fetchVideos, type TmdbRef } from '../api/tmdb'

// TMDB extras for a title's detail and the player's end card. Cached for 24h
// like useCast: trailers, recommendations and filmographies barely move
// within a session.

const DAY_MS = 24 * 60 * 60 * 1000

export function useVideos(ref: TmdbRef | null) {
  return useQuery({
    queryKey: ['tmdb', 'videos', ref?.kind, ref?.id],
    queryFn: () => fetchVideos(ref as TmdbRef),
    enabled: ref != null && ref.id > 0,
    staleTime: DAY_MS,
  })
}

export function useRelated(ref: TmdbRef | null, enabled = true) {
  return useQuery({
    queryKey: ['tmdb', 'related', ref?.kind, ref?.id],
    queryFn: () => fetchRelated(ref as TmdbRef),
    enabled: enabled && ref != null && ref.id > 0,
    staleTime: DAY_MS,
  })
}

export function usePerson(personId: number | null) {
  return useQuery({
    queryKey: ['tmdb', 'person', personId],
    queryFn: () => fetchPerson(personId as number),
    enabled: personId != null,
    staleTime: DAY_MS,
  })
}
