// @vitest-environment jsdom
//
// Mounted-DOM tests for the discover-time "Find release" flow on the TV tab —
// the Sonarr twin of MoviesTab.findRelease.dom.test.tsx. The release endpoint
// REQUIRES the series to exist, so clicking Find release must ADD the title
// (monitored, auto-grab OFF) first, then open the release list on the
// just-added series. Grabbing keeps it; closing without a grab removes it.
//
// The sonarr api is mocked at the module boundary so we assert the REAL call
// args (addSeries with searchForMissingEpisodes:false, removeSeries with
// deleteFiles:false); peripheral hooks are stubbed so the tab mounts offline.

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArrRelease } from '../../lib/api/arrAdvanced'

const { addSeriesMock, removeSeriesMock, releasesMock, grabReleaseMock, searchResult } = vi.hoisted(() => ({
  addSeriesMock: vi.fn(),
  removeSeriesMock: vi.fn(),
  releasesMock: vi.fn(),
  grabReleaseMock: vi.fn(),
  searchResult: {
    tvdbId: 555,
    tmdbId: 42,
    title: 'Severance',
    year: 2022,
    overview: 'Work.',
    seasons: [{ seasonNumber: 1, monitored: true }],
  },
}))

vi.mock('../../lib/api/sonarr', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api/sonarr')>('../../lib/api/sonarr')
  return {
    ...actual,
    sonarr: {
      ...actual.sonarr,
      addSeries: addSeriesMock,
      removeSeries: removeSeriesMock,
      releases: releasesMock,
      grabRelease: grabReleaseMock,
    },
  }
})

vi.mock('../../lib/auth', () => ({ useAuth: () => ({ isAdmin: true }) }))
vi.mock('../../lib/hooks/useDebounced', () => ({ useDebounced: <T,>(v: T) => v }))
vi.mock('../../lib/hooks/useSeriesSearch', () => ({
  useSeriesSearch: () => ({ data: [searchResult], isPending: false, error: null }),
}))
vi.mock('../../lib/hooks/useSonarrLibrary', () => ({
  useSonarrLibrary: () => ({ data: [], isPending: false, error: null }),
  useSonarrProfiles: () => ({ data: [{ id: 7, name: 'Choose Me' }] }),
  useSonarrRootFolders: () => ({ data: [{ id: 1, path: '/tv' }] }),
}))
// One episode so the interactive-search season selector has a season to query
// (the release list is gated on a resolved season number for TV).
vi.mock('../../lib/hooks/useSonarrEpisodes', () => ({
  useSonarrEpisodes: () => ({
    data: [
      { id: 1, seriesId: 999, seasonNumber: 1, episodeNumber: 1, title: 'Good News', hasFile: false, monitored: true },
    ],
  }),
}))
vi.mock('../../lib/hooks/useLimits', () => ({
  useLimits: () => ({ data: { mediaEnabled: false, defaultProfileName: 'Choose Me', maxTvGbPerEpisode: 5 } }),
}))
vi.mock('../../lib/hooks/useCast', () => ({ useCast: () => ({ data: [], isLoading: false }) }))
vi.mock('../../lib/hooks/usePlexLinks', () => ({
  usePlexLinks: () => ({ linkFor: () => null, isLoading: false }),
}))
vi.mock('../../lib/hooks/useMediaLibrary', () => ({
  useLocalShowIndex: () => ({ data: new Map() }),
  useMediaWatch: () => ({ data: new Map() }),
  resumePosition: () => undefined,
}))
vi.mock('../../lib/hooks/useSuggestionStrip', () => ({
  useSuggestionStrip: () => ({
    suggested: { data: { items: [], source: null, diag: null }, isPending: false, isFetching: false, error: null },
    items: [],
    label: 'Trending',
    refresh: () => {},
    feedback: { stateFor: () => 'unset', onLike: () => {}, onDislike: () => {}, unavailable: false },
    mode: undefined,
    personalizedAchievable: false,
  }),
}))
vi.mock('../../lib/api/recommenderEvents', () => ({ postClickEvent: () => {} }))

