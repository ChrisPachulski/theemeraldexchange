import type { WatchEntry } from '../../lib/api/media'
import type { EpgNowRow, EpgProgrammeDto } from '../../lib/api/iptv'
import type { WatchlistEntry } from '../../lib/api/watchlist'
import type { IntentRoute } from '../../lib/router'

// Pure selectors behind the Home shelves (Apple HomeScreen.swift parity).

export const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w342'

/** In-progress titles, newest first, capped (Apple's resume shelf). */
export function continueWatching(rows: Iterable<WatchEntry>, cap = 20): WatchEntry[] {
  return [...rows]
    // Movies and episodes only (Apple's shelf): YouTube and music rows share the watch map.
    .filter((r) => (r.mediaKind === 'movie' || r.mediaKind === 'episode') && !r.completed && r.positionSecs > 0)
    .sort((a, b) => b.watchedAt.localeCompare(a.watchedAt))
    .slice(0, cap)
}

/** Card title: the show for an episode, else the movie. */
export function resumeTitle(r: WatchEntry): string {
  return r.mediaKind === 'episode' ? (r.showTitle ?? r.title ?? 'Episode') : (r.title ?? 'Movie')
}

/** "S1 · E2" for an episode row, else null. */
export function episodeLabel(r: WatchEntry): string | null {
  return r.mediaKind === 'episode' && r.season != null && r.episode != null
    ? `S${r.season} · E${r.episode}`
    : null
}

/** Library join key for a resume row's title: case, accents and punctuation
 *  blind, "&" = "and", a trailing year dropped. The row's own TMDB poster can
 *  be a wrong match, so Home prefers the Sonarr/Radarr art the tabs show. */
export function titleKey(title: string): string {
  const parts = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  if (parts.length > 1 && /^(19|20)\d\d$/.test(parts[parts.length - 1])) parts.pop()
  return parts.join(' ')
}

/** Where a Watchlist row opens: its tab, by the id the row stores (TMDB for a
 *  movie, TVDB for a show). The tab resolves it library-first. */
export function watchlistIntent(e: Pick<WatchlistEntry, 'kind' | 'id'>): [IntentRoute, string] {
  return e.kind === 'movie' ? ['movies', `tmdb:${e.id}`] : ['tv', `tvdb:${e.id}`]
}

/** A Watchlist row's poster: an *arr URL as stored, or a bare TMDB path. */
export function watchlistPoster(path: string | undefined): string | null {
  if (!path) return null
  return path.startsWith('http') ? path : `${TMDB_POSTER_BASE}${path}`
}

export type Airing = {
  streamId: number
  channelName: string | null
  channelIcon: string | null
  programme: EpgProgrammeDto
  startMs: number
  stopMs: number
}

/** Each channel's programme on air at `nowMs`: `current`, or `next` once the
 *  cached `current` has ended, so the row stays right between refetches. */
export function airingNow(rows: EpgNowRow[], nowMs: number): Airing[] {
  const out: Airing[] = []
  for (const row of rows) {
    for (const programme of [row.current, row.next]) {
      if (!programme) continue
      const startMs = Date.parse(programme.start_utc)
      const stopMs = Date.parse(programme.stop_utc)
      if (startMs <= nowMs && nowMs < stopMs) {
        out.push({
          streamId: row.channel_stream_id,
          channelName: row.name || null,
          channelIcon: row.stream_icon || null,
          programme,
          startMs,
          stopMs,
        })
        break
      }
    }
  }
  return out
}

/** "12m" / "1h 5m" left, never under a minute. */
export function timeLeft(stopMs: number, nowMs: number): string {
  const m = Math.max(1, Math.floor((stopMs - nowMs) / 60_000))
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}
