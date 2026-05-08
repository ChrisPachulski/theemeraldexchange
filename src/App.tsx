import { TopNav } from './components/nav/TopNav'
import { TvTab } from './components/tabs/TvTab'
import { MoviesTab } from './components/tabs/MoviesTab'
import { DownloadsTab } from './components/tabs/DownloadsTab'
import { Kraken } from './components/atmosphere/Kraken'
import { Beacon } from './components/atmosphere/Beacon'
import { useRoute, type Route } from './lib/router'

const TABS: Record<Route, () => React.ReactElement> = {
  tv: TvTab,
  movies: MoviesTab,
  downloads: DownloadsTab,
}

function App() {
  const [route, navigate] = useRoute()
  const ActiveTab = TABS[route]

  return (
    <>
      <Kraken />
      <Beacon />
      <TopNav active={route} onNavigate={navigate} />
      <main role="main">
        <ActiveTab />
      </main>
    </>
  )
}

export default App
