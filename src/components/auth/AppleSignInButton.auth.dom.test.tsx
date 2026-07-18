// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '../../lib/auth'
import { AppleSignInButton } from './AppleSignInButton'

const sdk = vi.hoisted(() => ({ runAppleSignIn: vi.fn() }))

vi.mock('./appleSdk', () => ({
  isAppleSignInConfigured: () => true,
  runAppleSignIn: sdk.runAppleSignIn,
}))

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('AppleSignInButton shared ceremony state', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/api/me')) {
          return Promise.resolve(json({ error: 'unauthenticated' }, 401))
        }
        if (url.endsWith('/api/auth/methods')) {
          return Promise.resolve(
            json({ plex: true, apple: true, google: false, passkey: true }),
          )
        }
        if (url.endsWith('/api/setup/status')) {
          return Promise.resolve(json({ claimable: false }))
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`))
      }),
    )
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('keeps both rendered Apple buttons in sync and releases them on SDK cancellation', async () => {
    const pendingSdk = deferred<{ identityToken: string; nonce: string }>()
    sdk.runAppleSignIn.mockReturnValueOnce(pendingSdk.promise)
    const user = userEvent.setup()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <AppleSignInButton />
          <AppleSignInButton />
        </AuthProvider>
      </QueryClientProvider>,
    )

    const buttons = screen.getAllByRole('button', { name: 'Sign in with Apple' })
    await user.click(buttons[0])

    await waitFor(() => {
      for (const button of buttons) {
        expect(button).toBeDisabled()
        expect(button).toHaveTextContent('Signing in…')
      }
    })
    expect(sdk.runAppleSignIn).toHaveBeenCalledOnce()

    pendingSdk.reject({ error: { message: 'popup_closed_by_user' } })

    await waitFor(() => {
      for (const button of buttons) {
        expect(button).toBeEnabled()
        expect(button).toHaveTextContent('Sign in with Apple')
      }
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('releases an unmounted pre-token attempt without posting or clearing its replacement', async () => {
    const firstSdk = deferred<{ identityToken: string; nonce: string }>()
    const secondSdk = deferred<{ identityToken: string; nonce: string }>()
    sdk.runAppleSignIn
      .mockReturnValueOnce(firstSdk.promise)
      .mockReturnValueOnce(secondSdk.promise)
    const user = userEvent.setup()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const tree = (showApple: boolean) => (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{showApple ? <AppleSignInButton /> : null}</AuthProvider>
      </QueryClientProvider>
    )
    const view = render(tree(true))

    await user.click(screen.getByRole('button', { name: 'Sign in with Apple' }))
    expect(screen.getByRole('button', { name: 'Sign in with Apple' })).toHaveTextContent(
      'Signing in…',
    )

    view.rerender(tree(false))
    view.rerender(tree(true))
    const replacement = screen.getByRole('button', { name: 'Sign in with Apple' })
    expect(replacement).toBeEnabled()
    await user.click(replacement)
    expect(replacement).toHaveTextContent('Signing in…')

    await act(async () => {
      firstSdk.resolve({ identityToken: 'stale-token', nonce: 'stale-nonce' })
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
    })

    expect(
      vi.mocked(fetch).mock.calls.filter(([input]) =>
        String(input).endsWith('/api/auth/apple'),
      ),
    ).toHaveLength(0)
    expect(replacement).toBeDisabled()
    expect(replacement).toHaveTextContent('Signing in…')

    secondSdk.reject({ error: 'popup_closed_by_user' })
    await waitFor(() => expect(replacement).toBeEnabled())
  })
})
