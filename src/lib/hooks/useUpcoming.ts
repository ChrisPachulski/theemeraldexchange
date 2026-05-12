import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { sonarr } from '../api/sonarr'
import { radarr } from '../api/radarr'

// Upcoming releases — episodes airing soon (Sonarr) and movies hitting
// their earliest meaningful release date (Radarr). Surfaces on the
// Downloads tab so the household can see what's queued up by date
// even when nothing's actively grabbing.

export type UpcomingItem = {
  /** Stable key, unique across kinds. */
  key: string
  kind: 'tv' | 'movie'
  title: string
  /** ISO timestamp that will be sorted on and shown as a relative date. */
  airAt: string
  /** TV-only — episode label like "S02E07". */
  episodeLabel?: string
  /** Movie-only — which release this represents (digital/physical/cinema). */
  releaseLabel?: string
  poster?: string
  /** Tab to jump to when the card is clicked. */
  route: 'tv' | 'movies'
  /** Sonarr seriesId or Radarr movieId. */
  id: number
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function pickPoster(images: Array<{ coverType: string; remoteUrl?: string; url?: string }> | undefined) {
  const img = images?.find((i) => i.coverType === 'poster')
  return img?.remoteUrl ?? img?.url
}

function pad2(n: number) {
  return n < 10 ? `0${n}` : String(n)
}

// Cap each side at this many — the strip is meant to be a glance, not
// an exhaustive list. Sonarr will happily return 200+ episodes if a
// long-running show has full season blocks airing.
const PER_SIDE_CAP = 24

export function useUpcoming(windowDays = 21, limit = 16) {
  const { start, end } = useMemo(() => {
    const now = new Date()
    const future = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000)
    return { start: isoDate(now), end: isoDate(future) }
  }, [windowDays])

  const tv = useQuery({
    queryKey: ['sonarr', 'calendar', start, end],
    queryFn: () => sonarr.calendar(start, end),
    staleTime: 10 * 60 * 1000,
  })
  const movies = useQuery({
    queryKey: ['radarr', 'calendar', start, end],
    queryFn: () => radarr.calendar(start, end),
    staleTime: 10 * 60 * 1000,
  })

  return useMemo(() => {
    const items: UpcomingItem[] = []
    const nowMs = Date.now()

    for (const ep of tv.data ?? []) {
      if (!ep.airDateUtc) continue
      // Skip episodes already on disk — they're not "upcoming" in any
      // useful sense even if Sonarr returns them in the window.
      if (ep.hasFile) continue
      const t = new Date(ep.airDateUtc).getTime()
      if (!Number.isFinite(t) || t < nowMs) continue
      items.push({
        key: `tv:${ep.id}`,
        kind: 'tv',
        title: ep.series?.title ?? ep.title,
        airAt: ep.airDateUtc,
        episodeLabel: `S${pad2(ep.seasonNumber)}E${pad2(ep.episodeNumber)}`,
        poster: pickPoster(ep.series?.images),
        route: 'tv',
        id: ep.series?.id ?? ep.seriesId,
      })
    }

    for (const m of movies.data ?? []) {
      // Pick the earliest release date that's in the future. Radarr
      // returns the movie if any of its release dates fall in the
      // window, but we want to surface the one the user will actually
      // experience first (digital often beats physical, cinema is
      // earliest for theatrical releases).
      const candidates: Array<{ at: string; label: string }> = []
      if (m.digitalRelease) candidates.push({ at: m.digitalRelease, label: 'Digital' })
      if (m.physicalRelease) candidates.push({ at: m.physicalRelease, label: 'Physical' })
      if (m.inCinemas) candidates.push({ at: m.inCinemas, label: 'In cinemas' })
      const future = candidates
        .map((c) => ({ ...c, ms: new Date(c.at).getTime() }))
        .filter((c) => Number.isFinite(c.ms) && c.ms >= nowMs)
        .sort((a, b) => a.ms - b.ms)
      const next = future[0]
      if (!next) continue
      items.push({
        key: `movie:${m.id}`,
        kind: 'movie',
        title: m.title,
        airAt: next.at,
        releaseLabel: next.label,
        poster: pickPoster(m.images),
        route: 'movies',
        id: m.id,
      })
    }

    // Cap per-side BEFORE merging — otherwise a deluge of TV episodes
    // could push every movie off the strip.
    const tvSlice = items.filter((i) => i.kind === 'tv').slice(0, PER_SIDE_CAP)
    const movieSlice = items.filter((i) => i.kind === 'movie').slice(0, PER_SIDE_CAP)

    return [...tvSlice, ...movieSlice]
      .sort((a, b) => new Date(a.airAt).getTime() - new Date(b.airAt).getTime())
      .slice(0, limit)
  }, [tv.data, movies.data, limit])
}
