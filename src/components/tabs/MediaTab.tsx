import { useMemo, useState } from 'react'
import { SearchInput } from '../search/SearchInput'
import { ResultGrid } from '../search/ResultGrid'
import { MediaCard } from '../search/MediaCard'
import { type Mode } from '../search/ModeToggle'
// ModeToggle.css carries the .mode-toggle pod styling reused by the
// Movies/Shows kind toggle below.
import '../search/ModeToggle.css'
import { SourceToggle, type SourceMode } from '../media/SourceToggle'
import { MediaPlayer } from '../media/MediaPlayer'
import { EpisodePicker } from '../media/EpisodePicker'
import { Toast } from '../toast/Toast'
import { LoadingPulse } from '../feedback/LoadingPulse'
import { EmeraldMark } from '../atmosphere/EmeraldMark'
import { MoviesTab } from './MoviesTab'
import { TvTab } from './TvTab'
import { useAuth } from '../../lib/auth'
import { useDebounced } from '../../lib/hooks/useDebounced'
import {
  useMediaMovies,
  useMediaShows,
  useMediaScan,
  useWatchState,
} from '../../lib/hooks/useMediaLibrary'
import {
  posterFor,
  type MediaMovie,
  type MediaShow,
  type PlayableKind,
  type WatchEntry,
} from '../../lib/api/media'
import { withViewTransition } from '../../lib/viewTransition'
// TvTab.css is the shared tab-layout stylesheet — MoviesTab imports it
// too. Reusing it keeps the dock/grid/empty/error styling consistent.
import './TvTab.css'
// Tab-specific extras (Scan button, kind toggle spacing).
import './MediaTab.css'

type Kind = 'movies' | 'shows'

/** What the player is currently showing, if anything. */
type NowPlaying = {
  kind: PlayableKind
  id: number
  title: string
  startPositionSecs?: number
}

/** Index watch rows by `${kind}:${id}` for O(1) resume lookups. */
function watchKey(kind: PlayableKind, id: number): string {
  return `${kind}:${id}`
}

function resumePosition(entry: WatchEntry | undefined): number | undefined {
  if (!entry || entry.completed || entry.positionSecs <= 0) return undefined
  return entry.positionSecs
}

