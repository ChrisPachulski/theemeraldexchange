import type { Route } from '../../lib/router'
import { useNavTransition } from '../../lib/navTransition'
import { useAuth } from '../../lib/auth'
import './HomeTab.css'

type Entry = { route: Route; label: string; adminOnly?: boolean }

const ENTRIES: Entry[] = [
  { route: 'tv', label: 'TV Shows' },
  { route: 'movies', label: 'Movies' },
  { route: 'downloads', label: 'Downloader' },
  { route: 'users', label: 'Users', adminOnly: true },
]

export function HomeTab() {
  const { transitionTo } = useNavTransition()
  const { isAdmin } = useAuth()
  const entries = ENTRIES.filter((e) => !e.adminOnly || isAdmin)

  return (
    <section className="home" aria-label="Emerald Exchange home">
      <div className="home__entries" role="navigation" aria-label="Sections">
        {entries.map((e) => (
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
