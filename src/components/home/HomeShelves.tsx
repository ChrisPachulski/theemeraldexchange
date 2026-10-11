import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { TrendingRow } from '../search/TrendingRow'
import { openIntent } from '../../lib/router'
import { useNavTransition } from '../../lib/navTransition'
import { useLimits } from '../../lib/hooks/useLimits'
import { useRatingGate, useSectionAccess } from '../../lib/hooks/usePolicy'
import { useRadarrLibrary } from '../../lib/hooks/useRadarrLibrary'
import { useSonarrLibrary } from '../../lib/hooks/useSonarrLibrary'
import { pickPoster, useRecentlyAdded } from '../../lib/hooks/useRecentlyAdded'
import { resumePosition, useMediaWatch } from '../../lib/hooks/useMediaLibrary'
import { useSuggestionStrip } from '../../lib/hooks/useSuggestionStrip'
import { useIptvFavoriteSet } from '../../lib/hooks/useIptvFavorites'
import { useIptvEpgNow } from '../../lib/hooks/useIptvEpg'
import { useWatchlist } from '../../lib/hooks/useWatchlist'
import { postClickEvent } from '../../lib/api/recommenderEvents'
import type { WatchEntry } from '../../lib/api/media'
import {
  TMDB_POSTER_BASE,
  airingNow,
  continueWatching,
  episodeLabel,
  resumeTitle,
  timeLeft,
  titleKey,
  watchlistIntent,
  watchlistPoster,
} from './shelves'

// The player only loads once something is resumed.
const MediaPlayer = lazy(() =>
  import('../media/MediaPlayer').then((m) => ({ default: m.MediaPlayer })),
)

const RECENT_PER_KIND = 10

type Card = {
  key: string
  title: string
  meta?: string | null
  poster?: string | null
  /** 0..1 watched, for a resume card. */
  progress?: number | null
  onOpen: () => void
}