import { TvTab } from './TvTab'
import { ConfirmProvider } from '../confirm/ConfirmProvider'

function release(over: Partial<ArrRelease> = {}): ArrRelease {
  return {
    guid: 'rel-1',
    indexerId: 3,
    indexer: 'Indexer',
    title: 'Severance.S01.2160p',
    size: 4 * 1024 ** 3,
    sizeGb: 4,
    qualityWeight: 100,
    quality: 'WEBDL-2160p',
    languages: ['English'],
    seeders: 50,
    ageHours: 12,
    rejected: false,
    rejections: [],
    overCap: false,
    fullSeason: true,
    ...over,
  } as ArrRelease
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <TvTab />
      </ConfirmProvider>
    </QueryClientProvider>,
  )
}

async function openDetail() {
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search TV shows' }), {
    target: { value: 'severance' },
  })
  const card = await screen.findByText('Severance')
  fireEvent.click(card)
}

// jsdom doesn't implement <dialog> showModal/close; polyfill the open toggle.
beforeEach(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () { this.open = true }
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () {
      this.open = false
      this.dispatchEvent(new Event('close'))
    }
  }
  addSeriesMock.mockReset()
  removeSeriesMock.mockReset()
  releasesMock.mockReset()
  grabReleaseMock.mockReset()
  addSeriesMock.mockResolvedValue({
    id: 999,
    tvdbId: 555,
    tmdbId: 42,
    title: 'Severance',
    year: 2022,
    qualityProfileId: 7,
    rootFolderPath: '/tv',
    monitored: true,
    added: '2024-01-01',
    seasons: [{ seasonNumber: 1, monitored: true }],
  })
  removeSeriesMock.mockResolvedValue({ ok: true })
  releasesMock.mockResolvedValue([release()])
  grabReleaseMock.mockResolvedValue({ title: 'Severance.S01.2160p', sizeGb: 4 })
})

afterEach(cleanup)

describe('TvTab — Find release (discover-time interactive search)', () => {
  it('clicking Find release adds the series monitored with auto-grab OFF', async () => {
    mount()
    await openDetail()
    fireEvent.click(await screen.findByRole('button', { name: 'Find release' }))

    await waitFor(() => expect(addSeriesMock).toHaveBeenCalledTimes(1))
    const body = addSeriesMock.mock.calls[0][0]
    expect(body).toMatchObject({
      tvdbId: 555,
      monitored: true,
      qualityProfileId: 7,
      rootFolderPath: '/tv',
      addOptions: { searchForMissingEpisodes: false },
    })
  })

  it('after the add, the interactive-search release list is shown (auto-open)', async () => {
    mount()
    await openDetail()
    fireEvent.click(await screen.findByRole('button', { name: 'Find release' }))

    await waitFor(() => expect(releasesMock).toHaveBeenCalled())
    // First positional arg is the just-added series id.
    expect(releasesMock.mock.calls[0][0]).toBe(999)
    expect(await screen.findByRole('button', { name: /Grab Severance\.S01\.2160p/ })).toBeInTheDocument()
  })

  it('grabbing a release does NOT remove the series on close', async () => {
    mount()
    await openDetail()
    fireEvent.click(await screen.findByRole('button', { name: 'Find release' }))

    const grab = await screen.findByRole('button', { name: /Grab Severance\.S01\.2160p/ })
    fireEvent.click(grab)
    await waitFor(() => expect(grabReleaseMock).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Close detail view' }))
    await act(async () => { await Promise.resolve() })
    expect(removeSeriesMock).not.toHaveBeenCalled()
  })

  it('closing WITHOUT grabbing removes the series (deleteFiles=false)', async () => {
    mount()
    await openDetail()
    fireEvent.click(await screen.findByRole('button', { name: 'Find release' }))
    await screen.findByRole('button', { name: /Grab Severance\.S01\.2160p/ })

    fireEvent.click(screen.getByRole('button', { name: 'Close detail view' }))
    await waitFor(() => expect(removeSeriesMock).toHaveBeenCalledTimes(1))
    expect(removeSeriesMock).toHaveBeenCalledWith(999, false)
  })
})
