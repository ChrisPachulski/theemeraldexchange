import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { SearchInput } from '../search/SearchInput'
import { ResultGrid } from '../search/ResultGrid'
import { MediaCard } from '../search/MediaCard'
import { ModeToggle, type Mode } from '../search/ModeToggle'
import { LibraryAlphabet, libraryBucket, type LibraryLetter } from '../library/LibraryAlphabet'
import { LibraryFilters, type FilterOption } from '../library/LibraryFilters'
import { AddMovieModal } from '../add/AddMovieModal'
import { Toast } from '../toast/Toast'
import { LoadingPulse } from '../feedback/LoadingPulse'
import { useAuth } from '../../lib/auth'
import { useDebounced } from '../../lib/hooks/useDebounced'
import { useMovieSearch } from '../../lib/hooks/useMovieSearch'
import { useRadarrLibrary } from '../../lib/hooks/useRadarrLibrary'
import { useConfirm } from '../confirm/useConfirm'
import { radarr, type Movie, type MovieSearchResult } from '../../lib/api/radarr'
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

  const [adding, setAdding] = useState<MovieSearchResult | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const libraryByTmdb = useMemo(() => {
    const map = new Map<number, Movie>()
    library.data?.forEach((m) => map.set(m.tmdbId, m))
    return map
  }, [library.data])

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

  const handleSearchClick = (item: MovieSearchResult) => {
    const inLib = libraryByTmdb.get(item.tmdbId)
    if (!inLib) {
      setAdding(item)
      return
    }
    if (!isAdmin) {
      setToast(`${inLib.title} is already in your library.`)
      return
    }
    confirmRemove(inLib)
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
        <DiscoverResults
          query={debouncedQuery}
          loading={search.isPending && debouncedQuery.length >= 2}
          error={search.error}
          results={search.data ?? []}
          libraryByTmdb={libraryByTmdb}
          onCardClick={handleSearchClick}
        />
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
                onStatusChange={setStatus}
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
            onCardClick={isAdmin ? confirmRemove : () => {}}
          />
        </>
      )}

      <div className="tv-tab__dock">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={placeholder}
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
    return <p className="tv-tab__hint">{emptyMsg}</p>
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
