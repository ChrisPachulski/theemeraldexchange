// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

vi.mock('./components/walkthrough/Walkthrough', () => ({
  Walkthrough: ({ initialInviteCode }: { initialInviteCode?: string }) => (
    <div data-invite-code={initialInviteCode}>Public walkthrough</div>
  ),
}))

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => body,
  } as Response
}

describe('AuthGate session availability', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('does not render the public walkthrough on failure and Retry can recover to 401', async () => {
    let recover = false
    let meCalls = 0
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/me')) {
        meCalls += 1
        return Promise.resolve(
          recover
            ? json({ error: 'unauthenticated' }, 401)
            : json({ error: 'unavailable' }, 503),
        )
      }
      if (url.endsWith('/api/auth/methods')) {
        return Promise.resolve(
          json({ plex: true, apple: false, google: false, passkey: true }),
        )
      }
      if (url.endsWith('/api/setup/status')) {
        return Promise.resolve(json({ claimable: false }))
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    )
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(screen.getByText('The Emerald Exchange')).toBeInTheDocument()
    expect(screen.queryByText('Public walkthrough')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
    expect(meCalls).toBe(3)

    recover = true
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => {
      await vi.runAllTimersAsync()
      for (let i = 0; i < 10; i += 1) await Promise.resolve()
    })

    expect(meCalls).toBe(4)
    expect(screen.getByText('Public walkthrough')).toBeInTheDocument()
  })

  it('passes an ephemeral invite through the anonymous gate', async () => {
    const sentinel = 'APP_INVITE_SENTINEL'
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/me')) {
        return Promise.resolve(json({ error: 'unauthenticated' }, 401))
      }
      if (url.endsWith('/api/auth/methods')) {
        return Promise.resolve(
          json({ plex: true, apple: false, google: false, passkey: true }),
        )
      }
      if (url.endsWith('/api/setup/status')) {
        return Promise.resolve(json({ claimable: false }))
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const InviteAwareApp = App as React.ComponentType<{ initialInviteCode: string }>

    render(
      <QueryClientProvider client={queryClient}>
        <InviteAwareApp initialInviteCode={sentinel} />
      </QueryClientProvider>,
    )
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(screen.getByText('Public walkthrough')).toHaveAttribute(
      'data-invite-code',
      sentinel,
    )
  })
})
