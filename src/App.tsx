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

function App() {
  return (
    <NavTransitionProvider>
      <Shell />
    </NavTransitionProvider>
  )
}

export default App
