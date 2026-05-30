import { useRef } from 'react'
import type { Route } from '../../lib/router'
import { useNavTransition } from '../../lib/navTransition'
import { useAuth } from '../../lib/auth'
import { useLimits } from '../../lib/hooks/useLimits'
import { UserMenu } from '../auth/UserMenu'
import { EmeraldMark } from '../atmosphere/EmeraldMark'
import './TopNav.css'

// app.plex.tv is Plex's hosted web client — works on AND off network.
// The LAN URL (http://theemeraldexchange.local:32400/web) was mDNS-only
// and broke for every household member outside the house.
const PLEX_URL = 'https://app.plex.tv/desktop'

type NavRoute = Exclude<Route, 'home'>

type Tab = {
  route: NavRoute
  label: string
  adminOnly?: boolean
  iptv?: boolean
  media?: boolean
}

const TABS: Tab[] = [
  { route: 'tv', label: 'TV Shows' },
  { route: 'movies', label: 'Movies' },
  // M3 media-core Library tab — intentionally NOT surfaced in nav yet. The
  // /media route + backend stay wired (USE_MEDIA_CORE) for continued M3 dev,
  // but the tab is hidden from prod until the milestone is signed off.
  // To re-enable: { route: 'media', label: 'Media', media: true },
  // `iptv: true` hides the tab when the server boots with IPTV_DISABLED=1
  // (contract §13.3 reviewer-insurance gate).
  { route: 'live', label: 'Live', iptv: true },
  { route: 'downloads', label: 'Downloads' },
  { route: 'users', label: 'Users', adminOnly: true },
]

const ROUTE_LABEL: Record<NavRoute, string> = {
  tv: 'TV Shows',
  movies: 'Movies',
  media: 'Media',
  live: 'Live',
  downloads: 'Downloads',
  users: 'Users',
}


type Props = {
  active: Route
}

export function TopNav({ active }: Props) {
  const { transitionTo, navigate } = useNavTransition()
  const { isAdmin } = useAuth()
  const limits = useLimits()
  const iptvEnabled = limits.data?.iptvEnabled !== false // default true on older backends
  const mediaEnabled = limits.data?.mediaEnabled !== false // default true on older backends
  const tabRefs = useRef<Record<NavRoute, HTMLButtonElement | null>>({
    tv: null,
    movies: null,
    media: null,
    live: null,
    downloads: null,
    users: null,
  })
  const visibleTabs = TABS.filter(
    (t) =>
      (!t.adminOnly || isAdmin) &&
      (!t.iptv || iptvEnabled) &&
      (!t.media || mediaEnabled) &&
      t.route !== active,
  )

  return (
    <>
      <div className="top-nav__brand-stack">
        <button
          type="button"
          className="top-nav__brand"
          aria-label="Emerald Exchange — home"
          onClick={() => navigate('home')}
        >
          <EmeraldMark width={26} variant="single" className="top-nav__brand-gems" />
          <span className="top-nav__brand-mark">EMERALD</span>
          <span className="top-nav__brand-sub">EXCHANGE</span>
        </button>
        {/* Quiet "you are here" label so the active-tab pill can stay
            removed without losing wayfinding. Sits under EXCHANGE so it
            doesn't compete with the centered nav. */}
        {active !== 'home' && (
          <span className="top-nav__here">{ROUTE_LABEL[active as NavRoute]}</span>
        )}
      </div>

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
          <EmeraldMark width={18} variant="single" className="top-nav__watch-glyph" />
          <span className="top-nav__watch-label">Watch</span>
          <span className="top-nav__watch-arrow" aria-hidden="true">{'->'}</span>
        </a>
        <UserMenu />
      </div>
    </>
  )
}
