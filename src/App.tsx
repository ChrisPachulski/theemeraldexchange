import { TopNav } from './components/nav/TopNav'
import { HomeNav } from './components/nav/HomeNav'
import { HomeTab } from './components/tabs/HomeTab'
import { TvTab } from './components/tabs/TvTab'
import { MoviesTab } from './components/tabs/MoviesTab'
import { DownloadsTab } from './components/tabs/DownloadsTab'
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
}

function Shell() {
  const [route] = useRoute()
  const ActiveTab = TABS[route]
  const krakenVariant = route === 'home' ? 'kraken' : 'resting'

  return (
    <>
      <Kraken variant={krakenVariant} />
      {route === 'home' ? <HomeNav /> : <TopNav active={route} />}
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
