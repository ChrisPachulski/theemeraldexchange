// @vitest-environment jsdom
//
// Mounted-DOM tests for the VOD tab's resume-or-start-over flow. The point is
// the GRANT ORDER: when a saved watch position exists, clicking a card must
// show the prompt and NOT mint a grant (no concurrency slot burned while the
// user reads it); the grant fires only after the choice, carrying the chosen
// offset. With no saved position, the card grants immediately (no prompt).
//
// The hooks the tab calls are mocked at the module boundary so the component
// mounts without react-query/network; IptvPlayer is stubbed to capture the
// startPositionSecs it was handed (the observable proof of the chosen offset).

import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VodTab from './VodTab'
import type { HistoryRow } from '../../lib/api/iptv'

const { grantVodMock, historyIndex, engineProps } = vi.hoisted(() => ({
  grantVodMock: vi.fn(),
  historyIndex: { current: new Map<string, unknown>() },
  engineProps: { current: null as null | { startPositionSecs?: number } },
}))

vi.mock('../../lib/api/iptv', () => ({
  iptvApi: {
    grantVod: grantVodMock,
  },
}))

// One movie in the catalog; the search/category/favorite plumbing is inert.
vi.mock('../../lib/hooks/useIptvVod', () => ({
  useIptvVod: () => ({
    data: {
      items: [
        {
          stream_id: 7,
          name: 'Heat',
          stream_icon: null,
          rating: null,
          category_id: null,
          year: 1995,
          tmdb_id: null,
        },
      ],
      total: 1,
    },
    isLoading: false,
    isFetching: false,
    error: null,
  }),
}))
vi.mock('../../lib/hooks/useIptvCategories', () => ({
  useIptvCategories: () => ({ data: [] }),
}))
vi.mock('../../lib/hooks/useIptvFavorites', () => ({
  useIptvFavoriteSet: () => new Set<string>(),
  useToggleIptvFavorite: () => ({ mutate: vi.fn() }),
}))
vi.mock('../../lib/hooks/useDebounced', () => ({
  useDebounced: <T,>(value: T) => value,
}))
// resumePercent/resumePosition are the REAL hoisted helpers (not mocked) so the
// prompt-vs-immediate decision exercises real logic; only the index + reporter
// are stubbed.
vi.mock('../../lib/hooks/useIptvHistory', async () => {
  const actual = await vi.importActual<typeof import('../../lib/hooks/useIptvHistory')>(
    '../../lib/hooks/useIptvHistory',
  )
  return {
    ...actual,
    useIptvHistoryIndex: () => historyIndex.current,
    useReportPosition: () => vi.fn(),
  }
})
// useModalA11y attaches focus-trap effects we don't need here.
vi.mock('../../lib/hooks/useModalA11y', () => ({
  useModalA11y: () => ({ current: null }),
}))
vi.mock('../player/IptvPlayer', () => ({
  default: (props: { startPositionSecs?: number }) => {
    engineProps.current = props
    return <div data-testid="player-engine" />
  },
}))

function historyRow(overrides: Partial<HistoryRow>): HistoryRow {
  return {
    sub: 'plex:1',
    kind: 'vod',
    item_id: '7',
    position_secs: 0,
    duration_secs: 3600,
    watched_at: '2026-06-12T00:00:00Z',
    completed: 0,
    ...overrides,
  }
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  grantVodMock.mockReset()
  grantVodMock.mockResolvedValue({ url: 'https://api.example/vod.m3u8', delivery: 'hls' })
  historyIndex.current = new Map()
  engineProps.current = null
})

afterEach(cleanup)

describe('VodTab — resume-or-start-over before granting', () => {
  it('a) shows the prompt and does NOT grant when a resume row exists', async () => {
    historyIndex.current = new Map<string, HistoryRow>([
      ['vod:7', historyRow({ position_secs: 600, completed: 0 })],
    ])

    render(<VodTab />)
    fireEvent.click(screen.getByText('Heat'))
    await flush()

    expect(screen.getByRole('button', { name: 'Resume from 10:00' })).toBeInTheDocument()
    expect(grantVodMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('player-engine')).not.toBeInTheDocument()
  })

  it('b) Resume mints the grant once and starts at the saved offset', async () => {
    historyIndex.current = new Map<string, HistoryRow>([
      ['vod:7', historyRow({ position_secs: 600, completed: 0 })],
    ])

    render(<VodTab />)
    fireEvent.click(screen.getByText('Heat'))
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Resume from 10:00' }))
    await flush()

    expect(grantVodMock).toHaveBeenCalledTimes(1)
    expect(grantVodMock).toHaveBeenCalledWith('7')
    expect(screen.getByTestId('player-engine')).toBeInTheDocument()
    expect(engineProps.current?.startPositionSecs).toBe(600)
  })

  it('c) Start over mints the grant once with no offset', async () => {
    historyIndex.current = new Map<string, HistoryRow>([
      ['vod:7', historyRow({ position_secs: 600, completed: 0 })],
    ])

    render(<VodTab />)
    fireEvent.click(screen.getByText('Heat'))
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Start from beginning' }))
    await flush()

    expect(grantVodMock).toHaveBeenCalledTimes(1)
    expect(grantVodMock).toHaveBeenCalledWith('7')
    expect(screen.getByTestId('player-engine')).toBeInTheDocument()
    expect(engineProps.current?.startPositionSecs).toBeUndefined()
  })

  it('d) no resume row → grants immediately with no prompt', async () => {
    render(<VodTab />)
    fireEvent.click(screen.getByText('Heat'))
    await flush()

    expect(screen.queryByRole('button', { name: /Resume from/ })).not.toBeInTheDocument()
    expect(grantVodMock).toHaveBeenCalledTimes(1)
    expect(grantVodMock).toHaveBeenCalledWith('7')
    expect(screen.getByTestId('player-engine')).toBeInTheDocument()
    expect(engineProps.current?.startPositionSecs).toBeUndefined()
  })
})
