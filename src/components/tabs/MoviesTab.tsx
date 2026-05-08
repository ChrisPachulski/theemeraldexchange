import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { SearchInput } from '../search/SearchInput'
import { ResultGrid } from '../search/ResultGrid'
import { MediaCard } from '../search/MediaCard'
import { ModeToggle, type Mode } from '../search/ModeToggle'
import { AddMovieModal } from '../add/AddMovieModal'
import { Toast } from '../toast/Toast'
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

export function MoviesTab() {
  const [mode, setMode] = useState<Mode>('discover')
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebounced(query, 300)
  const search = useMovieSearch(mode === 'discover' ? debouncedQuery : '')
  const library = useRadarrLibrary()
  const confirm = useConfirm()
  const qc = useQueryClient()

  const [adding, setAdding] = useState<MovieSearchResult | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const libraryByTmdb = useMemo(() => {
    const map = new Map<number, Movie>()
    library.data?.forEach((m) => map.set(m.tmdbId, m))
    return map
  }, [library.data])

  const filteredLibrary = useMemo(() => {
    if (!library.data) return []
    const q = query.trim().toLowerCase()
    const items = q ? library.data.filter((m) => m.title.toLowerCase().includes(q)) : library.data
    return [...items].sort((a, b) => a.title.localeCompare(b.title))
  }, [library.data, query])

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
  const prompt = mode === 'discover' ? 'What are you watching?' : 'In your library'

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
        <LibraryResults
          query={query}
          loading={library.isPending}
          error={library.error}
          items={filteredLibrary}
          onCardClick={confirmRemove}
        />
      )}

      <div className="tv-tab__dock">
        <div className="tv-tab__controls">
          <ModeToggle mode={mode} onChange={setMode} libraryCount={library.data?.length} />
        </div>
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={placeholder}
          prompt={prompt}
          autoFocus
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
  if (loading) return <p className="tv-tab__hint">Searching</p>
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
  loading: boolean
  error: unknown
  items: Movie[]
  onCardClick: (m: Movie) => void
}

function LibraryResults({ query, loading, error, items, onCardClick }: LibraryProps) {
  if (loading) return <p className="tv-tab__hint">Loading library</p>
  if (error) {
    return (
      <div className="tv-tab__error">
        <p>Couldn't load your Radarr library.</p>
        <p className="tv-tab__error-detail">{String(error)}</p>
      </div>
    )
  }
  if (items.length === 0) {
    return (
      <p className="tv-tab__hint">
        {query.trim() ? 'Nothing in your library matches.' : 'Your library is empty. Add something from Discover.'}
      </p>
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