export function MediaTab() {
  const [kind, setKind] = useState<Kind>('movies')
  const [source, setSource] = useState<SourceMode>('local')
  const [query, setQuery] = useState('')
  const [playing, setPlaying] = useState<NowPlaying | null>(null)
  // The show whose episode picker is open (TV needs an episode before play).
  const [pickShow, setPickShow] = useState<MediaShow | null>(null)
  // Wrap the source/kind axis swaps in a View Transition so the grid
  // cross-fades instead of hard-cutting. No-ops to a plain setState under
  // reduced-motion / unsupported browsers (see lib/viewTransition).
  const changeSource = (next: SourceMode) =>
    withViewTransition(() => setSource(next))
  const changeKind = (next: Kind) => withViewTransition(() => setKind(next))
  const debouncedQuery = useDebounced(query, 300)
  const { isAdmin } = useAuth()
  const [toast, setToast] = useState<string | null>(null)

  // Only fetch the active local query. When the user is in the
  // 'requestable' source the local hooks idle (q is the live debounced
  // value, but the grids below aren't rendered).
  const q = debouncedQuery.trim() || undefined
  const movies = useMediaMovies(kind === 'movies' ? q : undefined)
  const shows = useMediaShows(kind === 'shows' ? q : undefined)
  const watch = useWatchState()

  const watchIndex = useMemo(() => {
    const m = new Map<string, WatchEntry>()
    for (const e of watch.data ?? []) m.set(watchKey(e.mediaKind, e.mediaId), e)
    return m
  }, [watch.data])

  const play = (kindToPlay: PlayableKind, id: number, title: string) => {
    setPlaying({
      kind: kindToPlay,
      id,
      title,
      startPositionSecs: resumePosition(watchIndex.get(watchKey(kindToPlay, id))),
    })
  }

  const scan = useMediaScan()
  const handleScan = () => {
    scan.mutate(undefined, {
      onSuccess: (res) => {
        setToast(
          res.status === 'running'
            ? 'A scan is already running.'
            : 'Library scan started.',
        )
      },
      onError: (e) => setToast(e instanceof Error ? e.message : String(e)),
    })
  }

  const overlays = (
    <>
      {pickShow && (
        <EpisodePicker
          showId={pickShow.id}
          showTitle={pickShow.title}
          onClose={() => setPickShow(null)}
          onPlay={(ep, label) => {
            setPickShow(null)
            play('episode', ep.id, label)
          }}
        />
      )}
      {playing && (
        <MediaPlayer
          key={`${playing.kind}-${playing.id}`}
          kind={playing.kind}
          id={playing.id}
          title={playing.title}
          startPositionSecs={playing.startPositionSecs}
          onClose={() => setPlaying(null)}
        />
      )}
    </>
  )

  // 'requestable' reuses the existing discover/search/add flow wholesale
  // — MoviesTab / TvTab already own Radarr/Sonarr lookup, the detail
  // modal, add modal, trending, and feedback dots. No duplication.
  if (source === 'requestable') {
    return (
      <section className="tv-tab">
        <RequestableSource kind={kind} />
        <div className="tv-tab__mode-anchor">
          <SourceToggle mode={source} onChange={changeSource} />
          <KindToggle kind={kind} onChange={changeKind} />
        </div>
        <Toast message={toast} onDone={() => setToast(null)} />
        {overlays}
      </section>
    )
  }

  const active = kind === 'movies' ? movies : shows
  const localCount = active.data?.total

  return (
    <section className="tv-tab">
      {kind === 'movies' ? (
        <LocalMovies
          query={debouncedQuery}
          loading={movies.isPending}
          error={movies.error}
          items={movies.data?.items ?? []}
          isAdmin={isAdmin}
          onScan={handleScan}
          scanning={scan.isPending}
          onPlay={(m) => play('movie', m.id, m.title)}
        />
      ) : (
        <LocalShows
          query={debouncedQuery}
          loading={shows.isPending}
          error={shows.error}
          items={shows.data?.items ?? []}
          isAdmin={isAdmin}
          onScan={handleScan}
          scanning={scan.isPending}
          onPick={(s) => setPickShow(s)}
        />
      )}

      <div className="tv-tab__dock">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search your library"
          ariaLabel="Search local media"
          autoFocus
        />
      </div>

      <div className="tv-tab__mode-anchor">
        <SourceToggle mode={source} onChange={changeSource} localCount={localCount} />
        <KindToggle kind={kind} onChange={changeKind} />
      </div>

      <Toast message={toast} onDone={() => setToast(null)} />
      {overlays}
    </section>
  )
}

// Movies/Shows axis rendered with the same pod styling as ModeToggle.
// We reuse ModeToggle's 'discover'|'library' visual by mapping kind onto
// it would be confusing, so render a dedicated two-button group sharing
// the mode-toggle class for the emerald look.
function KindToggle({
  kind,
  onChange,
}: {
  kind: Kind
  onChange: (next: Kind) => void
}) {
  // Reuse ModeToggle for its emerald pod look by mapping kind to its
  // Mode union positionally: 'discover' slot = Movies, 'library' = Shows.
  const asMode: Mode = kind === 'movies' ? 'discover' : 'library'
  return (
    <div className="media-tab__kind">
      <ModeToggleLabels
        mode={asMode}
        onChange={(m) => onChange(m === 'discover' ? 'movies' : 'shows')}
      />
    </div>
  )
}

