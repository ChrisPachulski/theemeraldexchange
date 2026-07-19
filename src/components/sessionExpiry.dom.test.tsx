// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react'
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DevicesPanel } from './auth/DevicesPanel'
import { UsageDashboard } from './downloads/UsageDashboard'

function mount(ui: ReactElement, errors: unknown[]) {
  const client = new QueryClient({
    queryCache: new QueryCache({ onError: (error) => errors.push(error) }),
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('protected component fetchers', () => {
  it('preserves a DevicesPanel 401 before the empty-device fallback', async () => {
    const errors: unknown[] = []
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'unauthenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    mount(<DevicesPanel />, errors)

    await waitFor(() => expect(errors[0]).toMatchObject({ status: 401 }))
  })

  it('keeps DevicesPanel empty-state fallback for upstream 5xx failures', async () => {
    const errors: unknown[] = []
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 502 }))

    const { findByText } = mount(<DevicesPanel />, errors)

    await findByText(/Nothing paired yet/)
    expect(errors).toEqual([])
  })

  it('preserves UsageDashboard 401s as status-carrying errors', async () => {
    const errors: unknown[] = []
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'unauthenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    mount(<UsageDashboard />, errors)

    await waitFor(() => {
      expect(errors).toHaveLength(2)
      expect(errors).toEqual([
        expect.objectContaining({ status: 401 }),
        expect.objectContaining({ status: 401 }),
      ])
    })
  })
})
