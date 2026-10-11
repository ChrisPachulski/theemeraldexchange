// @vitest-environment jsdom
//
// Both add dialogs stay mounted between titles (TvTab / MoviesTab render them
// once). A Quality or Folder pick must apply to that one add only: on
// 2026-10-09 a pick left in place sent four shows in a row to Sonarr as
// Ultra-HD, where nothing fits the per-episode cap.

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddMovieModal } from './AddMovieModal'
import { AddSeriesModal } from './AddSeriesModal'
import type { MovieSearchResult } from '../../lib/api/radarr'
import type { SeriesSearchResult } from '../../lib/api/sonarr'

const { profiles, folders } = vi.hoisted(() => ({
  profiles: { data: [{ id: 4, name: 'HD-1080p' }, { id: 5, name: 'Ultra-HD' }] },
  folders: { data: [{ id: 1, path: '/a' }, { id: 2, path: '/b' }] },
}))
vi.mock('../../lib/hooks/useSonarrLibrary', () => ({
  useSonarrProfiles: () => profiles,
  useSonarrRootFolders: () => folders,
}))
vi.mock('../../lib/hooks/useRadarrLibrary', () => ({
  useRadarrProfiles: () => profiles,
  useRadarrRootFolders: () => folders,
}))
vi.mock('../../lib/hooks/useLimits', () => ({ useLimits: () => ({ data: { defaultProfileName: 'choose me' } }) }))

afterEach(cleanup)

// jsdom doesn't implement <dialog> showModal/close; polyfill the open toggle.
beforeEach(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () { this.open = true }
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () { this.open = false }
  }
})

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const wrap = (ui: ReactElement) => <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
const quality = () => screen.getByRole('combobox', { name: /^Quality/ }) as HTMLSelectElement
const folder = () => screen.getByRole('combobox', { name: /^Folder/ }) as HTMLSelectElement

function pickThenSwitch(rerenderWith: (n: 1 | 2) => ReactElement) {
  const view = render(rerenderWith(1))
  expect(quality().value).toBe('4')
  fireEvent.change(quality(), { target: { value: '5' } })
  fireEvent.change(folder(), { target: { value: '/b' } })
  expect(quality().value).toBe('5')
  view.rerender(rerenderWith(2))
  expect(quality().value).toBe('4')
  expect(folder().value).toBe('/a')
}

describe('add dialogs: Quality/Folder picks do not carry over to the next title', () => {
  it('series dialog', () => {
    const show = (n: number) => ({ tvdbId: n, title: `Show ${n}`, year: 2000, seasons: [] }) as SeriesSearchResult
    pickThenSwitch((n) => wrap(<AddSeriesModal series={show(n)} onClose={() => {}} />))
  })

  it('movie dialog', () => {
    const movie = (n: number) => ({ tmdbId: n, title: `Movie ${n}`, year: 2000 }) as MovieSearchResult
    pickThenSwitch((n) => wrap(<AddMovieModal movie={movie(n)} onClose={() => {}} />))
  })
})
