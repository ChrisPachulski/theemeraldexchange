// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFeedback } from './useUserFeedback'
import { usePlexLinks } from './usePlexLinks'

function wrapper(errors: unknown[]) {
  const client = new QueryClient({
    queryCache: new QueryCache({ onError: (error) => errors.push(error) }),
    defaultOptions: { queries: { retry: false } },
  })
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('protected hook fetchers', () => {
  it('preserves a feedback 401 as a status-carrying query error', async () => {
    const errors: unknown[] = []
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'unauthenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    renderHook(() => useFeedback(), { wrapper: wrapper(errors) })

    await waitFor(() => expect(errors[0]).toMatchObject({ status: 401 }))
  })

  it('preserves both Plex endpoint 401s before their degraded fallbacks', async () => {
    const errors: unknown[] = []
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'unauthenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    renderHook(() => usePlexLinks(), { wrapper: wrapper(errors) })

    await waitFor(() => {
      expect(errors).toHaveLength(2)
      expect(errors).toEqual([
        expect.objectContaining({ status: 401 }),
        expect.objectContaining({ status: 401 }),
      ])
    })
  })

  it('keeps Plex links in degraded search mode for upstream 5xx failures', async () => {
    const errors: unknown[] = []
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 502 })),
    )

    const { result } = renderHook(() => usePlexLinks(), {
      wrapper: wrapper(errors),
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(errors).toEqual([])
    expect(result.current.linkFor('movie', { title: 'The Matrix' })).toContain(
      'search?query=The%20Matrix',
    )
  })
})