// A labelled poster row in the suggestion strip's card style. Renders nothing
// when empty unless it has empty-state copy.
function PosterShelf({ label, cards, empty }: { label: string; cards: Card[]; empty?: string }) {
  if (cards.length === 0 && !empty) return null
  return (
    <section className="trending" aria-label={label}>
      <div className="trending__header">
        <h3 className="trending__label">{label}</h3>
      </div>
      {cards.length === 0 ? (
        <p className="trending__empty-hint">{empty}</p>
      ) : (
        <div className="trending__row">
          {cards.map((c) => (
            <div key={c.key} className="trending__card-wrap">
              <button type="button" className="trending__card" onClick={c.onOpen} title={c.title}>
                {c.poster ? (
                  <img
                    className="trending__poster"
                    src={c.poster}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="trending__poster trending__poster--fallback" aria-hidden="true">
                    {c.title.charAt(0)}
                  </div>
                )}
                {c.progress != null && (
                  <span className="home-shelf__progress" aria-hidden="true">
                    <span style={{ width: `${Math.round(c.progress * 100)}%` }} />
                  </span>
                )}
                <div className="trending__caption">
                  <span className="trending__title">{c.title}</span>
                  {c.meta && <span className="trending__year">{c.meta}</span>}
                </div>
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

type Library = {
  title: string
  certification?: string | null
  images?: Array<{ coverType: string; remoteUrl?: string; url?: string }>
}

function posterIndex(items: Library[] | undefined): Map<string, string> {
  const map = new Map<string, string>()
  for (const item of items ?? []) {
    const poster = pickPoster(item.images)
    if (poster) map.set(titleKey(item.title), poster)
  }
  return map
}

// Library certification by normalized title: watch rows carry no rating, so a
// capped profile matches them to the *arr entry (no match fails closed).
function certIndex(items: Library[] | undefined): Map<string, string | null | undefined> {
  return new Map((items ?? []).map((item) => [titleKey(item.title), item.certification]))
}

// In-progress movies and episodes; a click resumes playback straight away.
function ContinueWatchingShelf({ movies, shows }: { movies?: Library[]; shows?: Library[] }) {
  const watch = useMediaWatch(true)
  const ratingGate = useRatingGate()
  const [playing, setPlaying] = useState<WatchEntry | null>(null)
  const moviePosters = useMemo(() => posterIndex(movies), [movies])
  const showPosters = useMemo(() => posterIndex(shows), [shows])
  const movieCerts = useMemo(() => certIndex(movies), [movies])
  const showCerts = useMemo(() => certIndex(shows), [shows])
  const rows = useMemo(
    () =>
      continueWatching(watch.data?.values() ?? []).filter(
        (r) =>
          !ratingGate.capped ||
          ratingGate.allows((r.mediaKind === 'movie' ? movieCerts : showCerts).get(titleKey(resumeTitle(r)))),
      ),
    [watch.data, ratingGate, movieCerts, showCerts],
  )
  if (watch.isPending || watch.error) return null

  const cards: Card[] = rows.map((r) => {
    const title = resumeTitle(r)
    const arr = (r.mediaKind === 'movie' ? moviePosters : showPosters).get(titleKey(title))
    return {
      key: `${r.mediaKind}:${r.mediaId}`,
      title,
      meta: episodeLabel(r),
      poster: arr ?? (r.posterPath ? `${TMDB_POSTER_BASE}${r.posterPath}` : null),
      progress: r.durationSecs ? Math.min(1, r.positionSecs / r.durationSecs) : null,
      onOpen: () => setPlaying(r),
    }
  })

  return (
    <>
      <PosterShelf label="Continue watching" cards={cards} empty="Nothing to jump back into yet" />
      {playing && (
        <Suspense fallback={null}>
          <MediaPlayer
            key={`${playing.mediaKind}:${playing.mediaId}`}
            kind={playing.mediaKind}
            id={playing.mediaId}
            title={[resumeTitle(playing), episodeLabel(playing)].filter(Boolean).join(' · ')}
            startPositionSecs={resumePosition(playing)}
            autoResume
            onClose={() => setPlaying(null)}
          />
        </Suspense>
      )}
    </>
  )
}

// The tabs' suggestion strip (same session-cached lineup); a pick opens the
// title in its tab, which resolves it library-first like its own strip does.
function PicksShelf({ kind, libraryTmdbIds }: { kind: 'movie' | 'tv'; libraryTmdbIds: ReadonlySet<number> }) {
  const strip = useSuggestionStrip(kind, libraryTmdbIds)
  const s = strip.suggested
  const picked = strip.label === 'Picked for you'
  const label =
    kind === 'movie'
      ? picked ? 'Movies picked for you' : 'Trending movies this week'
      : picked ? 'Shows picked for you' : 'Trending shows this week'
  return (
    <TrendingRow
      items={strip.items}
      loading={s.isPending}
      error={s.error}
      source={s.data?.source ?? null}
      diag={s.data?.diag ?? null}
      onPick={(tmdbId) => {
        postClickEvent(kind, tmdbId)
        openIntent(kind === 'movie' ? 'movies' : 'tv', `tmdb:${tmdbId}`)
      }}
      label={label}
      onRefresh={strip.refresh}
      refreshing={s.isFetching}
      feedback={strip.feedback}
      mode={strip.mode}
    />
  )
}

// What the member's favourite channels are airing now, plus a way into the guide.
function LiveNowShelf() {
  const { transitionTo } = useNavTransition()
  const favs = useIptvFavoriteSet()
  const ids = useMemo(
    () => [...favs].flatMap((k) => (k.startsWith('live:') ? [Number(k.slice(5))] : [])),
    [favs],
  )
  const epg = useIptvEpgNow(ids)
  // Re-derive "time left" (and roll to the next programme) every minute.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])
  const airing = airingNow(epg.data ?? [], nowMs)

  return (
    <section className="trending" aria-label="On now">
      <div className="trending__header">
        <h3 className="trending__label">On now</h3>
      </div>
      <div className="trending__row">
        <button
          type="button"
          className="home-live-tile home-live-tile--guide"
          onClick={() => transitionTo('live')}
        >
          Channel guide
        </button>
        {airing.map((a) => (
          <button
            key={a.streamId}
            type="button"
            className="home-live-tile"
            onClick={() => openIntent('live', a.streamId)}
          >
            <strong className="iptv-prog-results__live">LIVE</strong>
            <span className="home-live-tile__title">{a.programme.title?.trim() || 'Live TV'}</span>
            <span className="home-live-tile__caption">On now · {timeLeft(a.stopMs, nowMs)} left</span>
            <span className="home-shelf__progress" aria-hidden="true">
              <span style={{ width: `${Math.round(((nowMs - a.startMs) / (a.stopMs - a.startMs)) * 100)}%` }} />
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

// Home's content shelves (Apple HomeScreen order). Each one gates on the
// service it opens into, matching the tab gates in App.
export function HomeShelves() {
  const limits = useLimits()
  const mediaEnabled = limits.data?.mediaEnabled !== false
  const radarrEnabled = limits.data?.radarrEnabled !== false
  const sonarrEnabled = limits.data?.sonarrEnabled !== false
  const iptvEnabled = limits.data?.iptvEnabled !== false
  const sections = useSectionAccess()
  const ratingGate = useRatingGate()
  const movies = useRadarrLibrary()
  const shows = useSonarrLibrary()
  const recent = useRecentlyAdded(Infinity)
  const certById = useMemo(
    () => ({
      movie: new Map((movies.data ?? []).map((m) => [m.id, m.certification])),
      tv: new Map((shows.data ?? []).map((s) => [s.id, s.certification])),
    }),
    [movies.data, shows.data],
  )
  // Watchlist rows carry no rating: a capped profile matches them to the
  // library by the id they store (not in the library fails closed).
  const watchlist = useWatchlist()
  const certByWatchId = useMemo(
    () => ({
      movie: new Map((movies.data ?? []).map((m) => [m.tmdbId, m.certification])),
      tv: new Map((shows.data ?? []).map((s) => [s.tvdbId, s.certification])),
    }),
    [movies.data, shows.data],
  )
  const watchlistCards: Card[] = (watchlist.data ?? [])
    .filter(
      (e) =>
        (e.kind === 'movie' ? radarrEnabled : sonarrEnabled) &&
        ratingGate.allows(certByWatchId[e.kind].get(e.id)),
    )
    .map((e) => ({
      key: `${e.kind}:${e.id}`,
      title: e.title,
      poster: watchlistPoster(e.poster_path),
      onOpen: () => openIntent(...watchlistIntent(e)),
    }))

  const recentCards = (kind: 'movie' | 'tv'): Card[] =>
    recent
      .filter((r) => r.kind === kind && ratingGate.allows(certById[kind].get(r.id)))
      .slice(0, RECENT_PER_KIND)
      .map((r) => ({
        key: r.key,
        title: r.title,
        meta: r.year ? String(r.year) : null,
        poster: r.poster,
        onOpen: () => openIntent(r.route, r.id),
      }))
  const movieTmdbIds = useMemo(() => new Set((movies.data ?? []).map((m) => m.tmdbId)), [movies.data])
  const showTmdbIds = useMemo(
    () => new Set((shows.data ?? []).flatMap((s) => (typeof s.tmdbId === 'number' && s.tmdbId > 0 ? [s.tmdbId] : []))),
    [shows.data],
  )

  return (
    <div className="home__shelves">
      {mediaEnabled && <ContinueWatchingShelf movies={movies.data} shows={shows.data} />}
      <PosterShelf label="Watchlist" cards={watchlistCards} />
      {radarrEnabled && <PosterShelf label="Recently added movies" cards={recentCards('movie')} />}
      {sonarrEnabled && <PosterShelf label="Recently added shows" cards={recentCards('tv')} />}
      {iptvEnabled && sections.live && <LiveNowShelf />}
      {/* Suggestions are unrated picks: withheld under a rating cap, as on Apple. */}
      {sonarrEnabled && !ratingGate.capped && <PicksShelf kind="tv" libraryTmdbIds={showTmdbIds} />}
      {radarrEnabled && !ratingGate.capped && <PicksShelf kind="movie" libraryTmdbIds={movieTmdbIds} />}
    </div>
  )
}
