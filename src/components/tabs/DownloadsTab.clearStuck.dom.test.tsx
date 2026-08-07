// @vitest-environment jsdom
//
// Movies jammed in Radarr's import stage used to be invisible AND unclearable:
// the stuck banner counted only the Sonarr queue and the Clear-blocked button
// only called sonarr.clearStuck(). These tests pin the parity — a Radarr-only
// jam must surface, the count must sum both apps, and one click must clear
// both queues.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type QueueRecord = { id: number; trackedDownloadState?: string; status?: string }

const h = vi.hoisted(() => ({
  clearStuckSonarr: vi.fn(async () => ({ removed: 0 })),
  clearStuckRadarr: vi.fn(async () => ({ removed: 0 })),
  sonarrRecords: [] as Array<{ id: number; trackedDownloadState?: string; status?: string }>,
  radarrRecords: [] as Array<{ id: number; trackedDownloadState?: string; status?: string }>,
  confirmError: null as unknown,
}))

vi.mock('../../lib/api/sab', () => ({
  sab: {
    queue: vi.fn(),
    pauseItem: vi.fn(),
    resumeItem: vi.fn(),
    deleteItem: vi.fn(),
  },
}))
vi.mock('../../lib/api/sonarr', () => ({ sonarr: { clearStuck: h.clearStuckSonarr } }))
vi.mock('../../lib/api/radarr', () => ({ radarr: { clearStuck: h.clearStuckRadarr } }))
vi.mock('../../lib/hooks/useDownloadQueue', () => ({
  useDownloadQueue: () => ({
    isPending: false,
    error: null,
    data: {
      queue: {
        slots: [],
        speed: '0',
        size: '0',
        sizeleft: '0',
        paused: false,
        diskspace1: '100',
      },
    },
  }),
  useSonarrQueue: () => ({ data: { records: h.sonarrRecords } }),
  useRadarrQueue: () => ({ data: { records: h.radarrRecords } }),
}))
vi.mock('../../lib/hooks/useSonarrLibrary', () => ({ useSonarrLibrary: () => ({ data: [] }) }))
vi.mock('../../lib/hooks/useRecentlyAdded', () => ({ useRecentlyAdded: () => [] }))
vi.mock('../downloads/GrabActivityPanel', () => ({ GrabActivityPanel: () => null }))
vi.mock('../downloads/UsageDashboard', () => ({ UsageDashboard: () => null }))
vi.mock('../../lib/navTransition', () => ({
  useNavTransition: () => ({ transitionTo: vi.fn() }),
}))
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ isAdmin: true }) }))
// Auto-accept the confirm dialog so a click runs onConfirm directly. The real
// ConfirmModal awaits onConfirm inside try/catch and renders the message, so
// swallowing here (into h.confirmError) mirrors production, not hides a bug.
vi.mock('../confirm/useConfirm', () => ({
  useConfirm: () => (intent: { onConfirm: () => Promise<void> | void }) => {
    void Promise.resolve()
      .then(() => intent.onConfirm())
      .catch((err) => {
        h.confirmError = err
      })
  },
}))

import { DownloadsTab } from './DownloadsTab'

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <DownloadsTab />
    </QueryClientProvider>,
  )
}

function setQueues(sonarr: QueueRecord[], radarr: QueueRecord[]) {
  h.sonarrRecords.splice(0, h.sonarrRecords.length, ...sonarr)
  h.radarrRecords.splice(0, h.radarrRecords.length, ...radarr)
}

beforeEach(() => {
  h.clearStuckSonarr.mockClear()
  h.clearStuckRadarr.mockClear()
  h.confirmError = null
  setQueues([], [])
})
afterEach(cleanup)

describe('DownloadsTab stuck-import banner', () => {
  it('surfaces a Radarr-only import jam (was invisible: count was Sonarr-only)', () => {
    setQueues([], [{ id: 1, trackedDownloadState: 'importBlocked' }])
    mount()
    const banner = screen.getByRole('status')
    expect(banner.textContent).toContain('1 finished download is stuck in import')
    // Copy no longer blames Sonarr — the banner now covers movies too.
    expect(banner.textContent).not.toContain('Sonarr')
  })

  it('sums jammed records across both queues and ignores healthy ones', () => {
    setQueues(
      [
        { id: 1, trackedDownloadState: 'importPending' },
        { id: 2, trackedDownloadState: 'downloading' },
      ],
      [
        { id: 3, trackedDownloadState: 'importBlocked' },
        { id: 4, trackedDownloadState: 'importPending' },
        { id: 5, trackedDownloadState: 'downloading' },
      ],
    )
    mount()
    expect(screen.getByRole('status').textContent).toContain(
      '3 finished downloads are stuck in import',
    )
  })

  it('stays hidden when nothing is jammed in either queue', () => {
    setQueues([{ id: 1, trackedDownloadState: 'downloading' }], [{ id: 2 }])
    mount()
    expect(screen.queryByRole('button', { name: 'Clear blocked' })).toBeNull()
  })

  it('clears BOTH queues from one click (Radarr call is the regression guard)', async () => {
    setQueues(
      [{ id: 1, trackedDownloadState: 'importBlocked' }],
      [{ id: 2, trackedDownloadState: 'importPending' }],
    )
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Clear blocked' }))
    await waitFor(() => expect(h.clearStuckSonarr).toHaveBeenCalledTimes(1))
    expect(h.clearStuckRadarr).toHaveBeenCalledTimes(1)
  })

  it('still clears Radarr when the Sonarr call rejects (no short-circuit)', async () => {
    h.clearStuckSonarr.mockRejectedValueOnce(new Error('sonarr down'))
    setQueues(
      [{ id: 1, trackedDownloadState: 'importBlocked' }],
      [{ id: 2, trackedDownloadState: 'importPending' }],
    )
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Clear blocked' }))
    await waitFor(() => expect(h.clearStuckRadarr).toHaveBeenCalledTimes(1))
    // …and the failure still propagates to the confirm modal's error slot.
    await waitFor(() => expect(h.confirmError).toBeInstanceOf(Error))
  })
})
