// @vitest-environment jsdom
//
// Mounted-DOM tests for EpisodePicker's modal accessibility contract. The
// static-markup suite (EpisodePicker.test.tsx) pins the dialog semantics and
// list states; the extracted keydown handler is unit-tested in
// useModalA11y.test.ts. This file mounts the REAL component and proves the
// useModalA11y wiring actually delivers what aria-modal="true" promises:
// initial focus capture, the Tab/Shift+Tab focus trap, Escape-to-close, and
// focus restoration on unmount.

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EpisodePicker } from './EpisodePicker'
import type { MediaEpisode } from '../../lib/api/media'

const { useMediaEpisodesMock } = vi.hoisted(() => ({ useMediaEpisodesMock: vi.fn() }))
vi.mock('../../lib/hooks/useMediaLibrary', () => ({
  useMediaEpisodes: useMediaEpisodesMock,
}))

beforeAll(() => {
  // jsdom does no layout, so offsetParent is always null — which would make
  // useModalA11y's visibility filter treat every focusable as hidden. Report
  // any attached element as "visible" (the standard jsdom shim); CSS-hidden
  // elements aren't part of these fixtures.
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      return (this as HTMLElement).parentElement
    },
  })
})

function episode(overrides: Partial<MediaEpisode> = {}): MediaEpisode {
  return {
    id: 7,
    showId: 3,
    season: 1,
    episode: 2,
    title: 'Half Loop',
    airDate: null,
    fileId: 42,
    ...overrides,
  }
}

function renderPicker(opts: { onClose?: () => void; onPlay?: (ep: MediaEpisode, label: string) => void } = {}) {
  return render(
    <EpisodePicker
      showId={3}
      showTitle="Severance"
      onClose={opts.onClose ?? (() => {})}
      onPlay={opts.onPlay ?? (() => {})}
    />,
  )
}

beforeEach(() => {
  useMediaEpisodesMock.mockReset()
  useMediaEpisodesMock.mockReturnValue({
    isPending: false,
    error: null,
    data: { items: [episode(), episode({ id: 8, season: 1, episode: 3, title: 'In Perpetuity' })] },
  })
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('EpisodePicker (mounted) — modal a11y contract', () => {
  it('moves focus into the modal on open (first focusable = the close button)', () => {
    renderPicker()

    expect(screen.getByRole('button', { name: 'Close episode list' })).toHaveFocus()
  })

  it('captures focus in the loading state too (close button, before any rows exist)', () => {
    useMediaEpisodesMock.mockReturnValue({ isPending: true, error: null, data: undefined })
    renderPicker()

    // The container stays focusable (tabIndex=-1) as the trap's fallback
    // target, but with the close button present it takes initial focus.
    const dialog = screen.getByRole('dialog', { name: 'Severance episodes' })
    expect(dialog).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('button', { name: 'Close episode list' })).toHaveFocus()
  })

  it('Escape closes the picker', async () => {
    const onClose = vi.fn()
    renderPicker({ onClose })
    const user = userEvent.setup()

    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Tab on the last focusable wraps to the first (forward trap)', () => {
    renderPicker()
    const dialog = screen.getByRole('dialog', { name: 'Severance episodes' })
    const episodeButtons = screen.getAllByRole('button', { name: /S01E0[23]/ })
    const last = episodeButtons[episodeButtons.length - 1]
    last.focus()

    fireEvent.keyDown(dialog, { key: 'Tab' })

    expect(screen.getByRole('button', { name: 'Close episode list' })).toHaveFocus()
  })

  it('Shift+Tab on the first focusable wraps to the last (backward trap)', () => {
    renderPicker()
    const dialog = screen.getByRole('dialog', { name: 'Severance episodes' })
    const close = screen.getByRole('button', { name: 'Close episode list' })
    close.focus()

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })

    const episodeButtons = screen.getAllByRole('button', { name: /S01E0[23]/ })
    expect(episodeButtons[episodeButtons.length - 1]).toHaveFocus()
  })

  it('Tab between interior focusables is left to the browser (no hijack)', () => {
    renderPicker()
    const dialog = screen.getByRole('dialog', { name: 'Severance episodes' })
    const [firstEpisode] = screen.getAllByRole('button', { name: /S01E02/ })
    firstEpisode.focus()

    const event = fireEvent.keyDown(dialog, { key: 'Tab' })

    // Not the wrap case → the handler must NOT preventDefault (fireEvent
    // returns false when default was prevented).
    expect(event).toBe(true)
    expect(firstEpisode).toHaveFocus()
  })

  it('restores focus to the previously-focused element on unmount', () => {
    const opener = document.createElement('button')
    opener.textContent = 'Watch episodes'
    document.body.appendChild(opener)
    opener.focus()

    const { unmount } = renderPicker()
    expect(opener).not.toHaveFocus()

    unmount()

    expect(opener).toHaveFocus()
  })

  it('clicking an episode fires onPlay with the episode and its full label', async () => {
    const onPlay = vi.fn()
    renderPicker({ onPlay })
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: /S01E03/ }))

    expect(onPlay).toHaveBeenCalledTimes(1)
    expect(onPlay).toHaveBeenCalledWith(
      expect.objectContaining({ id: 8, season: 1, episode: 3 }),
      'Severance — S01E03 · In Perpetuity',
    )
  })

  it('clicking the close button closes the picker', async () => {
    const onClose = vi.fn()
    renderPicker({ onClose })
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Close episode list' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
