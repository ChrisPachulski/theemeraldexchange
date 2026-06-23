// @vitest-environment jsdom
//
// Mounted-DOM tests for the discover-time "Find release" flow on the movies
// tab. The flow is invisible plumbing around the interactive release browser:
// the release endpoint REQUIRES the movie to exist, so clicking Find release
// must ADD the title (monitored, auto-grab OFF) first, then open the release
// list on the just-added movie. Grabbing keeps it; closing without a grab
// removes it so nothing is left behind.
//
// We mock the radarr api at the module boundary so we assert the REAL call
// args (add with searchForMovie:false, remove with deleteFiles:false), and
// stub the peripheral hooks the tab calls so it mounts without network. The
// component's own logic + react-query run for real.

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArrRelease } from '../../lib/api/arrAdvanced'

const { addMovieMock, removeMovieMock, releasesMock, grabReleaseMock, searchResult } = vi.hoisted(() => ({
  addMovieMock: vi.fn(),
  removeMovieMock: vi.fn(),
  releasesMock: vi.fn(),
  grabReleaseMock: vi.fn(),
  searchResult: {
    tmdbId: 42,
    title: 'Dune',
    year: 2021,
    overview: 'Spice.',
  },
}))

// movieAvailability is the REAL helper (a just-added movie has no file → not
// playable → no dead play affordances); only the network methods are stubbed.
vi.mock('../../lib/api/radarr', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api/radarr')>('../../lib/api/radarr')
  return {
    ...actual,
    radarr: {
      ...actual.radarr,
      addMovie: addMovieMock,
      removeMovie: removeMovieMock,
      releases: releasesMock,
      grabRelease: grabReleaseMock,
    },
  }
})

vi.mock('../../lib/auth', () => ({ useAuth: () => ({ isAdmin: true }) }))
vi.mock('../../lib/hooks/useDebounced', () => ({ useDebounced: <T,>(v: T) => v }))
vi.mock('../../lib/hooks/useMovieSearch', () => ({
  useMovieSearch: () => ({ data: [searchResult], isPending: false, error: null }),
}))
vi.mock('../../lib/hooks/useRadarrLibrary', () => ({
  useRadarrLibrary: () => ({ data: [], isPending: false, error: null }),
  useRadarrProfiles: () => ({ data: [{ id: 7, name: 'Choose Me' }] }),
  useRadarrRootFolders: () => ({ data: [{ id: 1, path: '/movies' }] }),
}))
vi.mock('../../lib/hooks/useLimits', () => ({
  useLimits: () => ({ data: { mediaEnabled: false, defaultProfileName: 'Choose Me', maxMovieGb: 10 } }),
}))
vi.mock('../../lib/hooks/useCast', () => ({ useCast: () => ({ data: [], isLoading: false }) }))
vi.mock('../../lib/hooks/usePlexLinks', () => ({
  usePlexLinks: () => ({ linkFor: () => null, isLoading: false }),
}))
vi.mock('../../lib/hooks/useMediaLibrary', () => ({
  useLocalMovieIndex: () => ({ data: new Map() }),
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

import { MoviesTab } from './MoviesTab'
import { ConfirmProvider } from '../confirm/ConfirmProvider'

function release(over: Partial<ArrRelease> = {}): ArrRelease {
  return {
    guid: 'rel-1',
    indexerId: 3,
    indexer: 'Indexer',
    title: 'Dune.2021.2160p',
    size: 8 * 1024 ** 3,
    sizeGb: 8,
    qualityWeight: 100,
    quality: 'WEBDL-2160p',
    languages: ['English'],
    seeders: 50,
    ageHours: 12,
    rejected: false,
    rejections: [],
    overCap: false,
    fullSeason: undefined,
    ...over,
  } as ArrRelease
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <MoviesTab />
      </ConfirmProvider>
    </QueryClientProvider>,
  )
}

// Open the discover detail for the single search result. DiscoverResults only
// renders once the (debounced, mocked passthrough) query is >= 2 chars, so type
// first, then click the resulting card.
async function openDetail() {
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search movies' }), {
    target: { value: 'dune' },
  })
  const card = await screen.findByText('Dune')
  fireEvent.click(card)
}

// jsdom doesn't implement the <dialog> showModal/close methods the modal uses.
// Polyfill them to toggle the `open` attribute (the modal only reads d.open).
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
  addMovieMock.mockReset()
  removeMovieMock.mockReset()
  releasesMock.mockReset()
  grabReleaseMock.mockReset()
  addMovieMock.mockResolvedValue({
    id: 999,
    tmdbId: 42,
    title: 'Dune',
    year: 2021,
    qualityProfileId: 7,
    rootFolderPath: '/movies',
    monitored: true,
    added: '2024-01-01',
  })
  removeMovieMock.mockResolvedValue({ ok: true })
  releasesMock.mockResolvedValue([release()])
  grabReleaseMock.mockResolvedValue({ title: 'Dune.2021.2160p', sizeGb: 8 })
})

afterEach(cleanup)

describe('MoviesTab — Find release (discover-time interactive search)', () => {
  it('clicking Find release adds the movie monitored with auto-grab OFF', async () => {
    mount()
    await openDetail()
    fireEvent.click(await screen.findByRole('button', { name: 'Find release' }))

    await waitFor(() => expect(addMovieMock).toHaveBeenCalledTimes(1))
    const body = addMovieMock.mock.calls[0][0]
    expect(body).toMatchObject({
      tmdbId: 42,
      monitored: true,
      qualityProfileId: 7,
      rootFolderPath: '/movies',
      addOptions: { searchForMovie: false },
    })
  })

  it('after the add, the interactive-search release list is shown (auto-open)', async () => {
    mount()
    await openDetail()
    fireEvent.click(await screen.findByRole('button', { name: 'Find release' }))

    // The release endpoint is queried with the just-added movie id, and the
    // release row renders without any extra disclosure click.
    await waitFor(() => expect(releasesMock).toHaveBeenCalledWith(999))
    expect(await screen.findByRole('button', { name: /Grab Dune\.2021\.2160p/ })).toBeInTheDocument()
  })

  it('grabbing a release does NOT remove the movie on close', async () => {
    mount()
    await openDetail()
    fireEvent.click(await screen.findByRole('button', { name: 'Find release' }))

    const grab = await screen.findByRole('button', { name: /Grab Dune\.2021\.2160p/ })
    fireEvent.click(grab)
    await waitFor(() => expect(grabReleaseMock).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Close detail view' }))
    // Give any (incorrect) cleanup a chance to fire.
    await act(async () => { await Promise.resolve() })
    expect(removeMovieMock).not.toHaveBeenCalled()
  })

  it('closing WITHOUT grabbing removes the movie (deleteFiles=false)', async () => {
    mount()
    await openDetail()
    fireEvent.click(await screen.findByRole('button', { name: 'Find release' }))
    await screen.findByRole('button', { name: /Grab Dune\.2021\.2160p/ })

    fireEvent.click(screen.getByRole('button', { name: 'Close detail view' }))
    await waitFor(() => expect(removeMovieMock).toHaveBeenCalledTimes(1))
    expect(removeMovieMock).toHaveBeenCalledWith(999, false)
  })
})
