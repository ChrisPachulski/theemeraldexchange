// @vitest-environment jsdom
//
// Mounted-DOM test for the EPG guide's pinned now/next detail pane (the Apple-
// guide parity feature). The grid hook is mocked at the module boundary so the
// component mounts without react-query/network. The point: hovering a programme
// block fills the pane with that show's title, synopsis, and the NEXT programme —
// none of which is visible before you hover.

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import EpgGuide from './EpgGuide'
import type { EpgGridDto } from '../../lib/api/iptv'

const { gridMock } = vi.hoisted(() => ({ gridMock: vi.fn() }))

// The detail pane hosts the inline Replay pill, which needs the nav-transition
// context; stub it so the guide renders without the app shell.
vi.mock('../../lib/navTransition', () => ({ useNavTransition: () => ({ replay: () => {} }) }))
vi.mock('../../lib/hooks/useIptvEpg', () => ({
  useIptvEpgGrid: (...args: unknown[]) => gridMock(...args),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function rowWithLiveAndNext(): EpgGridDto {
  const now = Date.now()
  return {
    stream_id: 1,
    num: 101,
    name: 'US ESPN',
    stream_icon: null,
    epg_channel_id: 'espn',
    tv_archive: 0,
    tv_archive_duration: null,
    programmes: [
      {
        channel_id: 'espn',
        start_utc: new Date(now - 10 * 60_000).toISOString(), // started 10m ago
        stop_utc: new Date(now + 20 * 60_000).toISOString(), // ends in 20m → live
        title: 'SportsCenter',
        description: 'Live scores and highlights',
      },
      {
        channel_id: 'espn',
        start_utc: new Date(now + 20 * 60_000).toISOString(),
        stop_utc: new Date(now + 80 * 60_000).toISOString(),
        title: 'NFL Live',
        description: null,
      },
    ],
  }
}

describe('EpgGuide detail pane', () => {
  it('fills the pinned pane with the show, synopsis, and NEXT on hover', () => {
    gridMock.mockReturnValue({ data: [rowWithLiveAndNext()], isLoading: false, error: null })
    render(
      <EpgGuide
        categoryId={undefined}
        categoryIds={[6]}
        categoriesLoaded
        q=""
        onPlayLive={vi.fn()}
        onPlayCatchup={vi.fn()}
      />,
    )

    // Before hover: the pane shows the hint; the synopsis/NEXT are not rendered.
    expect(screen.getByText(/Hover a programme/i)).toBeInTheDocument()
    expect(screen.queryByText('Live scores and highlights')).not.toBeInTheDocument()
    expect(screen.queryByText('NEXT')).not.toBeInTheDocument()

    // Hover the live programme block (its title is in the grid cell).
    fireEvent.mouseEnter(screen.getByTitle(/SportsCenter/))

    // After hover: the pane carries the synopsis, the NEXT label + next title.
    expect(screen.getByText('Live scores and highlights')).toBeInTheDocument()
    expect(screen.getByText('NEXT')).toBeInTheDocument()
    // "NFL Live" now appears in the pane's NEXT line (and as its own block).
    expect(screen.getAllByText('NFL Live').length).toBeGreaterThanOrEqual(1)
    // Jump-to-live control is always present.
    expect(screen.getByRole('button', { name: /Jump to live/i })).toBeInTheDocument()
  })

  it('waits for categories before loading the curated default (no premature dump)', () => {
    gridMock.mockReturnValue({ data: undefined, isLoading: false, error: null })
    render(
      <EpgGuide
        categoryId={undefined}
        categoryIds={[]}
        categoriesLoaded={false}
        q=""
        onPlayLive={vi.fn()}
        onPlayCatchup={vi.fn()}
      />,
    )
    // enabled=false → render the loading state rather than an empty grid.
    expect(screen.getByText(/Loading guide/i)).toBeInTheDocument()
  })
})

function liveRow(stream_id: number, name: string, title: string): EpgGridDto {
  const now = Date.now()
  return {
    stream_id,
    num: stream_id,
    name,
    stream_icon: null,
    epg_channel_id: name,
    tv_archive: 0,
    tv_archive_duration: null,
    programmes: [
      {
        channel_id: name,
        start_utc: new Date(now - 10 * 60_000).toISOString(),
        stop_utc: new Date(now + 20 * 60_000).toISOString(),
        title,
        description: null,
      },
    ],
  }
}

function renderGuide(props: Partial<Parameters<typeof EpgGuide>[0]> = {}) {
  return render(
    <EpgGuide categoryIds={[6]} categoriesLoaded q="" onPlayLive={vi.fn()} onPlayCatchup={vi.fn()} {...props} />,
  )
}

describe('EpgGuide failure, empty and stale states', () => {
  it('keeps the painted rows on a failed refetch and offers Retry', () => {
    const refetch = vi.fn()
    gridMock.mockReturnValue({ data: [rowWithLiveAndNext()], isLoading: false, error: new Error('502'), refetch })
    renderGuide()

    expect(screen.getByTitle(/SportsCenter/)).toBeInTheDocument()
    expect(screen.getByText('Guide may be out of date.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(refetch).toHaveBeenCalled()
  })

  it('offers Retry when the first load fails with nothing painted', () => {
    const refetch = vi.fn()
    gridMock.mockReturnValue({ data: undefined, isLoading: false, error: new Error('502'), refetch })
    renderGuide()

    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load the guide.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(refetch).toHaveBeenCalled()
  })

  it('fails closed with a hint, fetching nothing, when no guide category qualifies', () => {
    gridMock.mockReturnValue({ data: [rowWithLiveAndNext()], isLoading: false, error: null })
    renderGuide({ categoryIds: [] })

    expect(screen.getByText(/No live categories chosen/)).toBeInTheDocument()
    for (const call of gridMock.mock.calls) expect((call[2] as { enabled: boolean }).enabled).toBe(false)
  })
})

describe('EpgGuide favorites and filtering', () => {
  it('pins favorite channels to the top and toggles the star', () => {
    gridMock.mockReturnValue({
      data: [liveRow(1, 'US ABC', 'News'), liveRow(2, 'US CBS', 'Sports')],
      isLoading: false,
      error: null,
    })
    const onToggleFavorite = vi.fn()
    renderGuide({ favorites: new Set([2]), onToggleFavorite })

    const names = screen.getAllByTitle(/^Watch .* live$/).map((el) => el.getAttribute('title'))
    expect(names).toEqual(['Watch US CBS live', 'Watch US ABC live'])
    fireEvent.click(screen.getByRole('button', { name: 'Unfavorite US CBS' }))
    expect(onToggleFavorite).toHaveBeenCalledWith(2, true)
    fireEvent.click(screen.getByRole('button', { name: 'Favorite US ABC' }))
    expect(onToggleFavorite).toHaveBeenCalledWith(1, false)
  })

  it('a search keeps channels airing a matching programme, unioned with server name matches', () => {
    gridMock.mockImplementation((_from: string, _to: string, opts: { q?: string }) =>
      opts.q
        ? { data: [liveRow(9, 'US Celtics Network', 'Pregame')], isLoading: false, error: null }
        : {
            data: [liveRow(1, 'US ESPN', 'NBA: Celtics at Knicks'), liveRow(2, 'US CNN', 'Newsroom')],
            isLoading: false,
            error: null,
          },
    )
    renderGuide({ q: 'celtics' })

    const names = screen.getAllByTitle(/^Watch .* live$/).map((el) => el.getAttribute('title'))
    expect(names).toEqual(['Watch US Celtics Network live', 'Watch US ESPN live'])
  })
})
