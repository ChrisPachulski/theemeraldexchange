// @vitest-environment jsdom
//
// 2026-10-16 review item 30: a watchlist toggle that resolved after an account
// switch wrote the previous account's list into the next account's cache.

import { describe, it, expect, vi } from 'vitest'
import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { listMock, toggleMock, useAuthMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  toggleMock: vi.fn(),
  useAuthMock: vi.fn(),
}))
vi.mock('../api/watchlist', async (orig) => ({
  ...(await orig<typeof import('../api/watchlist')>()),
  watchlistApi: { list: listMock, toggle: toggleMock },
}))
vi.mock('../auth', () => ({ useAuth: useAuthMock }))

import { useToggleWatchlist, useWatchlist } from './useWatchlist'

describe('useToggleWatchlist', () => {
  it("does not write a late response into the next account's watchlist", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    const aliceList = [{ kind: 'movie', id: 603, title: 'The Matrix' }]
    let finish!: (v: unknown) => void
    toggleMock.mockReturnValue(new Promise((ok) => (finish = ok)))
    listMock.mockResolvedValue([])

    useAuthMock.mockReturnValue({ user: { sub: 'plex:alice' } })
    const toggle = renderHook(() => useToggleWatchlist(), { wrapper })
    act(() => toggle.result.current.mutate({ kind: 'movie', id: 603, title: 'The Matrix', on: true } as never))

    // Account switch: the auth layer clears the cache and Bob's list loads.
    useAuthMock.mockReturnValue({ user: { sub: 'plex:bob' } })
    qc.clear()
    const bob = renderHook(() => useWatchlist(), { wrapper })
    await waitFor(() => expect(bob.result.current.data).toEqual([]))

    await act(async () => finish(aliceList))
    bob.rerender()
    expect(bob.result.current.data).toEqual([])
  })
})
