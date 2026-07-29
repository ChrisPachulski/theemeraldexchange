// @vitest-environment jsdom
//
// Mounted-DOM regression for the silent-live-play-failure bug: clicking a
// channel whose grant fails with anything OTHER than a concurrency 429 used to
// rethrow into a void'ed onClick handler, so the rejection vanished into the
// unhandledrejection telemetry and the user saw NOTHING — no player, no error.
// The server's §9/§12.4 source_unavailable payload (rank-1 source offline) was
// never surfaced. These tests drive a real channel-card click and assert a
// role=alert error (with the source_unavailable alternatives) renders in place.

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { grantLiveMock } = vi.hoisted(() => ({ grantLiveMock: vi.fn() }))

const CHANNEL = {
  stream_id: 501,
  num: 501,
  name: 'ESPN',
  stream_icon: null,
  epg_channel_id: null,
  category_id: null,
  tv_archive: 0,
  tv_archive_duration: null,
}

vi.mock('../../lib/api/iptv', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api/iptv')>('../../lib/api/iptv')
  return {
    ...actual,
    iptvApi: {
      ...actual.iptvApi,
      grantLive: grantLiveMock,
      killSession: vi.fn().mockResolvedValue(undefined),
    },
  }
})

// Heavy children the failure path never needs — stub so the tab mounts clean.
vi.mock('../player/IptvPlayer', () => ({ default: () => null }))
vi.mock('./EpgGuide', () => ({ default: () => null }))
vi.mock('../iptv/ConnectionsWidget', () => ({ ConnectionsWidget: () => null }))

vi.mock('../../lib/hooks/useDebounced', () => ({ useDebounced: <T,>(v: T) => v }))
vi.mock('../../lib/hooks/useIptvCategories', () => ({ useIptvCategories: () => ({ data: [] }) }))
vi.mock('../../lib/hooks/useIptvEpg', () => ({
  useIptvEpgNow: () => ({ data: [] }),
  useIptvEpgChannel: () => ({ data: [], isLoading: false, error: null }),
}))
vi.mock('../../lib/hooks/useIptvLive', () => ({
  useIptvLive: () => ({ data: { items: [CHANNEL], total: 1 }, isLoading: false, error: null, isFetching: false }),
}))
vi.mock('../../lib/hooks/useIptvFavorites', () => ({
  useIptvFavoriteSet: () => new Set<string>(),
  useToggleIptvFavorite: () => ({ mutate: () => {} }),
}))
vi.mock('../../lib/hooks/useIptvHistory', () => ({ useReportPosition: () => () => {} }))

import LiveTab from './LiveTab'
import { ApiError } from '../../lib/api/errors'

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <LiveTab />
    </QueryClientProvider>,
  )
}

// The tab defaults to the guide view; switch to Channels so the card grid renders,
// then click the ESPN card (the <li role="button">).
async function clickChannelCard() {
  fireEvent.click(screen.getByRole('button', { name: 'Channels' }))
  const nameEl = await screen.findByText('ESPN')
  const card = nameEl.closest('li.iptv-channel-card')
  expect(card).not.toBeNull()
  fireEvent.click(card as HTMLElement)
}

beforeEach(() => {
  grantLiveMock.mockReset()
})

afterEach(cleanup)

describe('LiveTab — failed channel grant surfaces a visible error (never a silent void)', () => {
  it('renders a source_unavailable alert with the available alternatives', async () => {
    grantLiveMock.mockRejectedValue(
      new ApiError(503, 'IPTV grant failed', 'source_unavailable', {
        reason: 'source_unavailable',
        available_alternatives: [{ source: 'plex', displayName: 'Watch on Plex', kind: 'movie', id: 'p-1' }],
      }),
    )

    mount()
    await clickChannelCard()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/source is unavailable/i)
    expect(alert).toHaveTextContent('Watch on Plex')
  })

  it('renders the friendly message for a generic grant failure', async () => {
    grantLiveMock.mockRejectedValue(new ApiError(502, 'Live stream is off the air right now.'))

    mount()
    await clickChannelCard()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Live stream is off the air right now.')
  })
})
