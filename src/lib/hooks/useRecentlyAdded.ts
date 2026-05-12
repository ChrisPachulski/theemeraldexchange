import { useMemo } from 'react'
import { useSonarrLibrary } from './useSonarrLibrary'
import { useRadarrLibrary } from './useRadarrLibrary'

// Last-N most recently added items across Sonarr + Radarr, merged
// and sorted by Sonarr/Radarr's `added` timestamp. Used by the Home
// page to surface "what's new in the library" without making the
// user navigate to a tab.

export type RecentItem = {
  /** Stable key, unique across kinds. */
  key: string
  kind: 'tv' | 'movie'
  title: string
  year?: number
  added: string
  poster?: string
  /** Click target — opens the right tab and modal. */
  route: 'tv' | 'movies'
  /** Sonarr seriesId or Radarr movieId. Used to drive a tab+modal jump. */
  id: number
}

function pickPoster(images: Array<{ coverType: string; remoteUrl?: string; url?: string }> | undefined) {
  const img = images?.find((i) => i.coverType === 'poster')
  return img?.remoteUrl ?? img?.url
}

export function useRecentlyAdded(limit = 12) {
  const tv = useSonarrLibrary()
  const movies = useRadarrLibrary()
  return useMemo(() => {
    const items: RecentItem[] = []
    for (const s of tv.data ?? []) {
      if (!s.added) continue
      items.push({
        key: `tv:${s.id}`,
        kind: 'tv',
        title: s.title,
        year: s.year,
        added: s.added,
        poster: pickPoster(s.images),
        route: 'tv',
        id: s.id,
      })
    }
    for (const m of movies.data ?? []) {
      if (!m.added) continue
      items.push({
        key: `movie:${m.id}`,
        kind: 'movie',
        title: m.title,
        year: m.year,
        added: m.added,
        poster: pickPoster(m.images),
        route: 'movies',
        id: m.id,
      })
    }
    return items
      .filter((i) => {
        const t = new Date(i.added).getTime()
        return Number.isFinite(t) && t > 0
      })
      .sort((a, b) => new Date(b.added).getTime() - new Date(a.added).getTime())
      .slice(0, limit)
  }, [tv.data, movies.data, limit])
}
