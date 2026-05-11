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

type Panel = {
  eyebrow: string
  title: string
  /** Single-paragraph copy. Mutually exclusive with `steps`. */
  body?: string
  /** Ordered list rendered as numbered steps. */
  steps?: string[]
}

const PANELS: Panel[] = [
  {
    eyebrow: 'Getting in',
    title: 'Sign in with Plex to start.',
    body:
      "Access is by Plex invitation only — sign in with the same Plex account that's been shared the household library. After that, the dashboard remembers you. Watch opens the Plex player, Downloads shows what's on the way, and everything else stays out of your way.",
  },
  {
    eyebrow: 'What it is',
    title: 'A private streaming library, just for your circle.',
    body:
      "The Emerald Exchange is an invitation-only movies-and-TV service for one household and the people they share with. Think of it as a personal Netflix that never drops titles — you decide what's in it, and Plex plays it on any screen in the house.",
  },
  {
    eyebrow: 'How it works',
    title: 'Search, add, then watch on Plex.',
    steps: [
      'Open TV Shows or Movies and search by title.',
      'Click a result. For a movie, hit Add to library. For a show, pick the season you want and add — Season 1 by default, or pick any later season individually.',
      'The Emerald Exchange finds the best release under the household size cap (10 GB per movie, 5 GB per episode), no quality settings to fuss with, and hands it to the downloader in the background.',
      'Check the Downloads tab to watch progress live. Episodes usually finish in minutes; a film takes an hour or two depending on size.',
      "When it's ready, hit Watch up top — your new addition is already in Plex, on every screen in the house.",
    ],
  },
]

function ChevronDown() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}

export function HomeTab() {
  const { transitionTo } = useNavTransition()
  const { isAdmin } = useAuth()
  const entries = ENTRIES.filter((e) => !e.adminOnly || isAdmin)

  return (
    <section className="home" aria-label="Emerald Exchange home">
      <div className="home__hero" aria-hidden="true">
        <div className="home__scroll-hint">
          <span className="home__scroll-label">Read on</span>
          <ChevronDown />
        </div>
      </div>

      <div className="home__about" aria-label="About the Exchange">
        {PANELS.map((p) => (
          <article key={p.eyebrow} className="home__panel">
            <div className="home__panel-inner">
              <span className="home__panel-eyebrow">{p.eyebrow}</span>
              <h2 className="home__panel-title">{p.title}</h2>
              {p.body && <p className="home__panel-body">{p.body}</p>}
              {p.steps && (
                <ol className="home__panel-steps">
                  {p.steps.map((s, i) => (
                    <li key={i} className="home__panel-step">
                      <span className="home__panel-step-num">{i + 1}</span>
                      <span className="home__panel-step-body">{s}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </article>
        ))}
        <div className="home__about-floor" aria-hidden="true" />
      </div>

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
