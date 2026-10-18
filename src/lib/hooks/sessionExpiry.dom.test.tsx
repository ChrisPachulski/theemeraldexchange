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
})
