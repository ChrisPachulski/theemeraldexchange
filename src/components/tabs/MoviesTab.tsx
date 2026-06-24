import { useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { SearchInput } from '../search/SearchInput'
import { ResultGrid } from '../search/ResultGrid'
import { MediaCard } from '../search/MediaCard'
import { ModeToggle, type Mode } from '../search/ModeToggle'
import { LibraryAlphabet, libraryBucket, type LibraryLetter } from '../library/LibraryAlphabet'
import { LibraryFilters, type FilterOption } from '../library/LibraryFilters'
import { DetailModal, type DetailMeta } from '../detail/DetailModal'
import { ArrAdvancedPanel } from '../detail/ArrAdvancedPanel'
import { AddMovieModal } from '../add/AddMovieModal'
import { Toast } from '../toast/Toast'
import { LoadingPulse } from '../feedback/LoadingPulse'
import { EmeraldMark } from '../atmosphere/EmeraldMark'
import { useAuth } from '../../lib/auth'
import { useDebounced } from '../../lib/hooks/useDebounced'
import { useMovieSearch } from '../../lib/hooks/useMovieSearch'
import { useRadarrLibrary, useRadarrProfiles, useRadarrRootFolders } from '../../lib/hooks/useRadarrLibrary'
import { useSuggestionStrip } from '../../lib/hooks/useSuggestionStrip'
import { useLimits } from '../../lib/hooks/useLimits'
import { usePlexLinks } from '../../lib/hooks/usePlexLinks'
import { resumePosition, useLocalMovieIndex, useMediaWatch } from '../../lib/hooks/useMediaLibrary'
import { MediaPlayer } from '../media/MediaPlayer'
import { TrendingRow } from '../search/TrendingRow'
import { useCast } from '../../lib/hooks/useCast'
import { useConfirm } from '../confirm/useConfirm'
import { movieAvailability, radarr, type Movie, type MovieSearchResult } from '../../lib/api/radarr'
import { postClickEvent } from '../../lib/api/recommenderEvents'
import {
  filterAndSortLibrary,
  byTitleAsc,
  byTitleDesc,
  byYearAsc,
  byYearDesc,
} from '../../lib/librarySort'
import { withViewTransition } from '../../lib/viewTransition'
import { pickDefaultProfileId } from '../../lib/pickDefaultProfileId'
import './TvTab.css'

function pickSearchPoster(item: MovieSearchResult): string | undefined {
  if (item.remotePoster) return item.remotePoster
  const img = item.images?.find((i) => i.coverType === 'poster')
  return img?.remoteUrl ?? img?.url
}

function pickLibraryPoster(item: Movie): string | undefined {
  const img = item.images?.find((i) => i.coverType === 'poster')
  return img?.remoteUrl ?? img?.url
}

function fmtRuntime(min?: number) {
  if (!min) return undefined
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function pickFanart(item: MovieSearchResult | Movie): string | undefined {
  const img = item.images?.find((i) => i.coverType === 'fanart')
  return img?.remoteUrl ?? img?.url
}

function buildMovieMeta(item: MovieSearchResult | Movie): DetailMeta[] {
  const rows: DetailMeta[] = []
  if (item.studio) rows.push({ label: 'Studio', value: item.studio })
  if (item.status) rows.push({ label: 'Status', value: item.status })
  if (item.runtime) rows.push({ label: 'Runtime', value: fmtRuntime(item.runtime) ?? `${item.runtime}m` })
  if (item.certification) rows.push({ label: 'Rated', value: item.certification })
  if (item.originalTitle && item.originalTitle !== item.title) {
    rows.push({ label: 'Original title', value: item.originalTitle })
  }
  for (const [label, raw] of [
    ['In cinemas', item.inCinemas],
    ['Digital release', item.digitalRelease],
    ['Physical release', item.physicalRelease],
  ] as const) {
    if (raw) {
      const d = new Date(raw)
      if (!isNaN(d.getTime())) {
        rows.push({ label, value: d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) })
      }
    }
  }
  if (item.collection?.title) rows.push({ label: 'Collection', value: item.collection.title })
  return rows
}

function fmtMovieRating(item: MovieSearchResult): string | undefined {
  const pieces: string[] = []
  const r = item.ratings
  if (r?.imdb?.value) pieces.push(`${r.imdb.value.toFixed(1)} IMDb`)
  if (r?.tmdb?.value) pieces.push(`${r.tmdb.value.toFixed(1)} TMDB`)
  if (r?.rottenTomatoes?.value) pieces.push(`${r.rottenTomatoes.value}% RT`)
  return pieces.length ? pieces.join(' · ') : undefined
}

type MovieSort = 'title-asc' | 'title-desc' | 'year-desc' | 'year-asc' | 'runtime-desc' | 'runtime-asc' | 'studio'
type MovieStatus = 'all' | 'released' | 'announced' | 'inCinemas' | 'tba'

const MOVIE_COMPARATORS: Record<MovieSort, (a: Movie, b: Movie) => number> = {
  'title-asc': byTitleAsc,
  'title-desc': byTitleDesc,
  'year-desc': byYearDesc,
  'year-asc': byYearAsc,
  'runtime-desc': (a, b) => (b.runtime ?? 0) - (a.runtime ?? 0) || byTitleAsc(a, b),
  'runtime-asc': (a, b) => (a.runtime ?? 0) - (b.runtime ?? 0) || byTitleAsc(a, b),
  studio: (a, b) =>
    (a.studio ?? '~').localeCompare(b.studio ?? '~') || byTitleAsc(a, b),
}

const MOVIE_SORT_OPTIONS: ReadonlyArray<FilterOption<MovieSort>> = [
  { value: 'title-asc',    label: 'Title (A–Z)' },
  { value: 'title-desc',   label: 'Title (Z–A)' },
  { value: 'year-desc',    label: 'Year (newest)' },
  { value: 'year-asc',     label: 'Year (oldest)' },
  { value: 'runtime-desc', label: 'Runtime (longest)' },
  { value: 'runtime-asc',  label: 'Runtime (shortest)' },
  { value: 'studio',       label: 'Studio' },
]

const MOVIE_STATUS_OPTIONS: ReadonlyArray<FilterOption<MovieStatus>> = [
  { value: 'all',       label: 'All status' },
  { value: 'released',  label: 'Released' },
  { value: 'inCinemas', label: 'In cinemas' },
  { value: 'announced', label: 'Announced' },
  { value: 'tba',       label: 'TBA' },
]

export function MoviesTab() {
  const [mode, setMode] = useState<Mode>('discover')
  const [query, setQuery] = useState('')
  const [letter, setLetter] = useState<LibraryLetter>('all')
  const [sort, setSort] = useState<MovieSort>('title-asc')
  const [status, setStatus] = useState<MovieStatus>('all')
  const debouncedQuery = useDebounced(query, 300)
  const search = useMovieSearch(mode === 'discover' ? debouncedQuery : '')
  const library = useRadarrLibrary()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const { isAdmin } = useAuth()
  const { linkFor: plexLinkFor } = usePlexLinks()

  const [adding, setAdding] = useState<MovieSearchResult | null>(null)
  const [viewing, setViewing] = useState<MovieSearchResult | Movie | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  // Find-release flow: a title added transiently (monitored, auto-grab off)
  // purely so the interactive release browser can open on it. If the admin
  // closes the modal without grabbing, we remove it again so nothing is left
  // behind. `transient` holds the just-added movie id; `grabbed` commits it.
  const [transient, setTransient] = useState<{ id: number } | null>(null)
  const grabbedRef = useRef(false)
  // Profile + root folder for the transient add body (same source the Add
  // modal uses), loaded only when admin so non-admins pay nothing.
  const radarrProfiles = useRadarrProfiles()
  const radarrFolders = useRadarrRootFolders()
  // In-browser playback of a locally-available title (media-core).
  const [playingLocal, setPlayingLocal] = useState<{
    id: number
    title: string
    startPositionSecs?: number
  } | null>(null)

  const cast = useCast({
    type: 'movie',
    tmdbId: viewing?.tmdbId ?? 0,
    enabled: viewing !== null,
  })

  const libraryByTmdb = useMemo(() => {
    const map = new Map<number, Movie>()
    library.data?.forEach((m) => map.set(m.tmdbId, m))
    return map
  }, [library.data])

  const limits = useLimits()
  // Match the viewed title to a locally-available file so the detail modal can
  // offer in-browser playback. Gated on mediaEnabled (no media-core → no fetch).
  const mediaEnabled = limits.data?.mediaEnabled !== false
  const localMovieIdx = useLocalMovieIndex(mediaEnabled)
  const mediaWatch = useMediaWatch(mediaEnabled)
  const localMovieId =
    viewing && typeof viewing.tmdbId === 'number'
      ? localMovieIdx.data?.get(viewing.tmdbId)
      : undefined
  // Whether the viewed IN-LIBRARY movie has anything to play at all. An
  // announced/unreleased title is tracked by Radarr with no file — every
  // play affordance must give way to an availability note for it.
  const viewingAvailability =
    viewing && 'id' in viewing ? movieAvailability(viewing) : 'playable'
  const [trendingPending, setTrendingPending] = useState<number | null>(null)
  // All strip orchestration (personalization gating, mode toggle, library
  // filtering, feedback dots, refresh, labels — and the owner-mandated
  // never-auto-refresh-on-like rule) lives in useSuggestionStrip, shared
  // with TvTab. Only the pick flow below stays tab-specific.
  const libraryTmdbIds = useMemo(
    () => new Set(libraryByTmdb.keys()),
    [libraryByTmdb],
  )
  const strip = useSuggestionStrip('movie', libraryTmdbIds)
  const suggested = strip.suggested
  // Trending shows TMDB items; clicking one resolves through Radarr's
  // lookup (it accepts tmdb:NNN) so the same DetailModal flow handles
  // it as a regular search result.
  const handleTrendingPick = async (tmdbId: number) => {
    // Mirror the click to the recommender as a conversion signal.
    // Outcome attribution in the sidecar ties it back to the most
    // recent rec_log row for the same (sub, kind, tmdb_id) — so for
    // suggestion-strip clicks the optimizer sees real engagement
    // (not just dot feedback). For pure-trending strips the rec_log
    // lookup misses and the event is silently dropped sidecar-side,
    // which is the correct behavior (we don't want to attribute a
    // click to a recommendation that was never made).
    postClickEvent('movie', tmdbId)
    setTrendingPending(tmdbId)
    try {
      const inLib = libraryByTmdb.get(tmdbId)
      if (inLib) {
        setViewing(inLib)
        return
      }
      const results = await radarr.lookup(`tmdb:${tmdbId}`)
      if (results[0]) setViewing(results[0])
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e))
    } finally {
      setTrendingPending(null)
    }
  }

  const textFilteredLibrary = useMemo(
    () => filterAndSortLibrary(library.data, { query, status, comparator: MOVIE_COMPARATORS[sort] }),
    [library.data, query, status, sort],
  )

  const availableLetters = useMemo(
    () => new Set(textFilteredLibrary.map((m) => libraryBucket(m.title))),
    [textFilteredLibrary],
  )

  const filteredLibrary = useMemo(() => {
    if (letter === 'all') return textFilteredLibrary
    return textFilteredLibrary.filter((m) => libraryBucket(m.title) === letter)
  }, [textFilteredLibrary, letter])

  const removeMutation = useMutation({
    mutationFn: ({ id, deleteFiles }: { id: number; deleteFiles: boolean }) =>
      radarr.removeMovie(id, deleteFiles),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['radarr', 'movie'] }),
  })

  // Find-release: add the title monitored with auto-grab OFF so the release
  // endpoint (which requires the movie to exist) has a real movieId to query,
  // then view the returned Movie so the Advanced panel renders with the
  // release browser auto-opened. Closing without a grab removes it again.
  const findReleaseMutation = useMutation({
    mutationFn: (item: MovieSearchResult) => {
      const profileId = pickDefaultProfileId(
        radarrProfiles.data,
        (limits.data?.defaultProfileName ?? 'choose me').toLowerCase(),
      )
      const rootFolder = radarrFolders.data?.[0]?.path ?? null
      const body = {
        tmdbId: item.tmdbId,
        title: item.title,
        year: item.year,
        qualityProfileId: profileId,
        rootFolderPath: rootFolder,
        monitored: true,
        addOptions: { searchForMovie: false },
      }
      return radarr.addMovie(body)
    },
    onSuccess: (movie) => {
      qc.invalidateQueries({ queryKey: ['radarr', 'movie'] })
      grabbedRef.current = false
      setTransient({ id: movie.id })
      setViewing(movie)
    },
    onError: (e) => {
      setViewing(null)
      setToast(e instanceof Error ? e.message : String(e))
    },
  })

  // Tear down the transient add when the modal closes without a grab. Errors
  // are swallowed (best-effort cleanup) so a failed remove never surfaces.
  const handleDetailClose = () => {
    const t = transient
    if (t && !grabbedRef.current) {
      radarr
        .removeMovie(t.id, false)
        .catch(() => {})
        .finally(() => qc.invalidateQueries({ queryKey: ['radarr', 'movie'] }))
    }
    setTransient(null)
    setViewing(null)
  }

  const upgradeMutation = useMutation({
    mutationFn: (id: number) => radarr.upgrade(id),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['radarr', 'movie'] })
      if (result.status === 'grabbing') {
        setToast(
          `Upgrade grabbed: ${result.title} (${result.sizeGb.toFixed(2)} GB)`,
        )
      } else if (result.status === 'no_upgrade_available') {
        setToast(`No better release found under ${result.capGb} GB cap`)
      } else {
        setToast('Indexer returned no releases')
      }
    },
    onError: (e) => setToast(e instanceof Error ? e.message : String(e)),
  })

  const handleSearchClick = (item: MovieSearchResult) => {
    const inLib = libraryByTmdb.get(item.tmdbId)
    setViewing(inLib ?? item)
  }
  const handleLibraryClick = (m: Movie) => {
    setViewing(m)
  }

  const confirmRemove = (m: Movie) => {
    confirm({
      title: `Remove ${m.title}?`,
      body: 'This removes the movie from your library. The downloaded file stays on disk.',
      confirmLabel: 'Remove from library',
      onConfirm: async () => {
        await removeMutation.mutateAsync({ id: m.id, deleteFiles: false })
        setToast(`${m.title} removed from library`)
      },
    })
  }

  const placeholder =
    mode === 'discover'
      ? 'Dune, The Substance, Past Lives'
      : 'Start typing to find one'

  return (
    <section className="tv-tab">
      {mode === 'discover' ? (
        <>
          <DiscoverResults
            query={debouncedQuery}
            loading={search.isPending && debouncedQuery.length >= 2}
            error={search.error}
            results={search.data ?? []}
            libraryByTmdb={libraryByTmdb}
            onCardClick={handleSearchClick}
          />
          {debouncedQuery.length < 2 && (
            <div className="tv-tab__trending-below-fold">
              <TrendingRow
                items={strip.items}
                loading={suggested.isPending}
                error={suggested.error}
                source={suggested.data?.source ?? null}
                diag={suggested.data?.diag ?? null}
                onPick={handleTrendingPick}
                pendingId={trendingPending}
                label={strip.label}
                onRefresh={strip.refresh}
                refreshing={suggested.isFetching}
                feedback={strip.feedback}
                mode={strip.mode}
              />
            </div>
          )}
        </>
      ) : (
        <>
          {!library.isPending && !library.error && (library.data?.length ?? 0) > 0 && (
            <>
              <LibraryFilters
                sortOptions={MOVIE_SORT_OPTIONS}
                sortValue={sort}
                onSortChange={setSort}
                statusLabel="Status"
                statusOptions={MOVIE_STATUS_OPTIONS}
                statusValue={status}
                onStatusChange={(next) => {
                  setStatus(next)
                  setLetter('all')
                }}
              />
              {textFilteredLibrary.length > 0 && (
                <LibraryAlphabet
                  available={availableLetters}
                  value={letter}
                  onChange={setLetter}
                  totalCount={textFilteredLibrary.length}
                />
              )}
            </>
          )}
          <LibraryResults
            query={query}
            letter={letter}
            loading={library.isPending}
            error={library.error}
            items={filteredLibrary}
            onCardClick={handleLibraryClick}
          />
        </>
      )}

      <div className="tv-tab__dock">
        <SearchInput
          value={query}
          onChange={(next) => {
            setQuery(next)
            setLetter('all')
          }}
          placeholder={placeholder}
          ariaLabel="Search movies"
          autoFocus
        />
      </div>

      <div className="tv-tab__mode-anchor">
        <ModeToggle
          mode={mode}
          onChange={(next) => {
            withViewTransition(() => {
              setMode(next)
              if (next === 'discover') setLetter('all')
            })
          }}
          libraryCount={library.data?.length}
        />
      </div>

      <AddMovieModal
        movie={adding}
        onClose={() => setAdding(null)}
        onAdded={(title) => setToast(`${title} added to library`)}
        onError={(msg) => setToast(msg)}
      />

      <DetailModal
        open={viewing !== null}
        onClose={handleDetailClose}
        kind="Movie"
        title={viewing?.title ?? ''}
        year={viewing?.year}
        poster={viewing ? (
          ('id' in viewing ? pickLibraryPoster(viewing) : pickSearchPoster(viewing))
        ) : undefined}
        backdrop={viewing ? pickFanart(viewing) : undefined}
        metaStrip={viewing ? [
          viewing.studio,
          viewing.status,
          fmtRuntime(viewing.runtime),
          viewing.certification,
        ].filter((x): x is string => Boolean(x)) : []}
        genres={viewing?.genres}
        rating={viewing ? fmtMovieRating(viewing) : undefined}
        overview={viewing?.overview}
        meta={viewing ? buildMovieMeta(viewing) : []}
        cast={cast.data}
        castLoading={cast.isLoading}
        inLibrary={viewing !== null && 'id' in viewing}
        canRemove={isAdmin}
        playUrl={
          // No play affordance for an in-library title with no file on
          // disk — Plex can't have it either, and the title-search
          // fallback link would render a dead "Play in Plex" button.
          viewing && viewingAvailability === 'playable'
            ? plexLinkFor('movie', {
                tmdbId: viewing.tmdbId,
                imdbId: viewing.imdbId ?? null,
                title: viewing.title,
              })
            : null
        }
        unavailableNote={
          viewingAvailability === 'not_released'
            ? 'Not released yet'
            : viewingAvailability === 'missing'
              ? 'Awaiting download'
              : null
        }
        onPlayDirect={
          viewing && localMovieId != null
            ? () => {
                const t = viewing.title
                const startPositionSecs = resumePosition(mediaWatch.data?.get(`movie:${localMovieId}`))
                setViewing(null)
                setPlayingLocal({ id: localMovieId, title: t, startPositionSecs })
              }
            : undefined
        }
        onAdd={viewing && !('id' in viewing) ? () => {
          const item = viewing as MovieSearchResult
          setViewing(null)
          setAdding(item)
        } : undefined}
        onFindRelease={isAdmin && viewing && !('id' in viewing) ? () => {
          findReleaseMutation.mutate(viewing as MovieSearchResult)
        } : undefined}
        onUpgrade={isAdmin && viewing && 'id' in viewing && viewingAvailability === 'playable' ? () => {
          // "Better version" implies a version exists — suppressed alongside
          // the play buttons when there is no file yet.
          const m = viewing as Movie
          upgradeMutation.mutate(m.id)
        } : undefined}
        upgrading={upgradeMutation.isPending}
        onRemove={viewing && 'id' in viewing ? () => {
          const m = viewing as Movie
          setViewing(null)
          confirmRemove(m)
        } : undefined}
        advanced={isAdmin && viewing && 'id' in viewing ? (
          <ArrAdvancedPanel
            kind="movie"
            itemId={(viewing as Movie).id}
            monitored={(viewing as Movie).monitored}
            qualityProfileId={(viewing as Movie).qualityProfileId}
            rootFolderPath={(viewing as Movie).rootFolderPath}
            onToast={setToast}
            autoOpenSearch={transient?.id === (viewing as Movie).id}
            onGrabbed={() => {
              grabbedRef.current = true
              setTransient(null)
            }}
          />
        ) : undefined}
        autoShowAdvanced={viewing !== null && 'id' in viewing && transient?.id === viewing.id}
      />

      {playingLocal && (
        <MediaPlayer
          key={playingLocal.id}
          kind="movie"
          id={playingLocal.id}
          title={playingLocal.title}
          startPositionSecs={playingLocal.startPositionSecs}
          onClose={() => setPlayingLocal(null)}
        />
      )}

      <Toast message={toast} onDone={() => setToast(null)} />
    </section>
  )
}

