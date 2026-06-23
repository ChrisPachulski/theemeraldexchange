// @vitest-environment jsdom
//
// Mounted-DOM test for the Manage-episodes season selector. A multi-season
// series returns 100+ episodes; the section must NOT render a flat list that
// hides everything past season 1 (the reported "only shows a single season"
// bug). It shows one season at a time behind a selector, defaulting to the
// first, and switching the selector swaps the visible episodes.

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'
import { ManageEpisodesSection } from './ArrAdvancedPanel'
import type { Episode } from '../../lib/api/sonarr'

afterEach(cleanup)

// Each episode renders as "S{ss}E{ee} {title}"; assert on the padded code,
// which is unique per episode, via substring match.
function ep(seasonNumber: number, episodeNumber: number): Episode {
  return {
    id: seasonNumber * 100 + episodeNumber,
    seriesId: 1,
    seasonNumber,
    episodeNumber,
    title: 'Episode',
    hasFile: false,
    monitored: true,
  }
}

// Three seasons (0 = specials, 1, 2).
const EPISODES: Episode[] = [ep(0, 1), ep(1, 1), ep(1, 2), ep(2, 1), ep(2, 2), ep(2, 3)]

function mount(episodes: Episode[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ManageEpisodesSection
        kind="tv"
        itemId={1}
        monitored
        episodes={episodes}
        onToast={() => {}}
        qc={qc}
      />
    </QueryClientProvider>,
  )
}

describe('ManageEpisodesSection — season selector', () => {
  it('defaults to the first season and does NOT render other seasons', () => {
    mount(EPISODES)
    expect(screen.getByText(/S00E01/)).toBeInTheDocument() // specials (first)
    expect(screen.queryByText(/S01E01/)).not.toBeInTheDocument()
    expect(screen.queryByText(/S02E03/)).not.toBeInTheDocument()
  })

  it('offers every season and switching the selector swaps the visible episodes', () => {
    mount(EPISODES)
    const select = screen.getByRole('combobox')
    expect(screen.getByRole('option', { name: 'Specials' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Season 1' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Season 2' })).toBeInTheDocument()

    fireEvent.change(select, { target: { value: '2' } })
    expect(screen.getByText(/S02E01/)).toBeInTheDocument()
    expect(screen.getByText(/S02E03/)).toBeInTheDocument()
    expect(screen.queryByText(/S00E01/)).not.toBeInTheDocument()
    expect(screen.queryByText(/S01E02/)).not.toBeInTheDocument()
  })

  it('hides the selector for a single-season series (no needless control)', () => {
    mount([ep(1, 1), ep(1, 2)])
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByText(/S01E01/)).toBeInTheDocument()
    expect(screen.getByText(/S01E02/)).toBeInTheDocument()
  })
})
