import type { Route } from '../../lib/router'
import { useNavTransition } from '../../lib/navTransition'
import './HomeTab.css'

const ENTRIES: { route: Route; label: string }[] = [
  { route: 'tv', label: 'TV' },
  { route: 'movies', label: 'Movies' },
  { route: 'downloads', label: 'Downloader' },
]

export function HomeTab() {
  const { transitionTo } = useNavTransition()

  return (
    <section className="home" aria-label="Emerald Exchange home">
      <div className="home__entries" role="navigation" aria-label="Sections">
        {ENTRIES.map((e) => (
          <button
            key={e.route}
            type="button"
            className="home__entry"
            onClick={() => transitionTo(e.route)}
          >
            {e.label}
          </button>
        ))}
      </div>
    </section>
  )
}
