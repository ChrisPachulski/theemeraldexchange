import { useNavTransition } from '../../lib/navTransition'
import './HomeNav.css'

// Minimal home-page chrome — no pill, no tab strip. Just the brand
// hyperlinked top-left and the Watch link top-right, both at the same
// top inset as the home entry buttons sit at the bottom inset.

const PLEX_URL = 'http://theemeraldexchange.local:32400/web'

function EmeraldGlyph() {
  return (
    <svg
      className="home-nav__watch-glyph"
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

export function HomeNav() {
  const { navigate } = useNavTransition()

  return (
    <>
      <button
        type="button"
        className="home-nav__brand"
        aria-label="Emerald Exchange — home"
        onClick={() => navigate('home')}
      >
        <span className="home-nav__brand-mark">EMERALD</span>
        <span className="home-nav__brand-sub">EXCHANGE</span>
      </button>

      <a
        href={PLEX_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="home-nav__watch"
        aria-label="Open Plex in a new tab"
      >
        <EmeraldGlyph />
        <span className="home-nav__watch-label">Watch</span>
        <span className="home-nav__watch-arrow" aria-hidden="true">{'->'}</span>
      </a>
    </>
  )
}
