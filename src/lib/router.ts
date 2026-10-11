import { useEffect, useEffectEvent, useState } from 'react'

export type Route = 'home' | 'tv' | 'movies' | 'downloads' | 'users' | 'live'

const ROUTES: Route[] = ['home', 'tv', 'movies', 'live', 'downloads', 'users']
const DEFAULT_ROUTE: Route = 'home'

// `#/<tab>/<ref>` asks that tab to open one item, so any surface (Home shelves,
// Downloads, a person's filmography) can land on a specific title instead of
// just the tab. Refs: movies = Radarr id or `tmdb:N`; tv = Sonarr id, `tvdb:N`
// or `tmdb:N`; live = stream id. The tab consumes it once (useIntent).
export type IntentRoute = 'movies' | 'tv' | 'live'
const INTENT = /^(movies|tv|live)\/((?:tmdb:|tvdb:)?\d+)$/

function rawHash(): string {
  return window.location.hash.replace(/^#\/?/, '').trim().toLowerCase()
}

// ponytail: parseHash/nextHash/takeIntent are exported for the node-env unit
// tests (no renderer, so useRoute itself can't be exercised); useRoute and
// useIntent are the only production callers.
export function parseHash(): Route {
  const raw = rawHash()
  if ((ROUTES as string[]).includes(raw)) return raw as Route
  return (INTENT.exec(raw)?.[1] as Route | undefined) ?? DEFAULT_ROUTE
}

export function nextHash(current: Route, next: Route): string | null {
  return next === current ? null : `#/${next}`
}

/** Navigate to `route` and have it open `ref` (see INTENT). */
export function openIntent(route: IntentRoute, ref: string | number) {
  window.location.hash = `#/${route}/${ref}`
}

/** Read and clear a pending intent for `route`. Clearing (replaceState fires no
 *  hashchange) means a reload doesn't reopen it and a repeat open of the same
 *  title is a real hash change. */
export function takeIntent(route: IntentRoute): string | null {
  const m = INTENT.exec(rawHash())
  if (!m || m[1] !== route) return null
  window.history.replaceState(window.history.state, '', `#/${route}`)
  return m[2]
}

/** Hand each intent for `route` to `onIntent`, waiting until `ready` (e.g. the
 *  library the ref resolves against has loaded). */
export function useIntent(route: IntentRoute, ready: boolean, onIntent: (ref: string) => void) {
  const [hashTick, setHashTick] = useState(0)
  const handle = useEffectEvent(onIntent)
  useEffect(() => {
    const bump = () => setHashTick((t) => t + 1)
    window.addEventListener('hashchange', bump)
    return () => window.removeEventListener('hashchange', bump)
  }, [])
  useEffect(() => {
    if (!ready) return
    const ref = takeIntent(route)
    if (ref !== null) handle(ref)
  }, [route, ready, hashTick])
}

export function useRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(parseHash)

  useEffect(() => {
    const onChange = () => setRoute(parseHash())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const navigate = (next: Route) => {
    const target = nextHash(route, next)
    if (target !== null) window.location.hash = target
  }

  return [route, navigate]
}