type DiscoverProps = {
  query: string
  loading: boolean
  error: unknown
  results: MovieSearchResult[]
  libraryByTmdb: Map<number, Movie>
  onCardClick: (m: MovieSearchResult) => void
}

function DiscoverResults({ query, loading, error, results, libraryByTmdb, onCardClick }: DiscoverProps) {
  if (query.length < 2) return null
  if (loading) return <LoadingPulse>Searching</LoadingPulse>
  if (error) {
    return (
      <div className="tv-tab__error">
        <p>Couldn't reach Radarr; the server may be down or misconfigured.</p>
        <p className="tv-tab__error-detail">{String(error)}</p>
      </div>
    )
  }
  if (results.length === 0) return <p className="tv-tab__hint">Nothing matched. Try a different title.</p>

  return (
    <ResultGrid>
      {results.map((item) => {
        const inLib = libraryByTmdb.has(item.tmdbId)
        const meta = [item.studio, fmtRuntime(item.runtime), item.status]
          .filter((x): x is string => Boolean(x))
          .join(' · ')
        return (
          <MediaCard
            key={item.tmdbId}
            poster={pickSearchPoster(item)}
            title={item.title}
            year={item.year}
            meta={meta || undefined}
            overview={item.overview}
            inLibrary={inLib}
            onClick={() => onCardClick(item)}
          />
        )
      })}
    </ResultGrid>
  )
}

