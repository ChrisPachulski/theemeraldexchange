import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { SearchInput } from '../search/SearchInput'
import { ResultGrid } from '../search/ResultGrid'
import { MediaCard } from '../search/MediaCard'
import { ProgrammeResults } from '../iptv/ProgrammeResults'
import { MediaPlayer } from '../media/MediaPlayer'
import { mediaApi, type MediaShow } from '../../lib/api/media'
import { useDebounced } from '../../lib/hooks/useDebounced'
import { useLimits } from '../../lib/hooks/useLimits'
import { useRatingGate, useSectionAccess } from '../../lib/hooks/usePolicy'
import { useRadarrLibrary } from '../../lib/hooks/useRadarrLibrary'
import { useSonarrLibrary } from '../../lib/hooks/useSonarrLibrary'
import { useMovieSearch } from '../../lib/hooks/useMovieSearch'
import { useSeriesSearch } from '../../lib/hooks/useSeriesSearch'
import { useIptvLive } from '../../lib/hooks/useIptvLive'
import { EPG_SEARCH_MIN_CHARS } from '../../lib/hooks/useIptvEpg'
import { resumePosition, useMediaWatch } from '../../lib/hooks/useMediaLibrary'
import { pickPoster } from '../../lib/hooks/useRecentlyAdded'
import { openIntent } from '../../lib/router'
import { rankWords } from '../../lib/wordMatch'
import { stripArticle } from '../../lib/title'
import './SearchTab.css'

// Per-section caps, the Apple Search tab's.
const LIBRARY_HITS = 24
const EPISODE_HITS = 24
const CHANNEL_HITS = 24
const DISCOVER_HITS = 8
// The query survives a trip into a title or the Live tab and back.
const SAVED_QUERY = 'eex.search.q'

function savedQuery(): string {
  try {
    return sessionStorage.getItem(SAVED_QUERY) ?? ''
  } catch {
    return ''
  }
}

/** `items` that match `q`, the exact title first, then titles that start with
 *  it, then the rest, A-Z (article-stripped) within each. */
function ranked<T>(items: T[] | undefined, q: string, title: (t: T) => string): T[] {
  const hits: { item: T; rank: number }[] = []
  for (const item of items ?? []) {
    const rank = rankWords(title(item), q)
    if (rank !== null) hits.push({ item, rank })
  }
  return hits
    .sort((a, b) => a.rank - b.rank || stripArticle(title(a.item)).localeCompare(stripArticle(title(b.item))))
    .map((h) => h.item)
}

/** The app-wide search (Apple's Search tab): one query reaches the library's
 *  MOVIES and TV SHOWS, EPISODES by title, live CHANNELS and guide PROGRAMS,
 *  and titles NOT IN THE LIBRARY yet (Sonarr/Radarr lookup, opening the detail
 *  with Add). Matching is by words (lib/wordMatch), so "scooby-doo", "scooby
 *  doo" and "scoobydoo" all find "Scooby-Doo!". Titles open in their own tab's
 *  detail and channels tune in the Live tab; episodes play in place. */
