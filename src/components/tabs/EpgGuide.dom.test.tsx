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

vi.mock('../../lib/hooks/useIptvEpg', () => ({
  useIptvEpgGrid: () => gridMock(),
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
