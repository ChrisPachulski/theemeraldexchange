import { useEffect, useState } from 'react'

export type Route = 'home' | 'tv' | 'movies' | 'downloads' | 'users' | 'live'

const ROUTES: Route[] = ['home', 'tv', 'movies', 'live', 'downloads', 'users']
const DEFAULT_ROUTE: Route = 'home'

export function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '').trim().toLowerCase()
  return (ROUTES as string[]).includes(raw) ? (raw as Route) : DEFAULT_ROUTE
}

export function nextHash(current: Route, next: Route): string | null {
  return next === current ? null : `#/${next}`
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
