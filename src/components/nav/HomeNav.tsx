import { useNavTransition } from '../../lib/navTransition'
import { UserMenu } from '../auth/UserMenu'
import { EmeraldMark } from '../atmosphere/EmeraldMark'
import './HomeNav.css'

// Minimal home-page chrome — brand top-left, Watch/UserMenu top-right.
// Section entries (including admin-only Users) live in HomeTab so they
// sit at the bottom alongside the other entry buttons, mirroring the
// floor row pattern.

// app.plex.tv is Plex's hosted web client — works on AND off network.
// The LAN URL (http://theemeraldexchange.local:32400/web) was mDNS-only
// and broke for every household member outside the house.
const PLEX_URL = 'https://app.plex.tv/desktop'

export function HomeNav() {
  const { navigate } = useNavTransition()

  return (
    <>
      <button
        type="button"
        className="home-nav__brand"
        aria-label="Emerald Exchange home"
        onClick={() => navigate('home')}
      >
        <EmeraldMark width={28} variant="single" className="home-nav__brand-gems" />
        <span className="home-nav__brand-mark">EMERALD</span>
        <span className="home-nav__brand-sub">EXCHANGE</span>
      </button>

      <div className="home-nav__right">
        <a
          href={PLEX_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="home-nav__watch"
          aria-label="Open Plex in a new tab"
        >
          <EmeraldMark width={18} variant="single" className="home-nav__watch-glyph" />
          <span className="home-nav__watch-label">Watch</span>
          <span className="home-nav__watch-arrow" aria-hidden="true">{'->'}</span>
        </a>
        <UserMenu />
      </div>
    </>
  )
}