export function SearchTab() {
  const [query, setQuery] = useState(savedQuery)
  const q = useDebounced(query.trim())
  useEffect(() => {
    try {
      sessionStorage.setItem(SAVED_QUERY, q)
    } catch {
      // Private mode: the query just doesn't survive the round trip.
    }
  }, [q])

  const limits = useLimits()
  const sections = useSectionAccess()
  const ratingGate = useRatingGate()
  const active = q.length >= EPG_SEARCH_MIN_CHARS
  const radarrOn = limits.data?.radarrEnabled !== false
  const sonarrOn = limits.data?.sonarrEnabled !== false
  const mediaOn = limits.data?.mediaEnabled !== false
  const liveOn = limits.data?.iptvEnabled !== false && sections.live
  // Members whose policy denies library management can't add (it 403s).
  const discoverOn = sections.arr

  const movieLibrary = useRadarrLibrary(radarrOn)
  const showLibrary = useSonarrLibrary(sonarrOn)
  const movies = useMemo(
    () =>
      active
        ? ranked(movieLibrary.data, q, (m) => m.title)
            .filter((m) => ratingGate.allows(m.certification))
            .slice(0, LIBRARY_HITS)
        : [],
    [active, movieLibrary.data, q, ratingGate],
  )
  const shows = useMemo(
    () =>
      active
        ? ranked(showLibrary.data, q, (s) => s.title)
            .filter((s) => ratingGate.allows(s.certification))
            .slice(0, LIBRARY_HITS)
        : [],
    [active, showLibrary.data, q, ratingGate],
  )

  // Episode rows carry only a show id; the shows index names them and carries
  // the rating the cap is checked against.
  const showIndex = useQuery({
    queryKey: ['media', 'shows', 'index'],
    queryFn: ({ signal }) => mediaApi.allShows({ signal }),
    staleTime: 60_000,
    enabled: mediaOn && active,
    select: (data): Map<number, MediaShow> => new Map(data.map((s) => [s.id, s])),
  })
  const episodeSearch = useQuery({
    queryKey: ['media', 'episodes', 'search', q],
    queryFn: ({ signal }) => mediaApi.searchEpisodes(q, EPISODE_HITS, { signal }),
    staleTime: 60_000,
    enabled: mediaOn && active,
  })
  const episodes = useMemo(
    () =>
      (episodeSearch.data?.items ?? []).flatMap((ep) => {
        const show = showIndex.data?.get(ep.showId)
        return show && ratingGate.allows(show.contentRating) ? [{ ep, show }] : []
      }),
    [episodeSearch.data, showIndex.data, ratingGate],
  )
  const watch = useMediaWatch(mediaOn && active)
  const [playing, setPlaying] = useState<{ id: number; title: string; startPositionSecs?: number } | null>(null)

  const channelSearch = useIptvLive({ q, limit: CHANNEL_HITS }, liveOn && active)
  const channels = active ? (channelSearch.data?.items ?? []) : []

  const movieLookup = useMovieSearch(q, discoverOn && radarrOn && active)
  const showLookup = useSeriesSearch(q, discoverOn && sonarrOn && active)
  const discover = useMemo(() => {
    if (!active) return []
    const haveMovie = new Set(movieLibrary.data?.map((m) => m.tmdbId))
    const haveShow = new Set(showLibrary.data?.map((s) => s.tvdbId))
    const movieHits = (movieLookup.data ?? [])
      .filter((m) => !haveMovie.has(m.tmdbId) && ratingGate.allows(m.certification))
      .slice(0, DISCOVER_HITS)
      .map((m) => ({
        key: `movie:${m.tmdbId}`,
        title: m.title,
        year: m.year,
        kind: 'Movie',
        poster: m.remotePoster || pickPoster(m.images),
        open: () => openIntent('movies', `tmdb:${m.tmdbId}`),
      }))
    const showHits = (showLookup.data ?? [])
      .filter((s) => !haveShow.has(s.tvdbId) && ratingGate.allows(s.certification))
      .slice(0, DISCOVER_HITS)
      .map((s) => ({
        key: `show:${s.tvdbId}`,
        title: s.title,
        year: s.year,
        kind: 'TV show',
        poster: s.remotePoster || pickPoster(s.images),
        open: () => openIntent('tv', `tvdb:${s.tvdbId}`),
      }))
    return [...movieHits, ...showHits]
  }, [active, movieLibrary.data, showLibrary.data, movieLookup.data, showLookup.data, ratingGate])

  // Programs run inside ProgrammeResults, which reports back for the empty state.
  const [programmes, setProgrammes] = useState<number | null>(0)
  const searching =
    (liveOn && programmes === null) ||
    [movieLibrary, showLibrary, episodeSearch, channelSearch, movieLookup, showLookup].some((r) => r.isFetching)
  const found =
    movies.length + shows.length + episodes.length + channels.length + (programmes ?? 0) + discover.length > 0

  return (
    <section className="search-tab" aria-label="Search">
      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder={liveOn ? 'Movies, shows, episodes & channels' : 'Movies, shows & episodes'}
        ariaLabel="Search everything"
        autoFocus
      />
      <div className="search-tab__results" aria-busy={searching || undefined}>
        {!active && (
          <p className="search-tab__hint">
            {liveOn
              ? 'Search your library’s movies, TV shows and episodes, live channels and programs, and titles to add.'
              : 'Search your library’s movies, TV shows and episodes, and titles to add.'}
          </p>
        )}

        {movies.length > 0 && (
          <SearchSection label="Movies" count={movies.length}>
            <ResultGrid>
              {movies.map((m) => (
                <MediaCard
                  key={m.id}
                  poster={pickPoster(m.images)}
                  title={m.title}
                  year={m.year}
                  meta={m.certification}
                  onClick={() => openIntent('movies', m.id)}
                />
              ))}
            </ResultGrid>
          </SearchSection>
        )}

        {shows.length > 0 && (
          <SearchSection label="TV Shows" count={shows.length}>
            <ResultGrid>
              {shows.map((s) => (
                <MediaCard
                  key={s.id}
                  poster={pickPoster(s.images)}
                  title={s.title}
                  year={s.year}
                  meta={s.network}
                  onClick={() => openIntent('tv', s.id)}
                />
              ))}
            </ResultGrid>
          </SearchSection>
        )}

        {episodes.length > 0 && (
          <SearchSection label="Episodes" count={episodes.length}>
            <ul className="iptv-prog-results__list">
              {episodes.map(({ ep, show }) => {
                const where = `S${ep.season} E${ep.episode}`
                const title = ep.title ?? where
                return (
                  <li key={ep.id}>
                    <button
                      type="button"
                      className="iptv-prog-card iptv-prog-card--link"
                      onClick={() =>
                        setPlaying({
                          id: ep.id,
                          title: `${show.title}: ${title}`,
                          startPositionSecs: resumePosition(watch.data?.get(`episode:${ep.id}`)),
                        })
                      }
                    >
                      <span className="iptv-prog-card__when">
                        {show.title} <span className="iptv-prog-card__sep" aria-hidden="true">--</span> {where}
                      </span>
                      <span className="iptv-prog-card__title">{title}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </SearchSection>
        )}

        {channels.length > 0 && (
          <SearchSection
            label="Channels"
            count={channels.length}
            of={channelSearch.data?.total}
          >
            <ul className="iptv-prog-results__list">
              {channels.map((c) => (
                <li key={c.stream_id}>
                  <button
                    type="button"
                    className="iptv-prog-card iptv-prog-card--link"
                    onClick={() => openIntent('live', c.stream_id)}
                    aria-label={`Watch ${c.name} live`}
                  >
                    <span className="iptv-prog-card__when">
                      Channel {c.num}
                      {c.tv_archive === 1 && (
                        <>
                          {' '}
                          <span className="iptv-prog-card__sep" aria-hidden="true">--</span> Catch-up
                        </>
                      )}
                    </span>
                    <span className="iptv-prog-card__title">{c.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </SearchSection>
        )}

        {liveOn && active && (
          <ProgrammeResults
            q={q}
            onPlayLive={(hit) => openIntent('live', hit.streamId)}
            onShowInGuide={(hit) =>
              openIntent('live', `guide:${hit.streamId}:${Date.parse(hit.programme.start_utc) / 1000}`)
            }
            onHits={setProgrammes}
          />
        )}

        {discover.length > 0 && (
          <SearchSection label="Not in your library" count={discover.length}>
            <ResultGrid>
              {discover.map((d) => (
                <MediaCard
                  key={d.key}
                  poster={d.poster}
                  title={d.title}
                  year={d.year}
                  meta={d.kind}
                  onClick={d.open}
                />
              ))}
            </ResultGrid>
          </SearchSection>
        )}

        {active && !searching && !found && (
          <p className="search-tab__hint">No results for “{q}”.</p>
        )}
      </div>

      {playing && (
        <MediaPlayer
          key={playing.id}
          kind="episode"
          id={playing.id}
          title={playing.title}
          startPositionSecs={playing.startPositionSecs}
          onClose={() => setPlaying(null)}
        />
      )}
    </section>
  )
}

function SearchSection({
  label,
  count,
  of,
  children,
}: {
  label: string
  count: number
  of?: number
  children: React.ReactNode
}) {
  return (
    <section className="search-tab__section" aria-label={label}>
      <h2 className="iptv-prog-results__head">
        {label}{' '}
        <span className="iptv-prog-results__count">
          {count}
          {of != null && of > count ? ` of ${of}` : ''}
        </span>
      </h2>
      {children}
    </section>
  )
}
