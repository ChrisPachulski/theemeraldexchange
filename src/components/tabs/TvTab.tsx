import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { SearchInput } from '../search/SearchInput'
import { ResultGrid } from '../search/ResultGrid'
import { MediaCard } from '../search/MediaCard'
import { ModeToggle, type Mode } from '../search/ModeToggle'
import { LibraryAlphabet, libraryBucket, type LibraryLetter } from '../library/LibraryAlphabet'
import { LibraryFilters, type FilterOption } from '../library/LibraryFilters'
import { DetailModal, type DetailMeta } from '../detail/DetailModal'
import { AddSeriesModal } from '../add/AddSeriesModal'
import { Toast } from '../toast/Toast'
import { LoadingPulse } from '../feedback/LoadingPulse'
import { EmeraldMark } from '../atmosphere/EmeraldMark'
import { useAuth } from '../../lib/auth'
import { useDebounced } from '../../lib/hooks/useDebounced'
import { useSeriesSearch } from '../../lib/hooks/useSeriesSearch'
import { useSonarrLibrary } from '../../lib/hooks/useSonarrLibrary'
import { useSonarrEpisodes } from '../../lib/hooks/useSonarrEpisodes'
import { useSuggestedTv } from '../../lib/hooks/useSuggested'
import { useSuggestionMode } from '../../lib/hooks/useSuggestionMode'
import { useUserApiKey } from '../../lib/hooks/useUserApiKey'
import { useLimits } from '../../lib/hooks/useLimits'
import { useFeedback, useSetFeedback } from '../../lib/hooks/useUserFeedback'
import { usePlexLinks } from '../../lib/hooks/usePlexLinks'
import { resumePosition, useLocalShowIndex, useMediaWatch } from '../../lib/hooks/useMediaLibrary'
import { MediaPlayer } from '../media/MediaPlayer'
import { EpisodePicker } from '../media/EpisodePicker'
import type { DotState } from '../search/FeedbackDots'
import { TrendingRow } from '../search/TrendingRow'
import { useCast } from '../../lib/hooks/useCast'
import { useConfirm } from '../confirm/useConfirm'
import { sonarr, type Series, type SeriesSearchResult } from '../../lib/api/sonarr'
import { postClickEvent } from '../../lib/api/recommenderEvents'
import { withViewTransition } from '../../lib/viewTransition'
import { stripArticle } from '../../lib/title'
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

function pickFanart(item: SeriesSearchResult | Series): string | undefined {
  const img = item.images?.find((i) => i.coverType === 'fanart')
  return img?.remoteUrl ?? img?.url
}

// Build the Plex-style metadata rows shared by Discover + Library views.
// Runtime is intentionally omitted — for TV the per-season air dates
// in the disclosure carry more weight than a per-episode minute count.
function buildSeriesMeta(item: SeriesSearchResult | Series): DetailMeta[] {
  const rows: DetailMeta[] = []
  if (item.network) rows.push({ label: 'Network', value: item.network })
  if (item.status) rows.push({ label: 'Status', value: item.status })
  if (item.firstAired) {
    const d = new Date(item.firstAired)
    if (!isNaN(d.getTime())) rows.push({ label: 'First aired', value: d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) })
  }
  if (item.certification) rows.push({ label: 'Rated', value: item.certification })
  const stats = item.statistics
  if (stats?.seasonCount) rows.push({ label: 'Seasons', value: String(stats.seasonCount) })
  if (stats?.episodeCount) {
    const total = stats.totalEpisodeCount ?? stats.episodeCount
    rows.push({ label: 'Episodes', value: total === stats.episodeCount ? String(stats.episodeCount) : `${stats.episodeCount} of ${total}` })
  }
  if (stats?.sizeOnDisk && stats.sizeOnDisk > 0) {
    const gb = stats.sizeOnDisk / (1024 ** 3)
    rows.push({ label: 'On disk', value: gb >= 1 ? `${gb.toFixed(1)} GB` : `${(stats.sizeOnDisk / (1024 ** 2)).toFixed(0)} MB` })
  }
  return rows
}

function fmtSeriesRating(item: SeriesSearchResult): string | undefined {
  const r = item.ratings
  if (!r?.value) return undefined
  return r.votes ? `${r.value.toFixed(1)} (${r.votes.toLocaleString()} votes)` : r.value.toFixed(1)
}

type TvSort = 'title-asc' | 'title-desc' | 'year-desc' | 'year-asc' | 'network'
type TvStatus = 'all' | 'continuing' | 'ended' | 'upcoming'

