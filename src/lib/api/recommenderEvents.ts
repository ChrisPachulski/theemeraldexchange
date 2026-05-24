import { apiUrl } from './base'

// Fire-and-forget mirror to /api/recommender/event for client-side
// conversion signals. Currently only 'clicked' lives here — added /
// like / dislike / reject have their own dedicated paths. Errors are
// intentionally swallowed: the optimizer can tolerate a missed signal,
// but a thrown promise here would surface as a toast/console error on
// every card click and pollute the UX. The server route already 400s
// malformed bodies, so a network blip is the only realistic failure
// mode.
export function postClickEvent(kind: 'movie' | 'tv', tmdbId: number): void {
  void fetch(apiUrl('/api/recommender/event'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, tmdbId, signal: 'clicked' }),
  }).catch(() => {})
}
