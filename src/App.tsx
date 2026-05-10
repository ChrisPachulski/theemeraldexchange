import { useEffect } from 'react'
import { TopNav } from './components/nav/TopNav'
import { HomeNav } from './components/nav/HomeNav'
import { HomeTab } from './components/tabs/HomeTab'
import { TvTab } from './components/tabs/TvTab'
import { MoviesTab } from './components/tabs/MoviesTab'
import { DownloadsTab } from './components/tabs/DownloadsTab'
import { UsersTab } from './components/tabs/UsersTab'
import { Kraken } from './components/atmosphere/Kraken'
import { useRoute, type Route } from './lib/router'
import { NavTransitionProvider } from './lib/navTransition'
import { ReplayButton } from './components/nav/ReplayButton'
import { AuthProvider, useAuth } from './lib/auth'
import { LoginScreen } from './components/auth/LoginScreen'

const TABS: Record<Route, () => React.ReactElement> = {
  home: HomeTab,
  tv: TvTab,
  movies: MoviesTab,
  downloads: DownloadsTab,
  users: UsersTab,
}

function Shell() {
  const [route, navigate] = useRoute()
  const { isAdmin } = useAuth()
  // The Users tab is admin-only. Non-admins who land on /users via a
  // stale link get bounced home rather than seeing an error page.
  useEffect(() => {
    if (route === 'users' && !isAdmin) navigate('home')
  }, [route, isAdmin, navigate])
  const blocked = route === 'users' && !isAdmin
  const effectiveRoute: Route = blocked ? 'home' : route
  const ActiveTab = TABS[effectiveRoute]
  const krakenVariant = effectiveRoute === 'home' ? 'kraken' : 'resting'

  return (
    <>
      <Kraken variant={krakenVariant} />
      {effectiveRoute === 'home' ? <HomeNav /> : <TopNav active={effectiveRoute} />}
      <main role="main">
        <ActiveTab />
      </main>
      <ReplayButton />
    </>
  )
}

// Gate the whole dashboard behind a Plex session. The kraken atmosphere
// keeps playing under the login screen so the brand is present from the
// first paint. While /api/me is in flight we render nothing — short
// (one-RTT) flash, avoids a login screen pop-in for already-authed users.
function AuthGate() {
  const { loading, user } = useAuth()
  if (loading) return null
  if (!user) {
    return (
      <>
        <Kraken variant="kraken" />
        <LoginScreen />
      </>
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
