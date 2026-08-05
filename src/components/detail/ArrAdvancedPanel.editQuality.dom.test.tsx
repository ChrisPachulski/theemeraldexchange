// @vitest-environment jsdom
//
// Mounted-DOM test for the Edit section's Quality picker — the same defect the
// Folder picker had. An in-library item can carry a qualityProfileId that the
// live Radarr/Sonarr profile list no longer contains, because the profile was
// renamed or deleted upstream after the item was added. A single-line <select>
// whose `value` matches no <option> does not keep that value: the HTML reset
// algorithm selects the FIRST option instead. So the panel displayed some OTHER
// profile while Save still submitted the item's real one — the control lied
// about what it was about to write.
//
// The radarr api is mocked at the module boundary so the real hooks and
// react-query run and we assert the REAL save payload.

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { rootFoldersMock, qualityProfilesMock, editMovieMock, limitsData } = vi.hoisted(() => ({
  rootFoldersMock: vi.fn(),
  qualityProfilesMock: vi.fn(),
  editMovieMock: vi.fn(),
  limitsData: { current: {} as Record<string, unknown> },
}))

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
// can't be conditional). Keep them off the network.
vi.mock('../../lib/hooks/useSonarrLibrary', async () => {
  const actual =
    await vi.importActual<typeof import('../../lib/hooks/useSonarrLibrary')>('../../lib/hooks/useSonarrLibrary')
  return {
    ...actual,
    useSonarrProfiles: () => ({ data: undefined }),
    useSonarrRootFolders: () => ({ data: undefined }),
  }
})

// The curated default profile name lives on /api/limits; mock the hook so the
// default-profile tests can vary it without a network round-trip.
vi.mock('../../lib/hooks/useLimits', () => ({ useLimits: () => ({ data: limitsData.current }) }))

import { EditSection } from './ArrAdvancedPanel'

// The movie was added under profile 7; Radarr no longer lists that profile.
const ORPHAN_ID = 7
const LIVE_PROFILES = [
  { id: 1, name: 'Any' },
  { id: 2, name: 'HD-1080p' },
]
const LIVE_FOLDERS = [{ id: 1, path: '/data/media/movies' }]

function mount(qualityProfileId?: number) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <EditSection
        kind="movie"
        itemId={999}
        monitored
        qualityProfileId={qualityProfileId}
        rootFolderPath="/data/media/movies"
        onToast={() => {}}
        libraryKey={['radarr', 'movie']}
        qc={qc}
      />
    </QueryClientProvider>,
  )
}

// The Quality select only exists behind the Edit disclosure.
async function openEdit(qualityProfileId?: number) {
  mount(qualityProfileId)
  fireEvent.click(screen.getByRole('button', { name: /^Edit/ }))
  return await screen.findByRole('combobox', { name: 'Quality' })
}

// Only the Quality select's options — the Folder select is a sibling combobox.
const qualityOptions = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((o) => (o as HTMLOptionElement).value)

beforeEach(() => {
  rootFoldersMock.mockReset()
  qualityProfilesMock.mockReset()
  editMovieMock.mockReset()
  limitsData.current = {}
  rootFoldersMock.mockResolvedValue(LIVE_FOLDERS)
  qualityProfilesMock.mockResolvedValue(LIVE_PROFILES)
  editMovieMock.mockResolvedValue({ id: 999 })
})

afterEach(cleanup)

describe('EditSection — Quality picker with an orphaned profile id', () => {
  it('keeps the item’s profile selected when the live list omits it', async () => {
    const select = await openEdit(ORPHAN_ID)
    // Wait until the live list has rendered — that is when the reset algorithm
    // would otherwise re-point the control at 'Any'.
    await screen.findByRole('option', { name: 'HD-1080p' })
    expect((select as HTMLSelectElement).value).toBe(String(ORPHAN_ID))
    expect(within(select).getByRole('option', { name: `Profile ${ORPHAN_ID}` })).toHaveValue(
      String(ORPHAN_ID),
    )
  })

  it('still offers every live profile alongside the orphan', async () => {
    const select = await openEdit(ORPHAN_ID)
    await screen.findByRole('option', { name: 'HD-1080p' })
    // Orphan first, then the live list — three options, no duplicates.
    expect(qualityOptions(select)).toEqual([String(ORPHAN_ID), '1', '2'])
  })

  it('Save submits the orphaned profile unchanged, and it is what the control shows', async () => {
    const select = await openEdit(ORPHAN_ID)
    await screen.findByRole('option', { name: 'HD-1080p' })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(editMovieMock).toHaveBeenCalledTimes(1))
    expect(editMovieMock.mock.calls[0][0]).toBe(999)
    const patch = editMovieMock.mock.calls[0][1] as { qualityProfileId?: number }
    expect(patch).toMatchObject({
      monitored: true,
      qualityProfileId: ORPHAN_ID,
      rootFolderPath: '/data/media/movies',
    })
    // The real defect: Save always wrote the orphan, but the control displayed
    // a different profile — what you saw was not what you saved.
    expect((select as HTMLSelectElement).value).toBe(String(patch.qualityProfileId))
  })

  it('switching to a live profile still works from the orphaned state', async () => {
    const select = await openEdit(ORPHAN_ID)
    await screen.findByRole('option', { name: 'HD-1080p' })
    fireEvent.change(select, { target: { value: '2' } })
    expect((select as HTMLSelectElement).value).toBe('2')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(editMovieMock).toHaveBeenCalledTimes(1))
    expect(editMovieMock.mock.calls[0][1]).toMatchObject({ qualityProfileId: 2 })
  })

  it('adds no duplicate option when the profile IS in the live list', async () => {
    const select = await openEdit(2)
    await screen.findByRole('option', { name: 'HD-1080p' })
    expect(qualityOptions(select)).toEqual(['1', '2'])
    expect((select as HTMLSelectElement).value).toBe('2')
  })
})