const TV_SORT_OPTIONS: ReadonlyArray<FilterOption<TvSort>> = [
  { value: 'title-asc',  label: 'Title (A–Z)' },
  { value: 'title-desc', label: 'Title (Z–A)' },
  { value: 'year-desc',  label: 'Year (newest)' },
  { value: 'year-asc',   label: 'Year (oldest)' },
  { value: 'network',    label: 'Network' },
]

const TV_STATUS_OPTIONS: ReadonlyArray<FilterOption<TvStatus>> = [
  { value: 'all',         label: 'All status' },
  { value: 'continuing',  label: 'Continuing' },
  { value: 'ended',       label: 'Ended' },
  { value: 'upcoming',    label: 'Upcoming' },
]

export function TvTab() {
  const [mode, setMode] = useState<Mode>('discover')
  const [query, setQuery] = useState('')
  const [letter, setLetter] = useState<LibraryLetter>('all')
  const [sort, setSort] = useState<TvSort>('title-asc')
  const [status, setStatus] = useState<TvStatus>('all')
  const debouncedQuery = useDebounced(query, 300)
  const search = useSeriesSearch(mode === 'discover' ? debouncedQuery : '')
  const library = useSonarrLibrary()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const { isAdmin } = useAuth()
  const { linkFor: plexLinkFor } = usePlexLinks()

  const [adding, setAdding] = useState<SeriesSearchResult | null>(null)
  const [viewing, setViewing] = useState<SeriesSearchResult | Series | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  // In-browser playback of a locally-available show: pick an episode, then play.
  const [pickShow, setPickShow] = useState<{ id: number; title: string } | null>(null)
  const [playingEpisode, setPlayingEpisode] = useState<{
    id: number
    title: string
    startPositionSecs?: number
  } | null>(null)

  const cast = useCast({
    type: 'tv',
    tvdbId: viewing?.tvdbId ?? 0,
    enabled: viewing !== null,
  })

  const libraryByTvdb = useMemo(() => {
    const map = new Map<number, Series>()
    library.data?.forEach((s) => map.set(s.tvdbId, s))
    return map
  }, [library.data])

  const userKey = useUserApiKey()
  const limits = useLimits()
  // Match the viewed show to a locally-available one (media-core) so the detail
  // modal can offer in-browser episode playback. Gated on mediaEnabled.
  const mediaEnabled = limits.data?.mediaEnabled !== false
  const localShowIdx = useLocalShowIndex(mediaEnabled)
  const mediaWatch = useMediaWatch(mediaEnabled)
  const localShowId =
    viewing && typeof viewing.tmdbId === 'number'
      ? localShowIdx.data?.get(viewing.tmdbId)
      : undefined
  const localRecommender = limits.data?.useLocalRecommender === true
  // See MoviesTab — Recommended ⇄ Trending toggle, shown whenever
  // personalization is achievable (free local recommender or a BYO key).
  const personalizedAchievable = localRecommender || userKey.hasKey
  const { mode: suggestionMode, setMode: setSuggestionMode } = useSuggestionMode(
    localRecommender ? 'recommended' : 'trending',
  )
  const forceTrending = !personalizedAchievable || suggestionMode === 'trending'
  const suggested = useSuggestedTv(forceTrending, userKey.key)
  const feedback = useFeedback()
  const setFeedback = useSetFeedback('tv')
  const stateFor = (id: number): DotState => {
    const fb = feedback.data?.tv
    if (!fb) return 'unset'
    if (fb.liked.some((e) => e.id === id)) return 'liked'
    if (fb.disliked.some((e) => e.id === id)) return 'disliked'
    return 'unset'
  }
  const [trendingPending, setTrendingPending] = useState<number | null>(null)
  // Library set keyed by TMDB id — used to strip items the household
  // already has from suggestions (backend filters too; this is defense
  // in depth against races where a title was just added).
  const libraryByTmdbForTrending = useMemo(() => {
    const set = new Set<number>()
    library.data?.forEach((s) => {
      if (typeof s.tmdbId === 'number' && s.tmdbId > 0) set.add(s.tmdbId)
    })
    return set
  }, [library.data])
  // Filter out library overlap and dedupe by id (TrendingRow keys on
  // item.id; a duplicate would render twice and emit a React warning).
  const trendingFiltered = useMemo(() => {
    const seen = new Set<number>()
    return (suggested.data?.items ?? []).filter((t) => {
      if (libraryByTmdbForTrending.has(t.id)) return false
      if (seen.has(t.id)) return false
      seen.add(t.id)
      return true
    })
  }, [suggested.data, libraryByTmdbForTrending])
  // Manual refresh trigger = a fresh recommender run. refetch() re-hits
  // /api/suggestions/tv, which (local recommender on) re-scores.
  // See MoviesTab — depend on the stable `refetch`, not the whole query
  // result, or the memo is a no-op (new reference every render).
  const refresh = suggested.refetch
  const refreshSuggestions = useCallback(() => {
    void refresh()
  }, [refresh])
  // No auto-refresh on judgement. The strip is only ever replaced by an
  // explicit refresh (the header button), a dislike draining it to the
  // low-water mark (useSetFeedback lazy-refill), or a natural remount.
  // A *like* must NEVER swap the lineup: liking the last unjudged card
  // used to flip "every card judged" → auto-refetch, yanking the picks
  // the user just accepted out from under them (the repeated complaint).
  // 'recommender' is the local-model source — also a personalized
  // pick, just from the on-NAS model rather than Claude.
  const src = suggested.data?.source
  const trendingLabel =
    src && (src.startsWith('personalized') || src === 'recommender')
      ? 'Picked for you'
      : 'Trending this week'
  const handleTrendingPick = async (tmdbId: number) => {
    // See MoviesTab.handleTrendingPick — mirror the click to the
    // recommender so the optimizer sees real engagement, not just dot
    // feedback. Pure-trending picks with no matching rec_log row are
    // silently dropped sidecar-side.
    postClickEvent('tv', tmdbId)
    setTrendingPending(tmdbId)
    try {
      const results = await sonarr.lookup(`tmdb:${tmdbId}`)
      const hit = results[0]
      if (!hit) {
        setToast("Couldn't find that show on TVDB")
        return
      }
      const inLib = libraryByTvdb.get(hit.tvdbId)
      setViewing(inLib ?? hit)
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e))
    } finally {
      setTrendingPending(null)
    }
  }

  // Episode list only useful for in-library shows (it powers the
  // per-season disclosure inside DetailModal). Discover results don't
  // have a Sonarr id yet.
  const viewingId = viewing && 'id' in viewing ? viewing.id : null
  const episodes = useSonarrEpisodes(viewingId)
  const episodesBySeason = useMemo(() => {
    const map = new Map<number, Array<{ episodeNumber: number; title: string; airDate?: string; hasFile?: boolean }>>()
    if (!episodes.data) return map
    for (const ep of episodes.data) {
      const list = map.get(ep.seasonNumber) ?? []
      list.push({
        episodeNumber: ep.episodeNumber,
        title: ep.title,
        airDate: ep.airDate ?? ep.airDateUtc,
        hasFile: ep.hasFile,
      })
      map.set(ep.seasonNumber, list)
    }
    return map
  }, [episodes.data])

  // Text + status filter, then sort. Article-stripped sort key is used
  // for title sorts (Plex behavior — "The Mandalorian" sorts under M).
  // Alphabet bucket runs against the same key so the bar matches the sort.
  const textFilteredLibrary = useMemo(() => {
    if (!library.data) return []
    const q = query.trim().toLowerCase()
    let items = q
      ? library.data.filter((s) => s.title.toLowerCase().includes(q))
      : library.data.slice()
    if (status !== 'all') {
      items = items.filter((s) => (s.status ?? '').toLowerCase() === status)
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
      case 'network':
        sorted.sort((a, b) =>
          (a.network ?? '~').localeCompare(b.network ?? '~') ||
          stripArticle(a.title).localeCompare(stripArticle(b.title))
        )
        break
    }
    return sorted
  }, [library.data, query, status, sort])

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

  const monitorSeasonMutation = useMutation({
    mutationFn: ({ seriesId, seasonNumber }: { seriesId: number; seasonNumber: number }) =>
      sonarr.monitorSeason(seriesId, seasonNumber),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['sonarr', 'series'] })
      const inFlight = viewing && 'id' in viewing ? viewing.title : 'series'
      setToast(`Season ${vars.seasonNumber} of ${inFlight} queued`)
    },
    onError: (e) => setToast(e instanceof Error ? e.message : String(e)),
  })

  // Card click in either mode now opens the detail modal first. The
  // modal's action footer fires the underlying add/remove flows.
  const handleSearchClick = (item: SeriesSearchResult) => {
    const inLib = libraryByTvdb.get(item.tvdbId)
    setViewing(inLib ?? item)
  }
  const handleLibraryClick = (s: Series) => {
    setViewing(s)
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
        <>
          <DiscoverResults
            query={debouncedQuery}
            loading={search.isPending && debouncedQuery.length >= 2}
            error={search.error}
            results={search.data ?? []}
            libraryByTvdb={libraryByTvdb}
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
                onRefresh={refreshSuggestions}
                refreshing={suggested.isFetching}
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
                  // See MoviesTab — dots render disabled when the
                  // feedback store is unreachable instead of silently
                  // looking like a clean first-run.
                  unavailable: !!feedback.error,
                }}
                mode={personalizedAchievable ? { value: suggestionMode, onChange: setSuggestionMode } : undefined}
              />
            </div>
          )}
        </>
      ) : (
        <>
          {!library.isPending && !library.error && (library.data?.length ?? 0) > 0 && (
            <>
              <LibraryFilters
                sortOptions={TV_SORT_OPTIONS}
                sortValue={sort}
                onSortChange={setSort}
                statusLabel="Status"
                statusOptions={TV_STATUS_OPTIONS}
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
          ariaLabel="Search TV shows"
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

      <AddSeriesModal
        series={adding}
        onClose={() => setAdding(null)}
        onAdded={(title) => setToast(`${title} added to library`)}
        onError={(msg) => setToast(msg)}
      />

      <DetailModal
        open={viewing !== null}
        onClose={() => setViewing(null)}
        kind="TV Show"
        title={viewing?.title ?? ''}
        year={viewing?.year}
        poster={viewing ? (
          ('id' in viewing ? pickLibraryPoster(viewing) : pickSearchPoster(viewing))
        ) : undefined}
        backdrop={viewing ? pickFanart(viewing) : undefined}
        metaStrip={viewing ? [
          viewing.network,
          viewing.status,
          viewing.certification,
        ].filter((x): x is string => Boolean(x)) : []}
        genres={viewing?.genres}
        rating={viewing ? fmtSeriesRating(viewing) : undefined}
        overview={viewing?.overview}
        meta={viewing ? buildSeriesMeta(viewing) : []}
        cast={cast.data}
        castLoading={cast.isLoading}
        inLibrary={viewing !== null && 'id' in viewing}
        canRemove={isAdmin}
        playUrl={
          viewing
            ? plexLinkFor('tv', {
                tmdbId: viewing.tmdbId ?? null,
                tvdbId: viewing.tvdbId,
                imdbId: viewing.imdbId ?? null,
                title: viewing.title,
              })
            : null
        }
        onPlayDirect={
          viewing && localShowId != null
            ? () => {
                const t = viewing.title
                setViewing(null)
                setPickShow({ id: localShowId, title: t })
              }
            : undefined
        }
        playDirectLabel="Watch episodes here"
        seasons={viewing && 'id' in viewing && viewing.seasons ? viewing.seasons.map((s) => {
          const eps = episodesBySeason.get(s.seasonNumber)
          const firstAired = eps && eps.length > 0
            ? eps
                .map((e) => e.airDate)
                .filter((d): d is string => Boolean(d))
                .sort()[0]
            : undefined
          return {
            seasonNumber: s.seasonNumber,
            monitored: s.monitored,
            episodeCount: s.statistics?.episodeCount ?? 0,
            totalEpisodeCount: s.statistics?.totalEpisodeCount ?? 0,
            episodeFileCount: s.statistics?.episodeFileCount ?? 0,
            airDate: firstAired,
            episodes: eps,
          }
        }) : undefined}
        onAddSeason={isAdmin && viewing && 'id' in viewing ? (seasonNumber) => {
          const seriesId = (viewing as Series).id
          monitorSeasonMutation.mutate({ seriesId, seasonNumber })
        } : undefined}
        addingSeason={monitorSeasonMutation.isPending ? monitorSeasonMutation.variables?.seasonNumber ?? null : null}
        onAdd={viewing && !('id' in viewing) ? () => {
          const item = viewing as SeriesSearchResult
          setViewing(null)
          setAdding(item)
        } : undefined}
        onRemove={viewing && 'id' in viewing ? () => {
          const s = viewing as Series
          setViewing(null)
          confirmRemove(s)
        } : undefined}
      />

      {pickShow && (
        <EpisodePicker
          showId={pickShow.id}
          showTitle={pickShow.title}
          onClose={() => setPickShow(null)}
          onPlay={(ep, label) => {
            const startPositionSecs = resumePosition(mediaWatch.data?.get(`episode:${ep.id}`))
            setPickShow(null)
            setPlayingEpisode({ id: ep.id, title: label, startPositionSecs })
          }}
        />
      )}
      {playingEpisode && (
        <MediaPlayer
          key={playingEpisode.id}
          kind="episode"
          id={playingEpisode.id}
          title={playingEpisode.title}
          startPositionSecs={playingEpisode.startPositionSecs}
          onClose={() => setPlayingEpisode(null)}
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
        <p>Couldn't reach Sonarr — the server may be down or misconfigured.</p>
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
    return (
      <div className="tv-tab__empty">
        <EmeraldMark width={56} variant="single" />
        <p className="tv-tab__hint">{emptyMsg}</p>
      </div>
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
