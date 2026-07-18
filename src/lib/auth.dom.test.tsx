// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AuthProvider, useAuth } from './auth'

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('Content-Type', 'application/json')
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    headers: responseHeaders,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function AuthProbe() {
  const { signIn, user, signInError } = useAuth()
  return (
    <>
      <button type="button" onClick={() => void signIn()}>
        Start Plex sign-in
      </button>
      <button type="button" onClick={() => void signIn('A'.repeat(20))}>
        Start with incomplete invite
      </button>
      <output aria-label="signed-in user">{user?.username ?? ''}</output>
      {signInError && <p role="alert">{signInError}</p>}
    </>
  )
}

describe('Plex popup completion', () => {
  let popup: { closed: boolean; close: ReturnType<typeof vi.fn>; location: { href: string } }
  let fetchMock: ReturnType<typeof vi.fn>
  let plexCheck: Mock<(init?: RequestInit) => Promise<Response>>

  const authorized = {
    status: 'authorized',
    user: { sub: 'plex:42', username: 'brother', role: 'user', auth_mode: 'plex' },
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-18T12:00:00Z'))
    popup = { closed: false, close: vi.fn(), location: { href: '' } }
    plexCheck = vi.fn((_init?: RequestInit) =>
      Promise.resolve(json({ status: 'pending' })),
    )
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)

    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
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
      if (url.endsWith('/api/auth/plex/config')) {
        return Promise.resolve(json({ clientId: 'client-id', product: 'The Emerald Exchange' }))
      }
      if (url.startsWith('https://plex.tv/api/v2/pins?')) {
        return Promise.resolve(json({ id: 123, code: 'plex-code', authToken: null }, 201))
      }
      if (url.endsWith('/api/auth/plex/check')) return plexCheck(init)
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function renderAuth(queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })) {
    return {
      queryClient,
      ...render(
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <AuthProbe />
          </AuthProvider>
        </QueryClientProvider>,
      ),
    }
  }

  async function startPlexSignIn() {
    fireEvent.click(screen.getByRole('button', { name: 'Start Plex sign-in' }))
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve()
    })
    expect(popup.location.href).toContain('app.plex.tv/auth')
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  it('accepts an authorized PIN even when the Plex popup has just closed', async () => {
    plexCheck.mockResolvedValueOnce(json(authorized))
    renderAuth()
    await startPlexSignIn()

    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls, urls.join(',')).toContain('https://plex.tv/api/v2/pins?strong=true')

    popup.closed = true
    await advance(2_500)

    expect(screen.getByLabelText('signed-in user')).toHaveTextContent('brother')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps polling briefly after the popup closes while Plex propagates the token', async () => {
    plexCheck
      .mockResolvedValueOnce(json({ status: 'pending' }))
      .mockResolvedValueOnce(json(authorized))
    renderAuth()
    await startPlexSignIn()

    popup.closed = true
    await advance(2_500)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await advance(2_500)
    expect(screen.getByLabelText('signed-in user')).toHaveTextContent('brother')
  })

  it('does not overlap checks while the current request is unresolved', async () => {
    const pendingCheck = deferred<Response>()
    plexCheck.mockReturnValueOnce(pendingCheck.promise)
    renderAuth()
    await startPlexSignIn()

    await advance(2_500)
    expect(plexCheck).toHaveBeenCalledTimes(1)

    await advance(5_000)
    expect(plexCheck).toHaveBeenCalledTimes(1)

    pendingCheck.resolve(json({ status: 'pending' }))
    await act(async () => {
      await Promise.resolve()
    })
    await advance(2_500)
    expect(plexCheck).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['numeric', '4', 4_000],
    ['HTTP-date', new Date('2026-07-18T12:00:07Z').toUTCString(), 4_500],
  ])('honors a %s Retry-After after a 429 without rendering an alert', async (
    _kind,
    retryAfter,
    retryDelay,
  ) => {
    plexCheck.mockResolvedValueOnce(
      json({ error: 'rate_limited' }, 429, { 'Retry-After': retryAfter }),
    )
    renderAuth()
    await startPlexSignIn()

    await advance(2_500)
    expect(plexCheck).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await advance(retryDelay - 1)
    expect(plexCheck).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(plexCheck).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('stops after four consecutive network or service failures with a retryable message', async () => {
    plexCheck
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce(json({ error: 'unavailable' }, 503))
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce(json({ error: 'bad gateway' }, 502))
    renderAuth()
    await startPlexSignIn()

    await advance(2_500)
    await advance(2_500)
    await advance(5_000)
    await advance(10_000)

    expect(plexCheck).toHaveBeenCalledTimes(4)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Plex sign-in is temporarily unavailable. Try again.',
    )
    await advance(30_000)
    expect(plexCheck).toHaveBeenCalledTimes(4)
  })

  it('aborts an in-flight check on unmount and ignores its late authorization', async () => {
    const pendingCheck = deferred<Response>()
    plexCheck.mockReturnValueOnce(pendingCheck.promise)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const clearSpy = vi.spyOn(queryClient, 'clear')
    const view = renderAuth(queryClient)
    await startPlexSignIn()
    clearSpy.mockClear()

    await advance(2_500)
    const signal = plexCheck.mock.calls[0]?.[0]?.signal as AbortSignal | undefined
    view.unmount()
    const closeCallsAfterUnmount = popup.close.mock.calls.length
    const aborted = signal?.aborted ?? false

    pendingCheck.resolve(json(authorized))
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
    })

    expect({ aborted, queryCacheClears: clearSpy.mock.calls.length }).toEqual({
      aborted: true,
      queryCacheClears: 0,
    })
    expect(popup.close).toHaveBeenCalledTimes(closeCallsAfterUnmount)
  })

  it('aborts an unresolved check at the five-minute sign-in deadline', async () => {
    const pendingCheck = deferred<Response>()
    plexCheck.mockReturnValueOnce(pendingCheck.promise)
    renderAuth()
    await startPlexSignIn()

    await advance(2_500)
    const signal = plexCheck.mock.calls[0]?.[0]?.signal as AbortSignal | undefined
    await advance(5 * 60 * 1000 - 2_500)

    expect(signal?.aborted).toBe(true)
    expect(plexCheck).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert')).toHaveTextContent('Plex sign-in expired. Try again.')
  })

  it('aborts an unresolved check after the popup-close grace period', async () => {
    const pendingCheck = deferred<Response>()
    plexCheck.mockReturnValueOnce(pendingCheck.promise)
    renderAuth()
    await startPlexSignIn()

    await advance(2_500)
    const signal = plexCheck.mock.calls[0]?.[0]?.signal as AbortSignal | undefined
    popup.closed = true
    await advance(12_500)

    expect(signal?.aborted).toBe(true)
    expect(plexCheck).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Plex sign-in window was closed before authorization finished.',
    )
  })

  it.each([
    {
      boundary: 'the overall deadline',
      reachBoundary: async () => {
        vi.setSystemTime(new Date('2026-07-18T12:05:00Z'))
      },
      message: 'Plex sign-in expired. Try again.',
    },
    {
      boundary: 'the popup-close grace period',
      reachBoundary: async () => {
        popup.closed = true
        await advance(2_500)
        vi.setSystemTime(new Date('2026-07-18T12:00:15Z'))
      },
      message: 'Plex sign-in window was closed before authorization finished.',
    },
  ])('ignores authorization settled after $boundary when its watchdog is overdue', async ({
    reachBoundary,
    message,
  }) => {
    const pendingCheck = deferred<Response>()
    plexCheck.mockReturnValueOnce(pendingCheck.promise)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const clearSpy = vi.spyOn(queryClient, 'clear')
    renderAuth(queryClient)
    await startPlexSignIn()
    clearSpy.mockClear()

    await advance(2_500)
    await reachBoundary()
    pendingCheck.resolve(json(authorized))
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
    })

    expect(clearSpy).not.toHaveBeenCalled()
    expect(screen.getByLabelText('signed-in user')).toBeEmptyDOMElement()
    expect(screen.getByRole('alert')).toHaveTextContent(message)
  })

  it('ignores authorization whose body settles after the deadline watchdog is overdue', async () => {
    const pendingBody = deferred<unknown>()
    plexCheck.mockResolvedValueOnce({
      ...json(authorized),
      json: () => pendingBody.promise,
    } as Response)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const clearSpy = vi.spyOn(queryClient, 'clear')
    renderAuth(queryClient)
    await startPlexSignIn()
    clearSpy.mockClear()

    await advance(2_500)
    vi.setSystemTime(new Date('2026-07-18T12:05:00Z'))
    pendingBody.resolve(authorized)
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
    })

    expect(clearSpy).not.toHaveBeenCalled()
    expect(screen.getByLabelText('signed-in user')).toBeEmptyDOMElement()
    expect(screen.getByRole('alert')).toHaveTextContent('Plex sign-in expired. Try again.')
  })

  it('rejects an incomplete invite before opening Plex', async () => {
    renderAuth()

    fireEvent.click(screen.getByRole('button', { name: 'Start with incomplete invite' }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(window.open).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Invite codes are 22 characters. Paste the complete code.',
    )
  })
})
