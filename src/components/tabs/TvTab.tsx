import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { SearchInput } from '../search/SearchInput'
import { ResultGrid } from '../search/ResultGrid'
import { MediaCard } from '../search/MediaCard'
import { ModeToggle, type Mode } from '../search/ModeToggle'
import { AddSeriesModal } from '../add/AddSeriesModal'
import { Toast } from '../toast/Toast'
import { useDebounced } from '../../lib/hooks/useDebounced'
import { useSeriesSearch } from '../../lib/hooks/useSeriesSearch'
import { useSonarrLibrary } from '../../lib/hooks/useSonarrLibrary'
import { useConfirm } from '../confirm/useConfirm'
import { sonarr, type Series, type SeriesSearchResult } from '../../lib/api/sonarr'
import './TvTab.css'

function pickSearchPoster(item: SeriesSearchResult): string | undefined {
  if (item.remotePoster) return item.remotePoster
  const img = item.images?.find((i) => i.coverType === 'poster')
  return img?.remoteUrl ?? img?.url
}

function pickLibraryPoster(item: Series): string | undefined {
  const img = item.images?.find((i) => i.coverType === 'poster')
  return img?.remoteUrl ?? img?.url
}

export function TvTab() {
  const [mode, setMode] = useState<Mode>('discover')
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebounced(query, 300)
  const search = useSeriesSearch(mode === 'discover' ? debouncedQuery : '')
  const library = useSonarrLibrary()
  const confirm = useConfirm()
  const qc = useQueryClient()

  const [adding, setAdding] = useState<SeriesSearchResult | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const libraryByTvdb = useMemo(() => {
    const map = new Map<number, Series>()
    library.data?.forEach((s) => map.set(s.tvdbId, s))
    return map
  }, [library.data])

  const filteredLibrary = useMemo(() => {
    if (!library.data) return []
    const q = query.trim().toLowerCase()
    const items = q ? library.data.filter((s) => s.title.toLowerCase().includes(q)) : library.data
    return [...items].sort((a, b) => a.title.localeCompare(b.title))
  }, [library.data, query])

  const removeMutation = useMutation({
    mutationFn: ({ id, deleteFiles }: { id: number; deleteFiles: boolean }) =>
      sonarr.removeSeries(id, deleteFiles),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sonarr', 'series'] }),
  })

  const handleSearchClick = (item: SeriesSearchResult) => {
    const inLib = libraryByTvdb.get(item.tvdbId)
    if (!inLib) {
      setAdding(item)
      return
    }
    confirmRemove(inLib)
  }

  const confirmRemove = (s: Series) => {
    confirm({
      title: `Remove ${s.title}?`,
      body: 'This removes the series from your library. The downloaded files stay on disk.',
      confirmLabel: 'Remove from library',
      onConfirm: async () => {
        await removeMutation.mutateAsync({ id: s.id, deleteFiles: false })
        setToast(`${s.title} removed from library`)
      },
    })
  }

  const placeholder =
    mode === 'discover'
      ? 'Severance, Andor, House of the Dragon'
      : 'Start typing to find one'
  const prompt = mode === 'discover' ? 'What are you tracking?' : 'In your library'

  return (
    <section className="tv-tab">
      {mode === 'discover' ? (
        <DiscoverResults
          query={debouncedQuery}
          loading={search.isPending && debouncedQuery.length >= 2}
          error={search.error}
          results={search.data ?? []}
          libraryByTvdb={libraryByTvdb}
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

      <AddSeriesModal
        series={adding}
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
  results: SeriesSearchResult[]
  libraryByTvdb: Map<number, Series>
  onCardClick: (s: SeriesSearchResult) => void
}

function DiscoverResults({ query, loading, error, results, libraryByTvdb, onCardClick }: DiscoverProps) {
  if (query.length < 2) return null
  if (loading) return <p className="tv-tab__hint">Searching</p>
  if (error) {
    return (
      <div className="tv-tab__error">
        <p>Couldn't reach Sonarr. Check that the dev server has SONARR_API_KEY in .env.local.</p>
        <p className="tv-tab__error-detail">{String(error)}</p>
      </div>
    )
  }
  if (results.length === 0) return <p className="tv-tab__hint">Nothing matched. Try a different title.</p>

  return (
    <ResultGrid>
      {results.map((item) => {
        const inLib = libraryByTvdb.has(item.tvdbId)
        const meta = [item.network, item.status]
          .filter((x): x is string => Boolean(x))
          .join(' · ')
        return (
          <MediaCard
            key={item.tvdbId}
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
  items: Series[]
  onCardClick: (s: Series) => void
}

function LibraryResults({ query, loading, error, items, onCardClick }: LibraryProps) {
  if (loading) return <p className="tv-tab__hint">Loading library</p>
  if (error) {
    return (
      <div className="tv-tab__error">
        <p>Couldn't load your Sonarr library.</p>
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
      {items.map((s) => {
        const meta = [s.network, s.status]
          .filter((x): x is string => Boolean(x))
          .join(' · ')
        return (
          <MediaCard
            key={s.id}
            poster={pickLibraryPoster(s)}
            title={s.title}
            year={s.year}
            meta={meta || undefined}
            overview={s.overview}
            onClick={() => onCardClick(s)}
          />
        )
      })}
    </ResultGrid>
  )
}
