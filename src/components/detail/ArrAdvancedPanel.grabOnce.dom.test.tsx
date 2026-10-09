// @vitest-environment jsdom
//
// A grabbed release must stay grabbed. On a loaded NAS a grab takes 25-45s and
// the only success cue was a toast, so the row re-armed and a second click
// queued the identical release again (Guardians Vol. 3 downloaded twice).

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArrRelease } from '../../lib/api/arrAdvanced'

const { releasesMock, grabMock } = vi.hoisted(() => ({ releasesMock: vi.fn(), grabMock: vi.fn() }))

vi.mock('../../lib/api/radarr', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api/radarr')>('../../lib/api/radarr')
  return { ...actual, radarr: { ...actual.radarr, releases: releasesMock, grabRelease: grabMock } }
})
vi.mock('../../lib/hooks/useLimits', () => ({ useLimits: () => ({ data: { maxMovieGb: 20 } }) }))

import { InteractiveSearchSection } from './ArrAdvancedPanel'

afterEach(cleanup)

const RELEASE: ArrRelease = {
  guid: 'g-1', indexerId: 3, title: 'Guardians.Vol.3.1080p.WEB-DL', size: 9.8e9, sizeGb: 9.8,
  protocol: 'usenet', indexer: 'NxbGeek', ageHours: 12, quality: 'WEBDL-1080p', qualityWeight: 10,
  languages: ['English'], rejected: false, rejections: [], overCap: false,
}

describe('InteractiveSearchSection — grab once', () => {
  it('marks a grabbed row Grabbed and refuses a second grab of it', async () => {
    releasesMock.mockResolvedValue([RELEASE])
    grabMock.mockResolvedValue({ status: 'grabbed', title: RELEASE.title, sizeGb: RELEASE.sizeGb })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <InteractiveSearchSection kind="movie" itemId={926} monitored onToast={() => {}} autoOpenSearch
          confirm={vi.fn() as never} />
      </QueryClientProvider>,
    )

    fireEvent.click(await screen.findByRole('button', { name: `Grab ${RELEASE.title}` }))
    const done = await screen.findByRole('button', { name: `Grabbed ${RELEASE.title}` })
    expect(done).toBeDisabled()
    fireEvent.click(done)
    await waitFor(() => expect(grabMock).toHaveBeenCalledTimes(1))
  })
})
