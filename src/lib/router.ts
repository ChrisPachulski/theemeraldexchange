import { useEffect, useState } from 'react'

export type Route = 'home' | 'tv' | 'movies' | 'downloads' | 'users'

const ROUTES: Route[] = ['home', 'tv', 'movies', 'downloads', 'users']
const DEFAULT_ROUTE: Route = 'home'

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '').trim().toLowerCase()
  return (ROUTES as string[]).includes(raw) ? (raw as Route) : DEFAULT_ROUTE
}

export function useRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(parseHash)

  useEffect(() => {
    const onChange = () => setRoute(parseHash())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const navigate = (next: Route) => {
    if (next === route) return
    window.location.hash = `#/${next}`
  }

  return [route, navigate]
}
