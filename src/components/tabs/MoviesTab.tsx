import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { SearchInput } from '../search/SearchInput'
import { ResultGrid } from '../search/ResultGrid'
import { MediaCard } from '../search/MediaCard'
import { ModeToggle, type Mode } from '../search/ModeToggle'
import { LibraryAlphabet, libraryBucket, type LibraryLetter } from '../library/LibraryAlphabet'
import { LibraryFilters, type FilterOption } from '../library/LibraryFilters'
import { DetailModal, type DetailMeta } from '../detail/DetailModal'
import { AddMovieModal } from '../add/AddMovieModal'
import { Toast } from '../toast/Toast'
import { LoadingPulse } from '../feedback/LoadingPulse'
import { EmeraldMark } from '../atmosphere/EmeraldMark'
import { useAuth } from '../../lib/auth'
import { useDebounced } from '../../lib/hooks/useDebounced'
import { useMovieSearch } from '../../lib/hooks/useMovieSearch'
import { useRadarrLibrary } from '../../lib/hooks/useRadarrLibrary'
import { useSuggestedMovies } from '../../lib/hooks/useSuggested'
import { useAiSuggestionsEnabled } from '../../lib/hooks/useAiSuggestionsEnabled'
import { useUserApiKey } from '../../lib/hooks/useUserApiKey'
import { useLimits } from '../../lib/hooks/useLimits'
import { useFeedback, useSetFeedback } from '../../lib/hooks/useUserFeedback'
import { usePlexLinks } from '../../lib/hooks/usePlexLinks'
import type { DotState } from '../search/FeedbackDots'
import { TrendingRow } from '../search/TrendingRow'
import { useCast } from '../../lib/hooks/useCast'
import { useConfirm } from '../confirm/useConfirm'
import { radarr, type Movie, type MovieSearchResult } from '../../lib/api/radarr'
import { postClickEvent } from '../../lib/api/recommenderEvents'
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

