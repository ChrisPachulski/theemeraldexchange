// @vitest-environment jsdom
//
// The app-wide Search tab: one query fans out to the library, episodes, live
// channels and the Sonarr/Radarr lookup. These tests mount the real tab with
// the data hooks stubbed and check what it shows, in which order, what the
// rating cap hides, and where each result opens.

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { openIntentMock, allShowsMock, searchEpisodesMock, limits } = vi.hoisted(() => ({
  openIntentMock: vi.fn(),
  allShowsMock: vi.fn(),
  searchEpisodesMock: vi.fn(),
  limits: { data: {} as Record<string, boolean> },
}))

const idle = { isFetching: false }

vi.mock('../../lib/router', () => ({ openIntent: openIntentMock }))
vi.mock('../../lib/api/media', () => ({
  mediaApi: { allShows: allShowsMock, searchEpisodes: searchEpisodesMock },
}))
vi.mock('../../lib/hooks/useDebounced', () => ({ useDebounced: <T,>(v: T) => v }))
vi.mock('../../lib/hooks/useLimits', () => ({ useLimits: () => limits }))
vi.mock('../../lib/hooks/usePolicy', () => ({
  useSectionAccess: () => ({ live: true, arr: true }),
  useRatingGate: () => ({ allows: (rating?: string | null) => rating !== 'R' }),
}))
vi.mock('../../lib/hooks/useRadarrLibrary', () => ({
  useRadarrLibrary: () => ({
    ...idle,
    data: [
      { id: 1, tmdbId: 101, title: 'Scooby-Doo 2: Monsters Unleashed', year: 2004, certification: 'PG', images: [] },
      { id: 2, tmdbId: 102, title: 'Scooby-Doo', year: 2002, certification: 'PG', images: [] },
      { id: 3, tmdbId: 103, title: 'Scooby-Doo: Curse of the Lake Monster', year: 2010, certification: 'R', images: [] },
      { id: 4, tmdbId: 104, title: 'Heat', year: 1995, certification: 'PG', images: [] },
    ],
  }),
}))
vi.mock('../../lib/hooks/useSonarrLibrary', () => ({
  useSonarrLibrary: () => ({
    ...idle,
    data: [{ id: 7, tvdbId: 701, title: 'Scooby-Doo, Where Are You!', year: 1969, network: 'CBS', images: [] }],
  }),
}))
vi.mock('../../lib/hooks/useMovieSearch', () => ({
  useMovieSearch: (q: string) => ({
    ...idle,
    data: !q.includes('scoo') ? [] : [
      { tmdbId: 102, title: 'Scooby-Doo', year: 2002, certification: 'PG', images: [] },
      { tmdbId: 105, title: 'Scooby-Doo on Zombie Island', year: 1998, certification: 'G', images: [] },
    ],
  }),
}))
vi.mock('../../lib/hooks/useSeriesSearch', () => ({
  useSeriesSearch: (q: string) => ({
    ...idle,
    data: !q.includes('scoo') ? [] : [{ tvdbId: 702, title: 'What’s New, Scooby-Doo?', year: 2002, certification: 'TV-Y7', images: [] }],
  }),
}))
vi.mock('../../lib/hooks/useIptvLive', () => ({
  useIptvLive: (_params: unknown, enabled: boolean) => ({
    ...idle,
    data: enabled
      ? { items: [{ stream_id: 501, num: 12, name: 'Boomerang', tv_archive: 1 }], total: 3 }
      : undefined,
  }),
}))
vi.mock('../../lib/hooks/useIptvEpg', () => ({ EPG_SEARCH_MIN_CHARS: 2 }))
vi.mock('../../lib/hooks/useMediaLibrary', async () => {
  const actual = await vi.importActual<typeof import('../../lib/hooks/useMediaLibrary')>(
    '../../lib/hooks/useMediaLibrary',
  )
  return {
    resumePosition: actual.resumePosition,
    useMediaWatch: () => ({
      data: new Map([['episode:9001', { positionSecs: 312, completed: false }]]),
    }),
  }
})
vi.mock('../../lib/hooks/useRecentlyAdded', () => ({ pickPoster: () => undefined }))
vi.mock('../iptv/ProgrammeResults', () => ({ ProgrammeResults: () => null }))
vi.mock('../media/MediaPlayer', () => ({
  MediaPlayer: (p: { title: string; startPositionSecs?: number; onClose: () => void }) => (
    <div role="dialog" aria-label={p.title}>
      resume at {p.startPositionSecs ?? 0}
      <button type="button" onClick={p.onClose}>
        Close player
      </button>
    </div>
  ),
}))

