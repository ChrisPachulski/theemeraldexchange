import { useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { SearchInput } from '../search/SearchInput'
import { ResultGrid } from '../search/ResultGrid'
import { MediaCard } from '../search/MediaCard'
import { ModeToggle, type Mode } from '../search/ModeToggle'
import { LibraryAlphabet, libraryBucket, type LibraryLetter } from '../library/LibraryAlphabet'
import { LibraryFilters, type FilterOption } from '../library/LibraryFilters'
import { LibraryBrowse, type BrowseRow } from '../library/LibraryBrowse'
import type { Card } from '../home/HomeShelves'
import { continueWatching, episodeLabel as resumeEpisodeLabel, titleKey } from '../home/shelves'
import { DetailModal, type DetailMeta, type SeasonEpisode } from '../detail/DetailModal'
import { ArrAdvancedPanel } from '../detail/ArrAdvancedPanel'
import { AddSeriesModal } from '../add/AddSeriesModal'
import { Toast } from '../toast/Toast'
import { LoadingPulse } from '../feedback/LoadingPulse'
import { EmeraldMark } from '../atmosphere/EmeraldMark'
import { useAuth } from '../../lib/auth'
import { useDebounced } from '../../lib/hooks/useDebounced'
import { useSeriesSearch } from '../../lib/hooks/useSeriesSearch'
import { useRatings } from '../../lib/hooks/useRatings'
import { ratingPieces, type RatingPiece, type RatingsMap } from '../../lib/api/ratings'
import { useSonarrLibrary, useSonarrProfiles, useSonarrRootFolders } from '../../lib/hooks/useSonarrLibrary'
import { useSonarrEpisodes } from '../../lib/hooks/useSonarrEpisodes'
import { useSuggestionStrip } from '../../lib/hooks/useSuggestionStrip'
import { useLimits } from '../../lib/hooks/useLimits'
import { useRatingGate, useSectionAccess } from '../../lib/hooks/usePolicy'
import { usePlexLinks } from '../../lib/hooks/usePlexLinks'
import { resumePosition, useLocalShowIndex, useMediaEpisodes, useMediaWatch } from '../../lib/hooks/useMediaLibrary'
import { MediaPlayer } from '../media/MediaPlayer'
import { episodeLabel } from '../media/EpisodePicker'
import { TrendingRow } from '../search/TrendingRow'
import { useCast } from '../../lib/hooks/useCast'
import { useConfirm } from '../confirm/useConfirm'
import { seriesAvailability, sonarr, type Series, type SeriesSearchResult } from '../../lib/api/sonarr'
import { postClickEvent } from '../../lib/api/recommenderEvents'
import type { MediaEpisode } from '../../lib/api/media'
import { seriesPlayback, watchBadge, watchFraction } from '../../lib/watchState'
import { mediaApi } from '../../lib/api/media'
import type { RelatedItem } from '../../lib/api/tmdb'
import { episodeQueue } from '../media/playbackSession'
import { withViewTransition } from '../../lib/viewTransition'
import { useIntent } from '../../lib/router'
import {
  filterAndSortLibrary,
  byTitleAsc,
  byTitleDesc,
  byYearAsc,
  byYearDesc,
  byAddedDesc,
  byRatingDesc,
  browseShelves,
  distinctGenres,
  seriesRating,
} from '../../lib/librarySort'
import { pickDefaultProfileId } from '../../lib/pickDefaultProfileId'
import { pickDefaultRootFolder } from '../../lib/pickDefaultRootFolder'
import './TvTab.css'

function pickSearchPoster(item: SeriesSearchResult): string | undefined {
  if (item.remotePoster) return item.remotePoster
  const img = item.images?.find((i) => i.coverType === 'poster')
  return img?.remoteUrl ?? img?.url
}

// ponytail: same 3-line pickers exist in MoviesTab with Movie types —
// duplicated on purpose; a shared generic isn't worth the coupling.
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
    // In the library: downloaded of total, as Apple shows it. A Discover
    // result has nothing on disk, so it keeps aired of total.
    const value = 'id' in item
      ? `${stats.episodeFileCount ?? 0} of ${total}`
      : total === stats.episodeCount ? String(total) : `${stats.episodeCount} of ${total}`
    rows.push({ label: 'Episodes', value })
  }
  if (stats?.sizeOnDisk && stats.sizeOnDisk > 0) {
    const gb = stats.sizeOnDisk / (1024 ** 3)
    rows.push({ label: 'On disk', value: gb >= 1 ? `${gb.toFixed(1)} GB` : `${(stats.sizeOnDisk / (1024 ** 2)).toFixed(0)} MB` })
  }
  return rows
}

