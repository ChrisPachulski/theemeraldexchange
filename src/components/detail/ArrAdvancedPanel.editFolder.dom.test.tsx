// @vitest-environment jsdom
//
// Mounted-DOM test for the Edit section's Folder picker. An in-library item
// can carry a rootFolderPath that the live Radarr/Sonarr root-folder list no
// longer contains — the root was removed or renamed upstream in Sonarr/Radarr
// itself. A single-line <select> whose `value` matches no <option>
// does not keep that value: the HTML reset algorithm selects the FIRST option
// instead (blank only when the list is empty). So the panel displayed some
// OTHER root folder while Save still submitted the item's real one — the
// control lied about what it was about to write.
//
// The radarr api is mocked at the module boundary so the real hooks and
// react-query run and we assert the REAL save payload.

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { rootFoldersMock, qualityProfilesMock, editMovieMock, limitsData, SONARR_FOLDERS } = vi.hoisted(
  () => ({
    rootFoldersMock: vi.fn(),
    qualityProfilesMock: vi.fn(),
    editMovieMock: vi.fn(),
    limitsData: { current: {} as Record<string, unknown> },
    // Deliberately disjoint from the Radarr list so a kind ternary wired to
    // the wrong app is caught rather than silently agreeing.
    SONARR_FOLDERS: [
      { id: 10, path: '/data/media/tv' },
      { id: 11, path: '/data/media/tv-4k' },
    ],
  }),
)

vi.mock('../../lib/api/radarr', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api/radarr')>('../../lib/api/radarr')
  return {
    ...actual,
    radarr: {
      ...actual.radarr,
      rootFolders: rootFoldersMock,
      qualityProfiles: qualityProfilesMock,
      editMovie: editMovieMock,
    },
  }
})

// kind='movie' never reads the Sonarr pickers, but the hooks still run (hooks
// can't be conditional). Keep them off the network — and serve a real folder
// list so the kind='tv' case below has one to pick a default from.
vi.mock('../../lib/hooks/useSonarrLibrary', async () => {
  const actual =
    await vi.importActual<typeof import('../../lib/hooks/useSonarrLibrary')>('../../lib/hooks/useSonarrLibrary')
  return {
    ...actual,
    useSonarrProfiles: () => ({ data: undefined }),
    useSonarrRootFolders: () => ({ data: SONARR_FOLDERS }),
  }
})

// The curated defaults live on /api/limits; mock the hook so the default-folder
// tests can vary them without a network round-trip.
vi.mock('../../lib/hooks/useLimits', () => ({ useLimits: () => ({ data: limitsData.current }) }))

import { EditSection } from './ArrAdvancedPanel'

// The movie lives on /data/media/movies-archive; Radarr no longer lists it.
const ORPHAN = '/data/media/movies-archive'
const LIVE_FOLDERS = [
  { id: 1, path: '/data/media/movies' },
  { id: 2, path: '/mnt/scratch' },
]

function mount(rootFolderPath?: string, kind: 'tv' | 'movie' = 'movie') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <EditSection
        kind={kind}
        itemId={999}
        monitored
        qualityProfileId={7}
        rootFolderPath={rootFolderPath}
        onToast={() => {}}
        libraryKey={['radarr', 'movie']}
        qc={qc}
      />
    </QueryClientProvider>,
  )
}

// The Folder select only exists behind the Edit disclosure.
async function openEdit(rootFolderPath?: string, kind: 'tv' | 'movie' = 'movie') {
  mount(rootFolderPath, kind)
  fireEvent.click(screen.getByRole('button', { name: /^Edit/ }))
  return await screen.findByRole('combobox', { name: 'Folder' })
}

// Only the Folder select's options — the Quality select is a sibling combobox.
const folderOptions = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((o) => (o as HTMLOptionElement).value)

beforeEach(() => {
  rootFoldersMock.mockReset()
  qualityProfilesMock.mockReset()
  editMovieMock.mockReset()
  limitsData.current = {}
  rootFoldersMock.mockResolvedValue(LIVE_FOLDERS)
  qualityProfilesMock.mockResolvedValue([{ id: 7, name: 'HD-1080p' }])
  editMovieMock.mockResolvedValue({ id: 999 })
})

afterEach(cleanup)