const stripArticle = (s: string) => s.replace(/^(the|a|an)\s+/i, '')

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

  const ai = useAiSuggestionsEnabled()
  const userKey = useUserApiKey()
  const limits = useLimits()
  // Local recommender takes precedence on the server; the AI toggle is
  // inert when it's on. Hide the toggle so we don't show users a
  // setting that does nothing.
  const localRecommender = limits.data?.useLocalRecommender === true
  const suggested = useSuggestedMovies(ai.enabled, userKey.key)
  const feedback = useFeedback()
  const setFeedback = useSetFeedback('movie')
  const stateFor = (id: number): DotState => {
    const fb = feedback.data?.movie
    if (!fb) return 'unset'
    if (fb.liked.some((e) => e.id === id)) return 'liked'
    if (fb.disliked.some((e) => e.id === id)) return 'disliked'
    return 'unset'
  }
  const [trendingPending, setTrendingPending] = useState<number | null>(null)
  // Defense in depth — backend already filters by library/rejections,
  // but client-side filter catches any race (just-added title, etc.).
  // Also dedupe by id: TrendingRow keys on item.id, so a duplicate
  // would render twice and emit a React warning.
  const trendingFiltered = useMemo(() => {
    const seen = new Set<number>()
    return (suggested.data?.items ?? []).filter((t) => {
      if (libraryByTmdb.has(t.id)) return false
      if (seen.has(t.id)) return false
      seen.add(t.id)
      return true
    })
  }, [suggested.data, libraryByTmdb])
  // Label adjusts based on whether the backend served personalized
  // recs or fell back to TMDB trending (cold start or no API key).
  // 'recommender' is the local-model source — also a personalized
  // pick, just from the on-NAS model rather than Claude.
  const src = suggested.data?.source
  const trendingLabel =
    src && (src.startsWith('personalized') || src === 'recommender')
      ? 'Picked for you'
      : 'Trending movies this week'
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

  const textFilteredLibrary = useMemo(() => {
    if (!library.data) return []
    const q = query.trim().toLowerCase()
    let items = q
      ? library.data.filter((m) => m.title.toLowerCase().includes(q))
      : library.data.slice()
    if (status !== 'all') {
      items = items.filter((m) => (m.status ?? '').toLowerCase() === status.toLowerCase())
    }
    const sorted = items.slice()
    switch (sort) {
      case 'title-asc':
        sorted.sort((a, b) => stripArticle(a.title).localeCompare(stripArticle(b.title)))
        break
      case 'title-desc':
        sorted.sort((a, b) => stripArticle(b.title).localeCompare(stripArticle(a.title)))
        break
      case 'year-desc':
        sorted.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || stripArticle(a.title).localeCompare(stripArticle(b.title)))
        break
      case 'year-asc':
        sorted.sort((a, b) => (a.year ?? 0) - (b.year ?? 0) || stripArticle(a.title).localeCompare(stripArticle(b.title)))
        break
      case 'runtime-desc':
        sorted.sort((a, b) => (b.runtime ?? 0) - (a.runtime ?? 0) || stripArticle(a.title).localeCompare(stripArticle(b.title)))
        break
      case 'runtime-asc':
        sorted.sort((a, b) => (a.runtime ?? 0) - (b.runtime ?? 0) || stripArticle(a.title).localeCompare(stripArticle(b.title)))
        break
      case 'studio':
        sorted.sort((a, b) =>
          (a.studio ?? '~').localeCompare(b.studio ?? '~') ||
          stripArticle(a.title).localeCompare(stripArticle(b.title))
        )
        break
    }
    return sorted
  }, [library.data, query, status, sort])

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
                items={trendingFiltered}
                loading={suggested.isPending}
                error={suggested.error}
                source={suggested.data?.source ?? null}
                diag={suggested.data?.diag ?? null}
                onPick={handleTrendingPick}
                pendingId={trendingPending}
                label={trendingLabel}
                feedback={{
                  stateFor,
                  onLike: (id, title) => {
                    const current = stateFor(id)
                    setFeedback.mutate({ tmdbId: id, title, signal: current === 'liked' ? null : 'like' })
                  },
                  onDislike: (id, title) => {
                    const current = stateFor(id)
                    setFeedback.mutate({ tmdbId: id, title, signal: current === 'disliked' ? null : 'dislike' })
                  },
                  // Feedback store unreachable → dots render disabled
                  // with a tooltip + inline label hint. Otherwise
                  // dots silently appear "unset," indistinguishable
                  // from a clean first-run.
                  unavailable: !!feedback.error,
                }}
                ai={userKey.hasKey && !localRecommender ? { enabled: ai.enabled, onToggle: ai.toggle } : undefined}
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
            setMode(next)
            if (next === 'discover') setLetter('all')
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
        onClose={() => setViewing(null)}
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
          viewing
            ? plexLinkFor('movie', {
                tmdbId: viewing.tmdbId,
                imdbId: viewing.imdbId ?? null,
                title: viewing.title,
              })
            : null
        }
        onAdd={viewing && !('id' in viewing) ? () => {
          const item = viewing as MovieSearchResult
          setViewing(null)
          setAdding(item)
        } : undefined}
        onUpgrade={isAdmin && viewing && 'id' in viewing ? () => {
          const m = viewing as Movie
          upgradeMutation.mutate(m.id)
        } : undefined}
        upgrading={upgradeMutation.isPending}
        onRemove={viewing && 'id' in viewing ? () => {
          const m = viewing as Movie
          setViewing(null)
          confirmRemove(m)
        } : undefined}
      />

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
        <p>Couldn't reach Radarr. Check that the dev server has RADARR_API_KEY in .env.local.</p>
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
            inLibrary
            onClick={() => onCardClick(m)}
          />
        )
      })}
    </ResultGrid>
  )
}
