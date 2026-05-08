import { useQuery } from '@tanstack/react-query'
import { radarr } from '../api/radarr'

export function useRadarrLibrary() {
  return useQuery({
    queryKey: ['radarr', 'movie'],
    queryFn: radarr.movies,
    staleTime: 60_000,
  })
}

export function useRadarrProfiles() {
  return useQuery({
    queryKey: ['radarr', 'qualityprofile'],
    queryFn: radarr.qualityProfiles,
    staleTime: 5 * 60_000,
  })
}

export function useRadarrRootFolders() {
  return useQuery({
    queryKey: ['radarr', 'rootfolder'],
    queryFn: radarr.rootFolders,
    staleTime: 5 * 60_000,
  })
}