type LibraryProps = {
  query: string
  letter: LibraryLetter
  loading: boolean
  error: unknown
  items: Movie[]
  onCardClick: (m: Movie) => void
}

function LibraryResults({ query, letter, loading, error, items, onCardClick }: LibraryProps) {
  if (loading) return <LoadingPulse>Loading library</LoadingPulse>
  if (error) {
    return (
      <div className="tv-tab__error">
        <p>Couldn't load your Radarr library.</p>
        <p className="tv-tab__error-detail">{String(error)}</p>
      </div>
    )
  }
  if (items.length === 0) {
    const emptyMsg = query.trim()
      ? 'Nothing in your library matches.'
      : letter !== 'all'
        ? `Nothing under ${letter}.`
        : 'Your library is empty. Add something from Discover.'
    return (
      <div className="tv-tab__empty">
        <EmeraldMark width={56} variant="single" />
        <p className="tv-tab__hint">{emptyMsg}</p>
      </div>
    )
  }

  return (
    <ResultGrid>
      {items.map((m) => {
        const meta = [m.studio, fmtRuntime(m.runtime), m.status]
          .filter((x): x is string => Boolean(x))
          .join(' · ')
        return (
          <MediaCard
            key={m.id}
            poster={pickLibraryPoster(m)}
            title={m.title}
            year={m.year}
            meta={meta || undefined}
            overview={m.overview}
            onClick={() => onCardClick(m)}
          />
        )
      })}
    </ResultGrid>
  )
}
