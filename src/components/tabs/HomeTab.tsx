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
    title: 'One bookmark for the household.',
    body:
      "A single quiet surface for finding a show, adding a movie, peeking at the queue, and stepping through to Plex. The stack of operator tools that powers it stays out of sight — useful when something needs operating, invisible when you're just here to watch.",
  },
  {
    eyebrow: 'What you do',
    title: 'Search is the verb.',
    body:
      "Open TV Shows or Movies, type the name, hit Add. Smart defaults pre-fill quality, folder, and what to monitor, so the happy path is one click. Size caps are enforced underneath — 10 GB for a movie, 5 GB per episode — so a careless add can't take down the library.",
  },
  {
    eyebrow: 'What you see',
    title: 'The queue is always open.',
    body:
      "Downloads update live, so you can watch a release land, cancel one in flight, or just confirm tonight's episode is on the way. When it lands in Plex, Watch is the only button you need.",
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
