// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react'
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsersTab } from './UsersTab'

vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ signOut: vi.fn() }),
}))
vi.mock('../feedback/LoadingPulse', () => ({ LoadingPulse: () => null }))

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('UsersTab session expiry', () => {
  it('preserves a 401 as a status-carrying error without retrying it', async () => {
    const errors: unknown[] = []
    const client = new QueryClient({
      queryCache: new QueryCache({ onError: (error) => errors.push(error) }),
      defaultOptions: { queries: { retry: false } },
    })
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'unauthenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    render(
      <QueryClientProvider client={client}>
        <UsersTab />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(errors[0]).toMatchObject({ status: 401 }))
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