// Thin wrapper that relabels ModeToggle's two tabs to Movies / Shows
// without forking the component's styling.
function ModeToggleLabels({
  mode,
  onChange,
}: {
  mode: Mode
  onChange: (next: Mode) => void
}) {
  return (
    <div className="mode-toggle" role="tablist" aria-label="Media kind">
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'discover'}
        className={`mode-toggle__option${mode === 'discover' ? ' mode-toggle__option--active' : ''}`}
        onClick={() => onChange('discover')}
      >
        Movies
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'library'}
        className={`mode-toggle__option${mode === 'library' ? ' mode-toggle__option--active' : ''}`}
        onClick={() => onChange('library')}
      >
        Shows
      </button>
    </div>
  )
}

function RequestableSource({ kind }: { kind: Kind }) {
  // Delegate to the full existing discover experience. MoviesTab/TvTab
  // each render their own dock + toggle, so they fill the section.
  return kind === 'movies' ? <MoviesTab /> : <TvTab />
}

type LocalMoviesProps = {
  query: string
  loading: boolean
  error: unknown
  items: MediaMovie[]
  isAdmin: boolean
  onScan: () => void
  scanning: boolean
  onPlay: (movie: MediaMovie) => void
}

function LocalMovies({
  query,
  loading,
  error,
  items,
  isAdmin,
  onScan,
  scanning,
  onPlay,
}: LocalMoviesProps) {
  if (loading) return <LoadingPulse>Loading library</LoadingPulse>
  if (error) {
    return (
      <div className="tv-tab__error">
        <p>Couldn't reach the media library.</p>
        <p className="tv-tab__error-detail">{String(error)}</p>
      </div>
    )
  }
  if (items.length === 0) {
    return (
      <EmptyLibrary
        filtered={query.trim().length > 0}
        isAdmin={isAdmin}
        onScan={onScan}
        scanning={scanning}
      />
    )
  }
  return (
    <ResultGrid
      items={items}
      getKey={(m) => m.id}
      renderItem={(m) => (
        <MediaCard
          poster={posterFor(m)}
          title={m.title}
          year={m.year ?? undefined}
          overview={m.overview ?? undefined}
          inLibrary
          onClick={() => onPlay(m)}
        />
      )}
    />
  )
}

type LocalShowsProps = {
  query: string
  loading: boolean
  error: unknown
  items: MediaShow[]
  isAdmin: boolean
  onScan: () => void
  scanning: boolean
  onPick: (show: MediaShow) => void
}

function LocalShows({
  query,
  loading,
  error,
  items,
  isAdmin,
  onScan,
  scanning,
  onPick,
}: LocalShowsProps) {
  if (loading) return <LoadingPulse>Loading library</LoadingPulse>
  if (error) {
    return (
      <div className="tv-tab__error">
        <p>Couldn't reach the media library.</p>
        <p className="tv-tab__error-detail">{String(error)}</p>
      </div>
    )
  }
  if (items.length === 0) {
    return (
      <EmptyLibrary
        filtered={query.trim().length > 0}
        isAdmin={isAdmin}
        onScan={onScan}
        scanning={scanning}
      />
    )
  }
  return (
    <ResultGrid
      items={items}
      getKey={(s) => s.id}
      renderItem={(s) => (
        <MediaCard
          poster={posterFor(s)}
          title={s.title}
          year={s.year ?? undefined}
          overview={s.overview ?? undefined}
          inLibrary
          onClick={() => onPick(s)}
        />
      )}
    />
  )
}

function EmptyLibrary({
  filtered,
  isAdmin,
  onScan,
  scanning,
}: {
  filtered: boolean
  isAdmin: boolean
  onScan: () => void
  scanning: boolean
}) {
  const msg = filtered
    ? 'Nothing matches.'
    : 'Nothing scanned yet.'
  return (
    <div className="tv-tab__empty">
      <EmeraldMark width={56} variant="single" />
      <p className="tv-tab__hint">{msg}</p>
      {!filtered && isAdmin && (
        <button
          type="button"
          className="media-tab__scan"
          onClick={onScan}
          disabled={scanning}
        >
          {scanning ? 'Starting scan…' : 'Scan now'}
        </button>
      )}
    </div>
  )
}