// An item with no qualityProfileId of its own (older *arr payloads, or a movie
// added before a profile was assigned) falls through to a default. Add used the
// operator-curated DEFAULT_PROFILE_NAME; Edit used profiles[0] — so opening Edit
// and pressing Save silently RE-GRADED the item onto whichever profile the *arr
// API happened to list first (usually 'Any', the worst one).
//
// Ids are deliberately NOT array indices here: 'Any' is id 2 at index 0 and the
// curated 'HD-1080p' is id 5 at index 1, so a positional profiles[0] bug reads
// as '2' and an id-based curated pick reads as '5'.
describe('EditSection — Quality default when the item has no qualityProfileId of its own', () => {
  const CURATED_PROFILES = [
    { id: 2, name: 'Any' },
    { id: 5, name: 'HD-1080p' },
  ]

  it('prefers the curated default profile over the live list’s first profile', async () => {
    qualityProfilesMock.mockResolvedValue(CURATED_PROFILES)
    limitsData.current = { defaultProfileName: 'HD-1080p' }
    const select = await openEdit(undefined)
    await screen.findByRole('option', { name: 'HD-1080p' })
    expect((select as HTMLSelectElement).value).toBe('5')
    expect((select as HTMLSelectElement).value).not.toBe(String(CURATED_PROFILES[0].id))
  })

  it('matches the curated default case-insensitively', async () => {
    qualityProfilesMock.mockResolvedValue(CURATED_PROFILES)
    limitsData.current = { defaultProfileName: 'hd-1080p' }
    const select = await openEdit(undefined)
    await screen.findByRole('option', { name: 'HD-1080p' })
    expect((select as HTMLSelectElement).value).toBe('5')
    // The live list's own entry wins, so no orphan option is synthesized.
    expect(qualityOptions(select)).toEqual(['2', '5'])
  })

  it('Save submits the curated default, not the first live profile', async () => {
    qualityProfilesMock.mockResolvedValue(CURATED_PROFILES)
    limitsData.current = { defaultProfileName: 'HD-1080p' }
    await openEdit(undefined)
    await screen.findByRole('option', { name: 'HD-1080p' })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(editMovieMock).toHaveBeenCalledTimes(1))
    expect(editMovieMock.mock.calls[0][1]).toMatchObject({ qualityProfileId: 5 })
  })

  it('falls back to the first live profile when nothing better exists', async () => {
    // The terminal rung of pickDefaultProfileId. It needs a list with no
    // curated match AND no 1080p/HD/non-'Any' entry — with CURATED_PROFILES
    // above, the shared 1080p rung would fire first and never reach profiles[0].
    qualityProfilesMock.mockResolvedValue([
      { id: 4, name: 'Any' },
      { id: 6, name: 'any' },
    ])
    limitsData.current = {}
    const select = await openEdit(undefined)
    await screen.findByRole('option', { name: 'any' })
    expect((select as HTMLSelectElement).value).toBe('4')
  })

  it('still prefers HD-1080p over the first profile when no default is configured', async () => {
    // Even with no curated name, Edit must use the same preference chain the
    // server's pickProfile uses — 'Any' being listed first must not win.
    qualityProfilesMock.mockResolvedValue(CURATED_PROFILES)
    limitsData.current = {}
    const select = await openEdit(undefined)
    await screen.findByRole('option', { name: 'HD-1080p' })
    expect((select as HTMLSelectElement).value).toBe('5')
  })

  it('prefers the item’s own profile over the curated default', async () => {
    qualityProfilesMock.mockResolvedValue(CURATED_PROFILES)
    limitsData.current = { defaultProfileName: 'HD-1080p' }
    const select = await openEdit(2)
    await screen.findByRole('option', { name: 'HD-1080p' })
    expect((select as HTMLSelectElement).value).toBe('2')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(editMovieMock).toHaveBeenCalledTimes(1))
    expect(editMovieMock.mock.calls[0][1]).toMatchObject({ qualityProfileId: 2 })
  })
})