describe('EditSection — Folder picker with an orphaned root folder', () => {
  it('keeps the item’s folder selected when the live list omits it', async () => {
    const select = await openEdit(ORPHAN)
    // Wait until the live list has rendered — that is when the reset algorithm
    // would otherwise re-point the control at '/data/media/movies'.
    await screen.findByRole('option', { name: '/data/media/movies' })
    expect((select as HTMLSelectElement).value).toBe(ORPHAN)
    expect(screen.getByRole('option', { name: ORPHAN })).toBeInTheDocument()
  })

  it('still offers every live root folder alongside the orphan', async () => {
    const select = await openEdit(ORPHAN)
    await screen.findByRole('option', { name: '/data/media/movies' })
    // Orphan first, then the live list — three options, no duplicates.
    expect(folderOptions(select)).toEqual([ORPHAN, '/data/media/movies', '/mnt/scratch'])
  })

  it('Save submits the orphaned folder unchanged, and it is what the control shows', async () => {
    const select = await openEdit(ORPHAN)
    await screen.findByRole('option', { name: '/data/media/movies' })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(editMovieMock).toHaveBeenCalledTimes(1))
    expect(editMovieMock.mock.calls[0][0]).toBe(999)
    const patch = editMovieMock.mock.calls[0][1] as { rootFolderPath?: string }
    expect(patch).toMatchObject({
      monitored: true,
      qualityProfileId: 7,
      rootFolderPath: ORPHAN,
    })
    // The real defect: Save always wrote the orphan, but the control displayed
    // a different folder — what you saw was not what you saved.
    expect((select as HTMLSelectElement).value).toBe(patch.rootFolderPath)
  })

  it('switching to a live folder still works from the orphaned state', async () => {
    const select = await openEdit(ORPHAN)
    await screen.findByRole('option', { name: '/mnt/scratch' })
    fireEvent.change(select, { target: { value: '/mnt/scratch' } })
    expect((select as HTMLSelectElement).value).toBe('/mnt/scratch')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(editMovieMock).toHaveBeenCalledTimes(1))
    expect(editMovieMock.mock.calls[0][1]).toMatchObject({ rootFolderPath: '/mnt/scratch' })
  })

  it('adds no duplicate option when the folder IS in the live list', async () => {
    const select = await openEdit('/mnt/scratch')
    await screen.findByRole('option', { name: '/mnt/scratch' })
    expect(folderOptions(select)).toEqual(['/data/media/movies', '/mnt/scratch'])
  })

  it('adds no near-duplicate option for a trailing-slash/case variant of a live folder', async () => {
    // '/mnt/Scratch/' differs from the live '/mnt/scratch' only by a
    // trailing slash and case — normalizeRootFolderPath must treat these as
    // the same folder, or the picker would offer two options for one root.
    const select = await openEdit('/mnt/Scratch/')
    await screen.findByRole('option', { name: '/mnt/scratch' })
    expect(folderOptions(select)).toEqual(['/data/media/movies', '/mnt/scratch'])
  })
})

// An item with no rootFolderPath of its own (older *arr payloads, or a movie
// added before a root was assigned) falls through to a default. Add used the
// operator-curated DEFAULT_*_ROOT_FOLDER_PATH; Edit used folders[0] — so
// opening Edit and pressing Save silently RE-HOMED the item onto whichever
// root the *arr API happened to list first.
describe('EditSection — Folder default when the item has no rootFolderPath', () => {
  it('prefers the curated Radarr default over the live list’s first folder', async () => {
    limitsData.current = { defaultRadarrRootFolderPath: '/mnt/scratch' }
    const select = await openEdit(undefined)
    await screen.findByRole('option', { name: '/mnt/scratch' })
    expect((select as HTMLSelectElement).value).toBe('/mnt/scratch')
    expect((select as HTMLSelectElement).value).not.toBe(LIVE_FOLDERS[0].path)
  })

  it('matches the curated default trailing-slash- and case-insensitively', async () => {
    limitsData.current = { defaultRadarrRootFolderPath: '/MNT/Scratch/' }
    const select = await openEdit(undefined)
    await screen.findByRole('option', { name: '/mnt/scratch' })
    // The live list's exact spelling wins, so no orphan option is synthesized.
    expect((select as HTMLSelectElement).value).toBe('/mnt/scratch')
    expect(folderOptions(select)).toEqual(['/data/media/movies', '/mnt/scratch'])
  })

  it('Save submits the curated default, not the first live folder', async () => {
    limitsData.current = { defaultRadarrRootFolderPath: '/mnt/scratch' }
    await openEdit(undefined)
    await screen.findByRole('option', { name: '/mnt/scratch' })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(editMovieMock).toHaveBeenCalledTimes(1))
    expect(editMovieMock.mock.calls[0][1]).toMatchObject({ rootFolderPath: '/mnt/scratch' })
  })

  it('reads the Sonarr default for kind="tv"', async () => {
    limitsData.current = {
      defaultSonarrRootFolderPath: '/data/media/tv-4k',
      // A Radarr default must not leak into the TV branch.
      defaultRadarrRootFolderPath: '/mnt/scratch',
    }
    const select = await openEdit(undefined, 'tv')
    await screen.findByRole('option', { name: '/data/media/tv-4k' })
    expect((select as HTMLSelectElement).value).toBe('/data/media/tv-4k')
  })

  it('still falls back to the first live folder when no default is configured', async () => {
    limitsData.current = { defaultRadarrRootFolderPath: null }
    const select = await openEdit(undefined)
    await screen.findByRole('option', { name: '/data/media/movies' })
    expect((select as HTMLSelectElement).value).toBe('/data/media/movies')
  })

  it('prefers the item’s own folder over the curated default', async () => {
    limitsData.current = { defaultRadarrRootFolderPath: '/mnt/scratch' }
    const select = await openEdit('/data/media/movies')
    await screen.findByRole('option', { name: '/mnt/scratch' })
    expect((select as HTMLSelectElement).value).toBe('/data/media/movies')
  })
})
