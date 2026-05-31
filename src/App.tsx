import { Suspense, lazy, useEffect } from 'react'
import { TopNav } from './components/nav/TopNav'
import { HomeNav } from './components/nav/HomeNav'
import { HomeTab } from './components/tabs/HomeTab'
import { Kraken } from './components/atmosphere/Kraken'
import { LoadingPulse } from './components/feedback/LoadingPulse'
import { useRoute, type Route } from './lib/router'
import { NavTransitionProvider } from './lib/navTransition'
import { ReplayButton } from './components/nav/ReplayButton'
import { AuthProvider, useAuth } from './lib/auth'
import { useLimits } from './lib/hooks/useLimits'
// View Transitions cross-fade + persistent-shell view-transition-names.
// Imported here (always-mounted root) so the ::view-transition rules and
// the nav/dock view-transition-names are available no matter which tab is
// active. The actual startViewTransition() calls live in the in-tab
// mode/filter swaps (TvTab, MediaTab, LibraryFilters); the top-level tab
// nav keeps its dedicated video-splice flourish (navTransition.tsx).
import './styles/transitions.css'

// Non-home tabs are lazy-loaded so the initial JS bundle ships only the
// always-visible shell (Kraken atmosphere, nav, brand mark, HomeTab) plus
// three.js / react-dom. Each non-home tab pulls in its own modals
// (DetailModal, AddSeries/MovieModal) transitively, so visiting `/tv` for
// the first time downloads the tv chunk including its modal subtree, etc.
const TvTab = lazy(() =>
  import('./components/tabs/TvTab').then((m) => ({ default: m.TvTab })),
)
const MoviesTab = lazy(() =>
  import('./components/tabs/MoviesTab').then((m) => ({ default: m.MoviesTab })),
)
const DownloadsTab = lazy(() =>
  import('./components/tabs/DownloadsTab').then((m) => ({ default: m.DownloadsTab })),
)
const UsersTab = lazy(() =>
  import('./components/tabs/UsersTab').then((m) => ({ default: m.UsersTab })),
)
const IptvTab = lazy(() => import('./components/tabs/IptvTab'))
const MediaTab = lazy(() =>
  import('./components/tabs/MediaTab').then((m) => ({ default: m.MediaTab })),
)

// Walkthrough is the unauthed landing experience. Authed users (the hot
// path) never see it, so keep it out of the initial chunk. Unauthed users
// hit it during the brief /api/me flight + first network paint for the
// chunk; the kraken atmosphere is already rendering in the meantime.
const Walkthrough = lazy(() =>
  import('./components/walkthrough/Walkthrough').then((m) => ({ default: m.Walkthrough })),
)

const TABS: Record<Route, React.ComponentType> = {
  home: HomeTab,
  tv: TvTab,
  movies: MoviesTab,
  media: MediaTab,
  downloads: DownloadsTab,
  users: UsersTab,
  live: IptvTab,
}

function Shell() {
  const [route, navigate] = useRoute()
  const { isAdmin } = useAuth()
  const limits = useLimits()
  const iptvEnabled = limits.data?.iptvEnabled !== false
  // Media Library tab is gated on the server having mounted the
  // /api/media proxy (USE_MEDIA_CORE=1). Default-on for older backends.
  const mediaEnabled = limits.data?.mediaEnabled !== false
  // The Users tab is admin-only. Non-admins who land on /users via a
  // stale link get bounced home rather than seeing an error page.
  // The Live tab is gated by IPTV_DISABLED — bounce on stale links too
  // (the route still exists in the enum so old bookmarks don't 404 the
  // SPA itself; they just round-trip to home).
  useEffect(() => {
    if (route === 'users' && !isAdmin) navigate('home')
    if (route === 'live' && !iptvEnabled) navigate('home')
    if (route === 'media' && !mediaEnabled) navigate('home')
  }, [route, isAdmin, iptvEnabled, mediaEnabled, navigate])
  const blocked =
    (route === 'users' && !isAdmin) ||
    (route === 'live' && !iptvEnabled) ||
    (route === 'media' && !mediaEnabled)
  const effectiveRoute: Route = blocked ? 'home' : route
  const ActiveTab = TABS[effectiveRoute]
  const krakenVariant = effectiveRoute === 'home' ? 'kraken' : 'resting'

  return (
    <>
      <Kraken variant={krakenVariant} />
      {effectiveRoute === 'home' ? <HomeNav /> : <TopNav active={effectiveRoute} />}
      <main role="main">
        <Suspense fallback={<LoadingPulse>Loading</LoadingPulse>}>
          <ActiveTab />
        </Suspense>
      </main>
      <ReplayButton />
    </>
  )
}

// Gate the whole dashboard behind a Plex session. Unauthenticated
// visitors land on the public Walkthrough — the showcase IS the
// pre-auth experience, with Plex sign-in CTAs embedded in the hero
// and footer. The kraken atmosphere keeps playing under both states
// so the brand is present from first paint. While /api/me is in
// flight we render nothing — short (one-RTT) flash, avoids any
// pop-in for already-authed users.
function AuthGate() {
  const { loading, user } = useAuth()
  if (loading) return null
  if (!user) {
    // Suspense fallback here is essentially invisible — the Kraken inside
    // Walkthrough is the brand atmosphere, and on second visit the chunk
    // is already in HTTP cache. Render nothing during the brief gap.
    return (
      <Suspense fallback={null}>
        <Walkthrough />
      </Suspense>
    )
  }
  return (
    <NavTransitionProvider>
      <Shell />
    </NavTransitionProvider>
  )
}

function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  )
}

export default App
