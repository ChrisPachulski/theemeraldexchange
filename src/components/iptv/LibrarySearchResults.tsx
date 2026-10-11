import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { mediaApi, type PlayableKind } from '../../lib/api/media'
import { EPG_SEARCH_MIN_CHARS } from '../../lib/hooks/useIptvEpg'
import { useLimits } from '../../lib/hooks/useLimits'
import { useRatingGate } from '../../lib/hooks/usePolicy'
import { resumePosition, useMediaWatch } from '../../lib/hooks/useMediaLibrary'
import { EpisodePicker } from '../media/EpisodePicker'
import { MediaPlayer } from '../media/MediaPlayer'

// Apple's Live search also lists the local library (24 of each).
const LIBRARY_HITS = 24

// Library hits for the Live search box: the Apple Live -> Search "Library"
// sections, rating-capped like every browse surface. A movie plays in place (resuming); a show opens its episode list,
// the same flows as MoviesTab and TvTab.
export function LibrarySearchResults({ q }: { q: string }) {
  const limits = useLimits()
  const ratingGate = useRatingGate()
  const term = q.trim()
  const enabled = limits.data?.mediaEnabled !== false && term.length >= EPG_SEARCH_MIN_CHARS
  const movies = useQuery({
    queryKey: ['media', 'search', 'movies', term],
    queryFn: ({ signal }) => mediaApi.movies(term, { signal }),
    enabled,
    staleTime: 60_000,
  })
  const shows = useQuery({
    queryKey: ['media', 'search', 'shows', term],
    queryFn: ({ signal }) => mediaApi.shows(term, { signal }),
    enabled,
    staleTime: 60_000,
  })
  const watch = useMediaWatch(enabled)
  const [playing, setPlaying] = useState<{
    kind: PlayableKind
    id: number
    title: string
    startPositionSecs?: number
  } | null>(null)
  const [pickShow, setPickShow] = useState<{ id: number; title: string } | null>(null)

  const sections = [
    {
      label: 'Movies',
      hits: (movies.data?.items ?? [])
        .filter((m) => ratingGate.allows(m.contentRating))
        .slice(0, LIBRARY_HITS)
        .map((m) => ({
        key: `movie:${m.id}`,
        title: m.title,
        year: m.year,
        open: () =>
          setPlaying({
            kind: 'movie',
            id: m.id,
            title: m.title,
            startPositionSecs: resumePosition(watch.data?.get(`movie:${m.id}`)),
          }),
      })),
    },
    {
      label: 'TV Shows',
      hits: (shows.data?.items ?? [])
        .filter((s) => ratingGate.allows(s.contentRating))
        .slice(0, LIBRARY_HITS)
        .map((s) => ({
        key: `show:${s.id}`,
        title: s.title,
        year: s.year,
        open: () => setPickShow({ id: s.id, title: s.title }),
      })),
    },
  ]

  return (
    <>
      {enabled &&
        sections.map(
          ({ label, hits }) =>
            hits.length > 0 && (
              <section key={label} className="iptv-prog-results" aria-label={`Library ${label}`}>
                <h2 className="iptv-prog-results__head">
                  {label} <span className="iptv-prog-results__count">{hits.length}</span>
                </h2>
                <ul className="iptv-prog-results__list">
                  {hits.map((hit) => (
                    <li key={hit.key}>
                      <button type="button" className="iptv-prog-card iptv-prog-card--link" onClick={hit.open}>
                        <span className="iptv-prog-card__when">
                          Library
                          {hit.year != null && (
                            <>
                              {' '}
                              <span className="iptv-prog-card__sep" aria-hidden="true">--</span> {hit.year}
                            </>
                          )}
                        </span>
                        <span className="iptv-prog-card__title">{hit.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ),
        )}
      {pickShow && (
        <EpisodePicker
          showId={pickShow.id}
          showTitle={pickShow.title}
          onClose={() => setPickShow(null)}
          onPlay={(ep, label) => {
            setPickShow(null)
            setPlaying({
              kind: 'episode',
              id: ep.id,
              title: label,
              startPositionSecs: resumePosition(watch.data?.get(`episode:${ep.id}`)),
            })
          }}
        />
      )}
      {playing && (
        <MediaPlayer
          key={`${playing.kind}:${playing.id}`}
          kind={playing.kind}
          id={playing.id}
          title={playing.title}
          startPositionSecs={playing.startPositionSecs}
          onClose={() => setPlaying(null)}
        />
      )}
    </>
  )
}