// OMDb/RT scores when we have them; else Sonarr's lone TVDB score so the
// chip row is never blank for a rated show.
function seriesRatingPieces(item: SeriesSearchResult, ratings: RatingsMap): RatingPiece[] {
  const pieces = item.imdbId ? ratingPieces(ratings[item.imdbId]) : []
  if (pieces.length) return pieces
  const r = item.ratings
  if (!r?.value) return []
  const votes = r.votes ? ` (${r.votes.toLocaleString()} votes)` : ''
  return [{ kind: 'tvdb', value: r.value.toFixed(1), score: r.value, label: `TVDB ${r.value.toFixed(1)}${votes}` }]
}

type TvSort = 'title-asc' | 'title-desc' | 'added-desc' | 'rating-desc' | 'year-desc' | 'year-asc' | 'network'
type TvStatus = 'all' | 'continuing' | 'ended' | 'upcoming'

const TV_COMPARATORS: Record<TvSort, (a: Series, b: Series) => number> = {
  'title-asc': byTitleAsc,
  'title-desc': byTitleDesc,
  'added-desc': byAddedDesc,
  'rating-desc': byRatingDesc<Series>(seriesRating),
  'year-desc': byYearDesc,
  'year-asc': byYearAsc,
  network: (a, b) =>
    (a.network ?? '~').localeCompare(b.network ?? '~') || byTitleAsc(a, b),
}

