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

type Panel = { eyebrow: string; title: string; body: string }

const PANELS: Panel[] = [
  {
    eyebrow: 'What it is',
    title: 'A private streaming library, just for your circle.',
    body:
      "The Emerald Exchange is an invitation-only movies-and-TV service for one household and the people they share with. Think of it as a personal Netflix that never drops titles — you decide what's in it, and Plex plays it on any screen in the house.",
  },
  {
    eyebrow: 'How it works',
    title: 'Find a title, click Add, watch it on Plex.',
    body:
      "Search any movie or show by name. One click queues it up. The site fetches it, organizes it, and hands it off to Plex in the background — usually minutes for an episode, an hour or two for a film. No quality settings to wrestle with; sensible defaults are baked in.",
  },
  {
    eyebrow: 'Getting in',
    title: 'Sign in with Plex to start.',
    body:
      "Access is by Plex invitation only — sign in with the account that's been shared with the household library. From there, Watch opens the Plex player, the Downloads tab shows what's on the way, and everything else stays out of your way.",
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
              <p className="home__panel-body">{p.body}</p>
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
