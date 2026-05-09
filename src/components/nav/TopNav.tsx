import { useLayoutEffect, useRef, useState } from 'react'
import type { Route } from '../../lib/router'
import { useNavTransition } from '../../lib/navTransition'
import './TopNav.css'

const PLEX_URL = 'http://theemeraldexchange.local:32400/web'

type NavRoute = Exclude<Route, 'home'>

const TABS: { route: NavRoute; label: string }[] = [
  { route: 'tv', label: 'TV' },
  { route: 'movies', label: 'Movies' },
  { route: 'downloads', label: 'Downloads' },
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
  const tabsRef = useRef<HTMLElement>(null)
  const tabRefs = useRef<Record<NavRoute, HTMLButtonElement | null>>({
    tv: null,
    movies: null,
    downloads: null,
  })
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null)

  useLayoutEffect(() => {
    const measure = () => {
      // Home isn't in the tab strip — hide the indicator there.
      if (active === 'home') {
        setIndicator(null)
        return
      }
      const el = tabRefs.current[active]
      const tabsEl = tabsRef.current
      if (!el || !tabsEl) return
      const tabRect = el.getBoundingClientRect()
      const tabsRect = tabsEl.getBoundingClientRect()
      setIndicator({
        left: tabRect.left - tabsRect.left + tabRect.width / 2 - 3,
        width: 6,
      })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [active])

  return (
    <header className="top-nav-wrap">
      <div className="top-nav" role="banner">
        <button
          type="button"
          className="top-nav__brand"
          aria-label="Emerald Exchange — home"
          onClick={() => navigate('home')}
        >
          <span className="top-nav__brand-mark">EMERALD</span>
          <span className="top-nav__brand-sub">EXCHANGE</span>
        </button>

        <span className="top-nav__divider" aria-hidden="true" />

        <nav className="top-nav__tabs" role="tablist" aria-label="Primary" ref={tabsRef}>
          {TABS.map((t) => (
            <button
              key={t.route}
              ref={(node) => {
                tabRefs.current[t.route] = node
              }}
              type="button"
              role="tab"
              aria-selected={active === t.route}
              tabIndex={active === t.route ? 0 : -1}
              className={`top-nav__tab${active === t.route ? ' top-nav__tab--active' : ''}`}
              onClick={() => transitionTo(t.route)}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
                e.preventDefault()
                const i = TABS.findIndex((x) => x.route === t.route)
                const next =
                  e.key === 'ArrowRight'
                    ? TABS[(i + 1) % TABS.length]
                    : TABS[(i - 1 + TABS.length) % TABS.length]
                transitionTo(next.route)
                tabRefs.current[next.route]?.focus()
              }}
            >
              {t.label}
            </button>
          ))}

          {indicator && (
            <span
              className="top-nav__indicator"
              style={{
                transform: `translateX(${indicator.left}px)`,
                width: `${indicator.width}px`,
              }}
              aria-hidden="true"
            />
          )}
        </nav>

        <span className="top-nav__divider" aria-hidden="true" />

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
      </div>
    </header>
  )
}