import { SearchTab } from './SearchTab'

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <SearchTab />
    </QueryClientProvider>,
  )
}

function search(q: string) {
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search everything' }), { target: { value: q } })
}

function titlesIn(section: string): string[] {
  return within(screen.getByRole('region', { name: section }))
    .getAllByRole('button')
    .map((b) => b.textContent ?? '')
}

beforeEach(() => {
  sessionStorage.clear()
  limits.data = {}
  allShowsMock.mockResolvedValue([{ id: 7, title: 'Scooby-Doo, Where Are You!', contentRating: 'TV-Y' }])
  searchEpisodesMock.mockResolvedValue({
    items: [
      { id: 9001, showId: 7, season: 1, episode: 3, title: 'Hassle in the Castle' },
      { id: 9002, showId: 99, season: 2, episode: 1, title: 'Not a show we know' },
    ],
    total: 2,
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SearchTab', () => {
  it('shows a hint, not results, until the query is long enough', () => {
    mount()
    search('s')
    expect(screen.getByText(/live channels and programs, and titles to add/)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Movies' })).not.toBeInTheDocument()
  })

  it('ranks the exact title first, hides rated-out titles, and opens movies in their tab', () => {
    mount()
    search('scooby doo')
    const movies = titlesIn('Movies')
    expect(movies[0]).toContain('Scooby-Doo2002')
    expect(movies[1]).toContain('Monsters Unleashed')
    expect(movies.join()).not.toContain('Lake Monster')
    expect(movies.join()).not.toContain('Heat')

    fireEvent.click(screen.getByRole('button', { name: /Monsters Unleashed/ }))
    expect(openIntentMock).toHaveBeenCalledWith('movies', 1)
    fireEvent.click(screen.getByRole('button', { name: /Where Are You/ }))
    expect(openIntentMock).toHaveBeenCalledWith('tv', 7)
  })

  it('tunes a channel in the Live tab and counts what it left out', () => {
    mount()
    search('boomerang')
    const channels = screen.getByRole('region', { name: 'Channels' })
    expect(within(channels).getByText('1 of 3')).toBeInTheDocument()
    expect(within(channels).getByText(/Catch-up/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Watch Boomerang live' }))
    expect(openIntentMock).toHaveBeenCalledWith('live', 501)
  })

  it('offers only titles not already in the library, opening them with Add', () => {
    mount()
    search('scooby')
    const discover = titlesIn('Not in your library')
    expect(discover).toHaveLength(2)
    expect(discover.join()).toContain('Zombie Island')
    expect(discover.join()).toContain('What’s New')

    fireEvent.click(screen.getByRole('button', { name: /Zombie Island/ }))
    expect(openIntentMock).toHaveBeenCalledWith('movies', 'tmdb:105')
    fireEvent.click(screen.getByRole('button', { name: /What’s New/ }))
    expect(openIntentMock).toHaveBeenCalledWith('tv', 'tvdb:702')
  })

  it('plays an episode in place from where it was left, dropping episodes of unknown shows', async () => {
    mount()
    search('castle')
    const episode = await screen.findByRole('button', { name: /Hassle in the Castle/ })
    expect(screen.queryByText('Not a show we know')).not.toBeInTheDocument()

    fireEvent.click(episode)
    const player = screen.getByRole('dialog', { name: 'Scooby-Doo, Where Are You!: Hassle in the Castle' })
    expect(player).toHaveTextContent('resume at 312')
    fireEvent.click(within(player).getByRole('button', { name: 'Close player' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('leaves live TV out when it is switched off and says when nothing matched', async () => {
    limits.data = { iptvEnabled: false }
    searchEpisodesMock.mockResolvedValue({ items: [], total: 0 })
    mount()
    expect(screen.getByRole('searchbox', { name: 'Search everything' })).toHaveAttribute(
      'placeholder',
      'Movies, shows & episodes',
    )
    search('zzzz')
    expect(await screen.findByText('No results for “zzzz”.')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Channels' })).not.toBeInTheDocument()
  })

  it('keeps the query across a trip out of the tab and back', () => {
    const first = mount()
    search('heat')
    first.unmount()
    mount()
    expect(screen.getByRole('searchbox', { name: 'Search everything' })).toHaveValue('heat')
  })
})