const TV_SORT_OPTIONS: ReadonlyArray<FilterOption<TvSort>> = [
  { value: 'title-asc',   label: 'Title (A–Z)' },
  { value: 'title-desc',  label: 'Title (Z–A)' },
  { value: 'added-desc',  label: 'Recently added' },
  { value: 'rating-desc', label: 'Rating' },
  { value: 'year-desc',   label: 'Year (newest)' },
  { value: 'year-asc',    label: 'Year (oldest)' },
  { value: 'network',     label: 'Network' },
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
  const [genre, setGenre] = useState('all')
  const debouncedQuery = useDebounced(query, 300)
  const search = useSeriesSearch(mode === 'discover' ? debouncedQuery : '')
  const library = useSonarrLibrary()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const { isAdmin } = useAuth()
  const { linkFor: plexLinkFor } = usePlexLinks()

  const [adding, setAdding] = useState<SeriesSearchResult | null>(null)
  const [pickedViewing, setViewing] = useState<SeriesSearchResult | Series | null>(null)
  // The policy can arrive after a title opened (default-open while it loads),
  // so the detail always re-passes the gate rather than trusting the pick.
  const ratingGate = useRatingGate()
  let viewing = pickedViewing
  if (viewing && !ratingGate.allows(viewing.certification)) viewing = null
  const viewingRatings = useRatings([viewing?.imdbId])
  const [toast, setToast] = useState<string | null>(null)
  // Find-release flow: a title added transiently (monitored, auto-grab off)
  // purely so the interactive release browser can open on it. If the admin
  // closes the modal without grabbing, we remove it again so nothing is left
  // behind. `transient` holds the just-added series id; `grabbed` commits it.
  const [transient, setTransient] = useState<{ id: number } | null>(null)
  const grabbedRef = useRef(false)
  // Profile + root folder for the transient add body (same source the Add
  // modal uses), loaded only when admin so non-admins pay nothing.
  const sonarrProfiles = useSonarrProfiles()
  const sonarrFolders = useSonarrRootFolders()
  // In-browser playback of a locally-available show's episode.
  const [playingEpisode, setPlayingEpisode] = useState<{
    id: number
    title: string
    startPositionSecs?: number
    showId: number
    showTitle: string
    tvdbId?: number
  } | null>(null)
  // The playing show's episodes power the player's Up Next, prev/next and queue.
  const playingEpisodes = useMediaEpisodes(playingEpisode?.showId ?? null)

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
  // The viewed show's local episodes: the one-tap Resume/Play target, and the
  // season browser's play buttons and watch state (joined by season:episode).
  const viewingEpisodes = useMediaEpisodes(localShowId ?? null)
  const playback = useMemo(
    () => seriesPlayback(viewingEpisodes.data?.items ?? [], mediaWatch.data),
    [viewingEpisodes.data, mediaWatch.data],
  )
  const localByCode = useMemo(
    () => new Map((viewingEpisodes.data?.items ?? []).map((e) => [`${e.season}:${e.episode}`, e])),
    [viewingEpisodes.data],
  )
  const playTarget = playback.target
  const playEpisode = (ep: MediaEpisode) => {
    if (!viewing || localShowId == null) return
    const showTitle = viewing.title
    setViewing(null)
    setPlayingEpisode({
      id: ep.id,
      title: episodeLabel(showTitle, ep),
      startPositionSecs: resumePosition(mediaWatch.data?.get(`episode:${ep.id}`)),
      showId: localShowId,
      showTitle,
      // Feeds the end card's More like this after the show's last episode.
      tvdbId: viewing.tvdbId,
    })
  }
  // Whether the viewed IN-LIBRARY show has anything to play at all. A
  // tracked-but-unaired show has zero episode files — play affordances
  // give way to an availability note for it (movieAvailability twin).
  const viewingAvailability =
    viewing && 'id' in viewing ? seriesAvailability(viewing) : 'playable'
  const [trendingPending, setTrendingPending] = useState<number | null>(null)
  // Library set keyed by TMDB id — used to strip items the household
  // already has from suggestions (backend filters too; this is defense
  // in depth against races where a title was just added).
  const libraryTmdbIds = useMemo(() => {
    const set = new Set<number>()
    library.data?.forEach((s) => {
      if (typeof s.tmdbId === 'number' && s.tmdbId > 0) set.add(s.tmdbId)
    })
    return set
  }, [library.data])
  // All strip orchestration (personalization gating, mode toggle, library
  // filtering, feedback dots, refresh, labels — and the owner-mandated
  // never-auto-refresh-on-like rule) lives in useSuggestionStrip, shared
  // with MoviesTab. Only the pick flow below stays tab-specific.
  const strip = useSuggestionStrip('tv', libraryTmdbIds)
  const suggested = strip.suggested
  const handleTrendingPick = async (tmdbId: number) => {
    // See MoviesTab.handleTrendingPick — mirror the click to the
    // recommender so the optimizer sees real engagement, not just dot
    // feedback. Pure-trending picks with no matching rec_log row are
    // silently dropped sidecar-side.
    postClickEvent('tv', tmdbId)
    setTrendingPending(tmdbId)
    await openLookup(`tmdb:${tmdbId}`)
    setTrendingPending(null)
  }
  // Titles opened from elsewhere (links, Home, the strip) pass the same gate.
  const openIfAllowed = (s: Series | SeriesSearchResult) => {
    if (ratingGate.allows(s.certification)) setViewing(s)
    else setToast('That title isn’t available on this profile.')
  }
  // Resolve a `tmdb:N` / `tvdb:N` term through Sonarr, then open the library
  // entry if we own it, else the Discover detail. Shared by the strip and the
  // `#/tv/<term>` intent. The title fallback covers a `tmdb:` term Sonarr
  // can't resolve (Apple's openRelated).
  const openLookup = async (term: string, fallbackTitle?: string) => {
    try {
      let results = await sonarr.lookup(term)
      if (!results[0] && fallbackTitle) results = await sonarr.lookup(fallbackTitle)
      const hit = results[0]
      if (!hit) {
        setToast("Couldn't find that show on TVDB")
        return
      }
      openIfAllowed(libraryByTvdb.get(hit.tvdbId) ?? hit)
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e))
    }
  }
  const openRelated = async (item: RelatedItem) => {
    setTrendingPending(item.id)
    await openLookup(`tmdb:${item.id}`, item.title)
    setTrendingPending(null)
  }
  // End-card pick (Apple playPick): a local show plays its first episode in
  // place, anything else opens its detail.
  const playRelated = async (item: RelatedItem) => {
    const showId = localShowIdx.data?.get(item.id)
    if (showId == null) {
      setPlayingEpisode(null)
      return openRelated(item)
    }
    try {
      const eps = await qc.fetchQuery({
        queryKey: ['media', 'episodes', showId],
        queryFn: ({ signal }) => mediaApi.episodes(showId, { signal }),
        staleTime: 60_000,
      })
      const sorted = episodeQueue(eps.items, -1).episodes
      // Season 1 over specials, which sort first.
      const first = sorted.find((e) => e.season > 0) ?? sorted[0]
      if (!first) throw new Error(`No episodes of ${item.title} to play`)
      setPlayingEpisode({
        id: first.id,
        title: episodeLabel(item.title, first),
        startPositionSecs: resumePosition(mediaWatch.data?.get(`episode:${first.id}`)),
        showId,
        showTitle: item.title,
      })
    } catch (e) {
      setPlayingEpisode(null)
      setToast(e instanceof Error ? e.message : String(e))
    }
  }
  // Open-a-title intent from another surface (Home shelves, Downloads).
  useIntent('tv', !library.isPending, (ref) => {
    if (ref.includes(':')) return void openLookup(ref)
    const series = library.data?.find((s) => s.id === Number(ref))
    if (series) openIfAllowed(series)
  })

  // Episode list only useful for in-library shows (it powers the
  // per-season disclosure inside DetailModal). Discover results don't
  // have a Sonarr id yet.
  const viewingId = viewing && 'id' in viewing ? viewing.id : null
  const episodes = useSonarrEpisodes(viewingId)
  const episodesBySeason = useMemo(() => {
    const map = new Map<number, SeasonEpisode[]>()
    if (!episodes.data) return map
    for (const ep of episodes.data) {
      const list = map.get(ep.seasonNumber) ?? []
      list.push({
        episodeNumber: ep.episodeNumber,
        title: ep.title,
        airDate: ep.airDate ?? ep.airDateUtc,
        hasFile: ep.hasFile,
        overview: ep.overview,
        still: ep.images?.find((i) => i.coverType === 'screenshot')?.remoteUrl,
      })
      map.set(ep.seasonNumber, list)
    }
    return map
  }, [episodes.data])

  // A rating-capped profile never sees a title above its cap (unrated fails
  // closed), so filter before search, sort, A-Z and counts all inherit it.
  const visibleLibrary = useMemo(
    () => library.data?.filter((x) => ratingGate.allows(x.certification)),
    [library.data, ratingGate],
  )
  const visibleResults = useMemo(
    () => (search.data ?? []).filter((x) => ratingGate.allows(x.certification)),
    [search.data, ratingGate],
  )
  // Members whose policy denies library management get no Add (it 403s).
  const sections = useSectionAccess()
  const libraryGenres = useMemo(() => distinctGenres(visibleLibrary), [visibleLibrary])
  // Show the library grid narrowed to one genre, clearing the other filters so
  // they can't AND-strand it (Apple's genre route).
  const showGenre = (g: string) =>
    withViewTransition(() => {
      setQuery('')
      setLetter('all')
      setStatus('all')
      setGenre(g)
      setMode('library')
    })

  // Browse mode (Apple's Recommended): shelves over the rating-capped shows
  // with an episode on disk. Resume rows join by show title, as Home does.
  const browseRows = useMemo((): BrowseRow[] => {
    if (mode !== 'browse') return []
    const available = (visibleLibrary ?? []).filter((s) => seriesAvailability(s) === 'playable')
    const card = (s: Series, meta?: string | null, progress?: number): Card => ({
      key: String(s.id),
      title: s.title,
      meta: meta ?? (s.year ? String(s.year) : null),
      poster: pickLibraryPoster(s),
      progress,
      onOpen: () => setViewing(s),
    })
    const byTitle = new Map(available.map((s) => [titleKey(s.title), s]))
    const seen = new Set<number>()
    const resume = continueWatching(mediaWatch.data?.values() ?? []).flatMap((r) => {
      const s = r.mediaKind === 'episode' && r.showTitle ? byTitle.get(titleKey(r.showTitle)) : undefined
      if (!s || seen.has(s.id)) return []
      seen.add(s.id)
      return [card(s, resumeEpisodeLabel(r), watchFraction(r) || undefined)]
    })
    const shelves = browseShelves(available, { noun: 'shows', rating: seriesRating })
    return [
      ...(resume.length ? [{ key: 'resume', label: 'Continue watching', cards: resume }] : []),
      ...shelves.map((sh) => ({ key: sh.key, label: sh.label, cards: sh.items.map((s) => card(s)) })),
    ]
  }, [mode, visibleLibrary, mediaWatch.data])

  // Text + status filter, then sort. Article-stripped sort key is used
  // for title sorts (Plex behavior — "The Mandalorian" sorts under M).
  // Alphabet bucket runs against the same key so the bar matches the sort.
  const textFilteredLibrary = useMemo(
    () => filterAndSortLibrary(visibleLibrary, { query, status, genre, comparator: TV_COMPARATORS[sort] }),
    [visibleLibrary, query, status, genre, sort],
  )

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

  // Find-release: add the title monitored with auto-grab OFF so the release
  // endpoint (which requires the series to exist) has a real seriesId to query,
  // then view the returned Series so the Advanced panel renders with the
  // release browser auto-opened. Closing without a grab removes it again.
  const findReleaseMutation = useMutation({
    mutationFn: (item: SeriesSearchResult) => {
      const profileId = pickDefaultProfileId(
        sonarrProfiles.data,
        (limits.data?.defaultProfileName ?? 'choose me').toLowerCase(),
      )
      const rootFolder = pickDefaultRootFolder(sonarrFolders.data, limits.data?.defaultSonarrRootFolderPath)
      const body = {
        tvdbId: item.tvdbId,
        ...(item.tmdbId !== undefined ? { tmdbId: item.tmdbId } : {}),
        title: item.title,
        qualityProfileId: profileId,
        rootFolderPath: rootFolder,
        monitored: true,
        seasonFolder: true,
        addOptions: {
          monitor: 'all',
          searchForMissingEpisodes: false,
        },
        seasons: item.seasons,
      }
      return sonarr.addSeries(body)
    },
    onSuccess: (series) => {
      qc.invalidateQueries({ queryKey: ['sonarr', 'series'] })
      grabbedRef.current = false
      setTransient({ id: series.id })
      setViewing(series)
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
      sonarr
        .removeSeries(t.id, false)
        .catch(() => {})
        .finally(() => qc.invalidateQueries({ queryKey: ['sonarr', 'series'] }))
    }
    setTransient(null)
    setViewing(null)
  }

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
            results={visibleResults}
            libraryByTvdb={libraryByTvdb}
            onCardClick={handleSearchClick}
          />
          {/* Suggestions carry no certification: withheld under a cap. */}
          {debouncedQuery.length < 2 && !ratingGate.capped && (
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
      ) : mode === 'browse' ? (
        <LibraryBrowse
          loading={library.isPending}
          rows={browseRows}
          genres={libraryGenres}
          onGenre={showGenre}
          emptyHint={library.error ? "Couldn't load your Sonarr library." : 'Your library is empty. Add something from Discover.'}
        />
      ) : (
        <>
          {!library.isPending && !library.error && (visibleLibrary?.length ?? 0) > 0 && (
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
                genreOptions={libraryGenres}
                genreValue={genre}
                onGenreChange={(next) => {
                  setGenre(next)
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
            genre={genre}
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
            // Shelves can't be searched: typing searches the library grid.
            if (mode === 'browse') setMode('library')
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
          libraryCount={visibleLibrary?.length}
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
        onClose={handleDetailClose}
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
        onGenreClick={(g) => {
          // Genres can come from a Discover result that no local title carries;
          // an empty grid would strand the user, so say so instead.
          const match = libraryGenres.find((x) => x.toLowerCase() === g.toLowerCase())
          handleDetailClose()
          if (match) showGenre(match)
          else setToast(`No ${g} shows in your library`)
        }}
        rating={viewing ? seriesRatingPieces(viewing, viewingRatings) : undefined}
        overview={viewing?.overview}
        meta={viewing ? buildSeriesMeta(viewing) : []}
        cast={cast.data}
        castLoading={cast.isLoading}
        inLibrary={viewing !== null && 'id' in viewing}
        canRemove={isAdmin}
        playUrl={
          // No play affordance for an in-library show with zero downloaded
          // episodes — Plex can't have it either, and the title-search
          // fallback link would render a dead "Play in Plex" button.
          viewing && viewingAvailability === 'playable'
            ? plexLinkFor('tv', {
                tmdbId: viewing.tmdbId ?? null,
                tvdbId: viewing.tvdbId,
                imdbId: viewing.imdbId ?? null,
                title: viewing.title,
              })
            : null
        }
        unavailableNote={
          viewingAvailability === 'not_released'
            ? 'Not aired yet'
            : viewingAvailability === 'missing'
              ? 'No episodes downloaded yet'
              : null
        }
        onPlayDirect={
          // Apple's series play: resume the latest unfinished episode, else S1E1.
          playTarget ? () => playEpisode(playTarget) : undefined
        }
        playDirectLabel={
          playTarget ? `${playback.isResume ? 'Resume' : 'Play'} S${playTarget.season}E${playTarget.episode}` : undefined
        }
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
            episodes: eps?.map((e) => {
              const local = localByCode.get(`${s.seasonNumber}:${e.episodeNumber}`)
              if (!local) return e
              return { ...e, ...watchBadge(mediaWatch.data?.get(`episode:${local.id}`)), onPlay: () => playEpisode(local) }
            }),
            watchedCount: viewingEpisodes.data?.items.filter(
              (e) => e.season === s.seasonNumber && mediaWatch.data?.get(`episode:${e.id}`)?.completed,
            ).length,
          }
        }) : undefined}
        defaultSeason={playback.defaultSeason}
        onAddSeason={isAdmin && viewing && 'id' in viewing ? (seasonNumber) => {
          const seriesId = (viewing as Series).id
          monitorSeasonMutation.mutate({ seriesId, seasonNumber })
        } : undefined}
        addingSeason={monitorSeasonMutation.isPending ? monitorSeasonMutation.variables?.seasonNumber ?? null : null}
        onAdd={sections.arr && viewing && !('id' in viewing) ? () => {
          const item = viewing as SeriesSearchResult
          setViewing(null)
          setAdding(item)
        } : undefined}
        onFindRelease={isAdmin && viewing && !('id' in viewing) ? () => {
          findReleaseMutation.mutate(viewing as SeriesSearchResult)
        } : undefined}
        onRemove={viewing && 'id' in viewing ? () => {
          const s = viewing as Series
          setViewing(null)
          confirmRemove(s)
        } : undefined}
        advanced={isAdmin && viewing && 'id' in viewing ? (
          <ArrAdvancedPanel
            kind="tv"
            itemId={(viewing as Series).id}
            monitored={(viewing as Series).monitored}
            qualityProfileId={(viewing as Series).qualityProfileId}
            rootFolderPath={(viewing as Series).rootFolderPath}
            episodes={episodes.data}
            onToast={setToast}
            autoOpenSearch={transient?.id === (viewing as Series).id}
            onGrabbed={() => {
              grabbedRef.current = true
              setTransient(null)
            }}
          />
        ) : undefined}
        autoShowAdvanced={viewing !== null && 'id' in viewing && transient?.id === viewing.id}
        extras={viewing ? { kind: 'tv', id: viewing.tvdbId, tmdbId: viewing.tmdbId } : undefined}
        onPickRelated={(item) => void openRelated(item)}
        relatedPendingId={trendingPending}
      />

      {playingEpisode && (
        // Not keyed by episode: the player swaps episodes in place. The pick
        // (Resume SxEy or an episode row) is already the resume choice.
        <MediaPlayer
          kind="episode"
          id={playingEpisode.id}
          title={playingEpisode.title}
          startPositionSecs={playingEpisode.startPositionSecs}
          autoResume
          episodes={playingEpisodes.data?.items}
          // Related titles carry no certification: withheld under a cap.
          related={ratingGate.capped || !playingEpisode.tvdbId ? undefined : { kind: 'tv', id: playingEpisode.tvdbId }}
          onPickRelated={(item) => void playRelated(item)}
          onPlayEpisode={(ep) =>
            setPlayingEpisode((cur) =>
              cur && {
                ...cur,
                id: ep.id,
                title: episodeLabel(cur.showTitle, ep),
                startPositionSecs: resumePosition(mediaWatch.data?.get(`episode:${ep.id}`)),
              },
            )
          }
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
  const ratings = useRatings(results.map((r) => r.imdbId))
  if (query.length < 2) return null
  if (loading) return <LoadingPulse>Searching</LoadingPulse>
  if (error) {
    return (
      <div className="tv-tab__error">
        <p>Couldn't reach Sonarr; the server may be down or misconfigured.</p>
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
            rating={seriesRatingPieces(item, ratings)}
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
  genre: string
  loading: boolean
  error: unknown
  items: Series[]
  onCardClick: (s: Series) => void
}

function LibraryResults({ query, letter, genre, loading, error, items, onCardClick }: LibraryProps) {
  const ratings = useRatings(items.map((i) => i.imdbId))
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
    const emptyMsg = genre !== 'all'
      ? `No ${genre} shows ${query.trim() ? 'match your search' : 'in your library'}.`
      : query.trim()
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
        // "Missing": aired but nothing downloaded yet.
        const meta = [s.network, s.status, seriesAvailability(s) === 'missing' ? 'Missing' : null]
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
            rating={seriesRatingPieces(s, ratings)}
            onClick={() => onCardClick(s)}
          />
        )
      })}
    </ResultGrid>
  )
}
