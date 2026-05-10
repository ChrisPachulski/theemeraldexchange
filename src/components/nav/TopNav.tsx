import { useRef } from 'react'
import type { Route } from '../../lib/router'
import { useNavTransition } from '../../lib/navTransition'
import { useAuth } from '../../lib/auth'
import { UserMenu } from '../auth/UserMenu'
import './TopNav.css'

const PLEX_URL = 'http://theemeraldexchange.local:32400/web'

type NavRoute = Exclude<Route, 'home'>

type Tab = { route: NavRoute; label: string; adminOnly?: boolean }

const TABS: Tab[] = [
  { route: 'tv', label: 'TV Shows' },
  { route: 'movies', label: 'Movies' },
  { route: 'downloads', label: 'Downloads' },
  { route: 'users', label: 'Users', adminOnly: true },
]

// Emerald-cut gem glyph for the Watch label. Filled with currentColor so the
// CSS class chooses the hue. The two thin strokes are facet hints — at small
// sizes they read as depth without becoming busy.
function EmeraldGlyph() {
  return (
    <svg
      className="top-nav__watch-glyph"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
    >
      <path d="M5 2 L11 2 L14 5 L11 14 L5 14 L2 5 Z" fill="currentColor" />
      <path
        d="M2 5 L14 5 M5 2 L8 5 L11 2 M8 5 L8 14"
        stroke="rgba(0,0,0,0.32)"
        strokeWidth="0.5"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  )
}

type Props = {
  active: Route
}

export function TopNav({ active }: Props) {
  const { transitionTo, navigate } = useNavTransition()
  const { isAdmin } = useAuth()
  const tabRefs = useRef<Record<NavRoute, HTMLButtonElement | null>>({
    tv: null,
    movies: null,
    downloads: null,
    users: null,
  })
  const visibleTabs = TABS.filter((t) => (!t.adminOnly || isAdmin) && t.route !== active)

  return (
    <>
      <button
        type="button"
        className="top-nav__brand"
        aria-label="Emerald Exchange — home"
        onClick={() => navigate('home')}
      >
        <span className="top-nav__brand-mark">EMERALD</span>
        <span className="top-nav__brand-sub">EXCHANGE</span>
      </button>

      <nav className="top-nav__tabs" role="tablist" aria-label="Primary">
        {/* Hide the current tab — sitting on TV Shows means the only
            navigation actions are Movies / Downloads / (Users for admins).
            The pill for the page you're already on is wasted space. */}
        {visibleTabs.map((t) => (
          <button
            key={t.route}
            ref={(node) => {
              tabRefs.current[t.route] = node
            }}
            type="button"
            role="tab"
            tabIndex={0}
            className="top-nav__tab"
            onClick={() => transitionTo(t.route)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
              if (visibleTabs.length < 2) return
              e.preventDefault()
              const i = visibleTabs.findIndex((x) => x.route === t.route)
              const next =
                e.key === 'ArrowRight'
                  ? visibleTabs[(i + 1) % visibleTabs.length]
                  : visibleTabs[(i - 1 + visibleTabs.length) % visibleTabs.length]
              tabRefs.current[next.route]?.focus()
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="top-nav__right">
        <a
          href={PLEX_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="top-nav__watch"
          aria-label="Open Plex in a new tab"
        >
          <EmeraldGlyph />
          <span className="top-nav__watch-label">Watch</span>
          <span className="top-nav__watch-arrow" aria-hidden="true">{'->'}</span>
        </a>
        <UserMenu />
      </div>
    </>
  )
}
