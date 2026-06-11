import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EpisodePicker } from './EpisodePicker'
import type { MediaEpisode } from '../../lib/api/media'

// The vitest environment is node (no jsdom), so these are static-markup
// renders asserting the dialog semantics and a11y wiring. The focus-trap /
// Escape behaviour wired through useModalA11y is unit-tested directly in
// src/lib/hooks/useModalA11y.test.ts against the extracted keydown handler.

const { useMediaEpisodesMock } = vi.hoisted(() => ({ useMediaEpisodesMock: vi.fn() }))
vi.mock('../../lib/hooks/useMediaLibrary', () => ({
  useMediaEpisodes: useMediaEpisodesMock,
}))

type EpisodesQuery = {
  isPending: boolean
  error: Error | null
  data: { items: MediaEpisode[] } | undefined
}

function queryState(state: Partial<EpisodesQuery>): EpisodesQuery {
  return { isPending: false, error: null, data: undefined, ...state }
}

function episode(overrides: Partial<MediaEpisode> = {}): MediaEpisode {
  return {
    id: 7,
    showId: 3,
    season: 1,
    episode: 2,
    title: 'Pilot, Part Two',
    airDate: null,
    fileId: 42,
    ...overrides,
  }
}

function render() {
  return renderToStaticMarkup(
    <EpisodePicker showId={3} showTitle="Severance" onClose={() => {}} onPlay={() => {}} />,
  )
}

beforeEach(() => {
  useMediaEpisodesMock.mockReset()
})

describe('EpisodePicker', () => {
  it('renders a labelled modal dialog with the a11y wiring useModalA11y needs', () => {
    useMediaEpisodesMock.mockReturnValue(queryState({ isPending: true }))

    const html = render()

    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-label="Severance episodes"')
    // The container must be focusable so the trap can land on it when the
    // episode list hasn't rendered any buttons yet.
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('aria-label="Close episode list"')
  })

  it('shows the loading state while episodes are pending', () => {
    useMediaEpisodesMock.mockReturnValue(queryState({ isPending: true }))

    expect(render()).toContain('Loading episodes…')
  })

  it('shows a readable error when the episode query fails', () => {
    useMediaEpisodesMock.mockReturnValue(queryState({ error: new Error('boom') }))

    const html = render()

    expect(html).toContain('Couldn&#x27;t load episodes.')
    expect(html).not.toContain('boom')
  })

  it('shows the empty state when the show has no scanned episodes', () => {
    useMediaEpisodesMock.mockReturnValue(queryState({ data: { items: [] } }))

    expect(render()).toContain('No episodes scanned for this show.')
  })

  it('lists episodes as buttons with zero-padded codes and titles', () => {
    useMediaEpisodesMock.mockReturnValue(
      queryState({
        data: {
          items: [episode(), episode({ id: 8, season: 2, episode: 11, title: null })],
        },
      }),
    )

    const html = render()

    expect(html).toContain('S01E02')
    expect(html).toContain('Pilot, Part Two')
    expect(html).toContain('S02E11')
    expect(html).toContain('Untitled')
  })
})
