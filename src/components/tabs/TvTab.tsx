import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { SearchInput } from '../search/SearchInput'
import { ResultGrid } from '../search/ResultGrid'
import { MediaCard } from '../search/MediaCard'
import { ModeToggle, type Mode } from '../search/ModeToggle'
import { LibraryAlphabet, libraryBucket, type LibraryLetter } from '../library/LibraryAlphabet'
import { AddSeriesModal } from '../add/AddSeriesModal'
import { Toast } from '../toast/Toast'
import { LoadingPulse } from '../feedback/LoadingPulse'
import { useAuth } from '../../lib/auth'
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
  const [letter, setLetter] = useState<LibraryLetter>('all')
  const debouncedQuery = useDebounced(query, 300)
  const search = useSeriesSearch(mode === 'discover' ? debouncedQuery : '')
  const library = useSonarrLibrary()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const { isAdmin } = useAuth()

  const [adding, setAdding] = useState<SeriesSearchResult | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const libraryByTvdb = useMemo(() => {
    const map = new Map<number, Series>()
    library.data?.forEach((s) => map.set(s.tvdbId, s))
    return map
  }, [library.data])

  // Text-filtered library, sorted with leading articles stripped (Plex
  // behavior — "The Mandalorian" sorts under M, "An American Werewolf"
  // sorts under A). The alphabet bucket then runs against the same
  // article-stripped key, so what you see in the bar matches the sort.
  const textFilteredLibrary = useMemo(() => {
    if (!library.data) return []
    const q = query.trim().toLowerCase()
    const items = q ? library.data.filter((s) => s.title.toLowerCase().includes(q)) : library.data
    return [...items].sort((a, b) =>
      a.title.replace(/^(the|a|an)\s+/i, '').localeCompare(b.title.replace(/^(the|a|an)\s+/i, ''))
    )
  }, [library.data, query])

  const availableLetters = useMemo(
    () => new Set(textFilteredLibrary.map((s) => libraryBucket(s.title))),
    [textFilteredLibrary],
  )

  const filteredLibrary = useMemo(() => {
    if (letter === 'all') return textFilteredLibrary
    return textFilteredLibrary.filter((s) => libraryBucket(s.title) === letter)
  }, [textFilteredLibrary, letter])

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
    // Removing a series from the library is admin-only. Users get a
    // visual confirmation that the title is already tracked, no-op
    // beyond that.
    if (!isAdmin) {
      setToast(`${inLib.title} is already in your library.`)
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
        <>
          {!library.isPending && !library.error && textFilteredLibrary.length > 0 && (
            <LibraryAlphabet
              available={availableLetters}
              value={letter}
              onChange={setLetter}
              totalCount={textFilteredLibrary.length}
            />
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
  if (loading) return <LoadingPulse>Searching</LoadingPulse>
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
  letter: LibraryLetter
  loading: boolean
  error: unknown
  items: Series[]
  onCardClick: (s: Series) => void
}

function LibraryResults({ query, letter, loading, error, items, onCardClick }: LibraryProps) {
  if (loading) return <LoadingPulse>Loading library</LoadingPulse>
  if (error) {
    return (
      <div className="tv-tab__error">
        <p>Couldn't load your Sonarr library.</p>
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
