import { apiUrl } from './base'
import { throwApiError } from './errors'

// The member's own watchlist (server/routes/watchlist.ts). Movies key by TMDB
// id and shows by TVDB id, as on Apple. Every write echoes the whole list back,
// newest first, so the client never needs a follow-up read.

export type WatchlistKind = 'movie' | 'tv'

export type WatchlistEntry = {
  kind: WatchlistKind
  id: number
  title: string
  /** Whatever poster the detail showed: an *arr URL or a bare TMDB path. */
  poster_path?: string
  added_at: string
}

async function send(method: 'GET' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<WatchlistEntry[]> {
  const res = await fetch(apiUrl(`/api/watchlist${path}`), {
    method,
    credentials: 'include',
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  if (!res.ok) await throwApiError(res, 'Watchlist')
  return ((await res.json()) as { items?: WatchlistEntry[] }).items ?? []
}

export type WatchlistToggle = {
  kind: WatchlistKind
  id: number
  title: string
  posterPath?: string
  /** True adds the title, false removes it. */
  on: boolean
}

export const watchlistApi = {
  list: () => send('GET', ''),
  toggle: (t: WatchlistToggle) =>
    t.on
      ? send('PUT', `/${t.kind}/${t.id}`, { title: t.title, poster_path: t.posterPath })
      : send('DELETE', `/${t.kind}/${t.id}`),
}

/** The list as it will read once `t` lands (the optimistic view). */
export function applyToggle(items: WatchlistEntry[], t: WatchlistToggle, now = new Date()): WatchlistEntry[] {
  const rest = items.filter((e) => !(e.kind === t.kind && e.id === t.id))
  if (!t.on) return rest
  return [{ kind: t.kind, id: t.id, title: t.title, poster_path: t.posterPath, added_at: now.toISOString() }, ...rest]
}
