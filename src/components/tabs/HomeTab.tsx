import { Suspense, lazy } from 'react'
import type { Route } from '../../lib/router'
import { useNavTransition } from '../../lib/navTransition'
import { useAuth } from '../../lib/auth'
import { isPlexUser } from '../../lib/hooks/usePlexLinks'
import { useLimits } from '../../lib/hooks/useLimits'
import { useRatingGate, useSectionAccess } from '../../lib/hooks/usePolicy'
import './HomeTab.css'

// Shelves pull in the suggestion strip, library and IPTV queries; lazy so the
// entry chunk stays the shell (see App.tsx).
const HomeShelves = lazy(() =>
  import('../home/HomeShelves').then((m) => ({ default: m.HomeShelves })),
)

type Entry = {
  route: Route
  label: string
  adminOnly?: boolean
  section?: 'live' | 'downloads'
  /** Default-off Limits key: shown only when the server reports that library. */
  library?: 'youtubeEnabled' | 'musicEnabled'
  /** Unrated catalog: hidden from rating-capped profiles (Apple MainView). */
  unrated?: boolean
}

const ENTRIES: Entry[] = [
  { route: 'tv', label: 'TV Shows' },
  { route: 'movies', label: 'Movies' },
  { route: 'youtube', label: 'YouTube', library: 'youtubeEnabled', unrated: true },
  { route: 'music', label: 'Music', library: 'musicEnabled' },
  { route: 'live', label: 'Live', section: 'live' },
  { route: 'downloads', label: 'Downloader', section: 'downloads' },
  // Plex-backed admin sessions only, as in TopNav.
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
    eyebrow: 'What it is',
    title: 'A private streaming library, just for your circle.',
    body:
      "The Emerald Exchange is an invitation-only movies-and-TV service for one household and the people they share with. Think of it as a personal Netflix that never drops titles; you decide what's in it, and it plays on any screen in the house.",
  },
  {
    eyebrow: 'How it works',
    title: 'Search, add, then watch.',
    steps: [
      'Open TV Shows or Movies and search by title.',
      'Click a result. For a movie, hit Add to library. For a show, hit Add. Season 1 starts monitored by default; admins can pick a later season in the dialog.',
      'The Emerald Exchange finds the best release with no quality settings to fuss with, and hands it to the downloader in the background.',
      'Check the Downloads tab to watch progress live. Single episodes and movies usually finish in minutes; a full TV season can take half an hour to an hour.',
      "When it's ready, open the title and hit Play: the new addition is available on every screen in the house.",
    ],
  },
]

// A Plex member can also watch in Plex itself, so their last step says so.
const PLEX_READY_STEP =
  "When it's ready, open the title and hit Play, or hit Watch up top to watch it in Plex (tell Plex on your device to rescan if it hasn't shown up yet)."

export function HomeTab() {
  const { transitionTo } = useNavTransition()
  const { isAdmin, user } = useAuth()
  const plexUser = isPlexUser(user)
  const plexAdmin = isAdmin && plexUser
  const sections = useSectionAccess()
  const ratingGate = useRatingGate()
  const limits = useLimits()
  const entries = ENTRIES.filter(
    (e) =>
      (!e.adminOnly || plexAdmin) &&
      (!e.section || sections[e.section]) &&
      (!e.unrated || !ratingGate.capped) &&
      (!e.library || limits.data?.[e.library] === true),
  )

  return (
    <section className="home" aria-label="Emerald Exchange home">
      <Suspense fallback={null}>
        <HomeShelves />
      </Suspense>
      <section className="home__about" aria-label="About the Exchange">
        {PANELS.map((p) => (
          <article key={p.eyebrow} className="home__panel">
            <span className="home__panel-eyebrow">{p.eyebrow}</span>
            <h2 className="home__panel-title">{p.title}</h2>
            {p.body && <p className="home__panel-body">{p.body}</p>}
            {p.steps && (
              <ol className="home__panel-steps">
                {(plexUser ? [...p.steps.slice(0, -1), PLEX_READY_STEP] : p.steps).map((s, i) => (
                  <li key={i} className="home__panel-step">
                    <span className="home__panel-step-num">{i + 1}</span>
                    <span className="home__panel-step-body">{s}</span>
                  </li>
                ))}
              </ol>
            )}
          </article>
        ))}
      </section>

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
