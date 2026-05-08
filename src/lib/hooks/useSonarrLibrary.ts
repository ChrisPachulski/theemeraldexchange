import { useQuery } from '@tanstack/react-query'
import { sonarr } from '../api/sonarr'

export function useSonarrLibrary() {
  return useQuery({
    queryKey: ['sonarr', 'series'],
    queryFn: sonarr.series,
    staleTime: 60_000,
  })
}

export function useSonarrProfiles() {
  return useQuery({
    queryKey: ['sonarr', 'qualityprofile'],
    queryFn: sonarr.qualityProfiles,
    staleTime: 5 * 60_000,
  })
}

export function useSonarrRootFolders() {
  return useQuery({
    queryKey: ['sonarr', 'rootfolder'],
    queryFn: sonarr.rootFolders,
    staleTime: 5 * 60_000,
  })
}
