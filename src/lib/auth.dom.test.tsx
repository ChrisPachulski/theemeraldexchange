// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuth } from './auth'
import { SESSION_EXPIRED_EVENT } from './queryClient'
import { useSuggested } from './hooks/useSuggested'


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

type SessionAwareAuth = ReturnType<typeof useAuth> & {
  sessionState?: 'loading' | 'authenticated' | 'anonymous' | 'unavailable'
  sessionError?: string | null
  retrySession?: () => Promise<void>
}

function SessionProbe() {
  const auth = useAuth() as SessionAwareAuth
  return (
    <>
      <output aria-label="session state">{auth.sessionState}</output>
      <output aria-label="session user">{auth.user?.username ?? ''}</output>
      {auth.sessionError && <p role="alert">{auth.sessionError}</p>}
      <button
        type="button"
        disabled={!auth.retrySession}
        onClick={() => void auth.retrySession?.()}
      >
        Retry session
      </button>
    </>
  )
}

function SuggestionsExpiryProbe() {
  const auth = useAuth() as SessionAwareAuth
  return (
    <>
      <SessionProbe />
      {auth.sessionState === 'authenticated' && <SuggestionsQueryProbe />}
    </>
  )
}

function SuggestionsQueryProbe() {
  const suggestions = useSuggested('movie', false, null)
  return <output aria-label="suggestions state">{suggestions.status}</output>
}

function ProviderProbe() {
  const auth = useAuth()
  const { appleSignIn, user, signInError } = auth
  const [result, setResult] = useState('')
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void appleSignIn({ identityToken: 'apple-token' }).then((ok) =>
            setResult(String(ok)),
          )
        }
      >
        Apple provider
      </button>
      <output aria-label="provider result">{result}</output>
      <output aria-label="provider user">{user?.username ?? ''}</output>
      <output aria-label="active sign-in">{auth.activeSignIn ?? ''}</output>
      {signInError && <p role="alert">{signInError}</p>}
    </>
  )
}

function LogoutProbe() {
  const auth = useAuth()
  const [result, setResult] = useState('')
  return (
    <>
      <output aria-label="logout session">{auth.sessionState}</output>
      <output aria-label="logout user">{auth.user?.username ?? ''}</output>
      <output aria-label="logout result">{result}</output>
      {auth.signOutError && <p role="alert">{auth.signOutError}</p>}
      <button
        type="button"
        onClick={() =>
          void auth.signOut().then(
            () => setResult('resolved'),
            () => setResult('rejected'),
          )
        }
      >
        Sign out safely
      </button>
    </>
  )
}

function AppleCancelProbe() {
  const auth = useAuth()
  const [attemptId, setAttemptId] = useState<number | null>(null)
  return (
    <>
      <output aria-label="cancel active sign-in">{auth.activeSignIn ?? ''}</output>
      <button
        type="button"
        onClick={() => {
          const next = auth.beginAppleSignIn()
          setAttemptId(next)
          if (next !== null) {
            void auth.appleSignIn({
              identityToken: 'apple-token',
              attemptId: next,
            })
          }
        }}
      >
        Start cancellable Apple
      </button>
      <button
        type="button"
        disabled={attemptId === null}
        onClick={() => {
          if (attemptId !== null) auth.cancelAppleSignIn(attemptId)
        }}
      >
        Cancel Apple
      </button>
    </>
  )
}

function renderWithAuth(
  children: React.ReactNode,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>,
    ),
  }
}

function auxiliaryAuthResponse(url: string): Response | null {
  if (url.endsWith('/api/auth/methods')) {
    return json({ apple: true, google: false, workos: false })
  }
  return null
}

describe('browser session truth', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  async function settleBoundedRead() {
    await act(async () => {
      await vi.runAllTimersAsync()
      for (let i = 0; i < 10; i += 1) await Promise.resolve()
    })
  }

  it('treats only an explicit /api/me 401 as anonymous', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const auxiliary = auxiliaryAuthResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) {
        return Promise.resolve(json({ error: 'unauthenticated' }, 401))
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithAuth(<SessionProbe />)
    await settleBoundedRead()

    expect(screen.getByLabelText('session state')).toHaveTextContent('anonymous')
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/me'))).toHaveLength(1)
  })

  it.each([
    {
      failure: '500',
      response: () => Promise.resolve(json({ error: 'unavailable' }, 500)),
    },
    {
      failure: 'network error',
      response: () => Promise.reject(new TypeError('network unavailable')),
    },
    {
      failure: 'HTML returned as a 200',
      response: () =>
        Promise.resolve({
          ...json({}, 200, { 'Content-Type': 'text/html' }),
          json: async () => {
            throw new SyntaxError('Unexpected token <')
          },
        } as Response),
    },
    {
      failure: 'structurally invalid JSON',
      response: () =>
        Promise.resolve(
          json({ user: { sub: 'apple:42', username: '', role: 'owner' } }),
        ),
    },
  ])('keeps the session unavailable after a bounded $failure retry', async ({ response }) => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const auxiliary = auxiliaryAuthResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) return response()
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithAuth(<SessionProbe />)
    await settleBoundedRead()

    expect(screen.getByLabelText('session state')).toHaveTextContent('unavailable')
    expect(screen.getByRole('alert')).toHaveTextContent(/session/i)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/me'))).toHaveLength(3)
  })

  it('times out and aborts each of three bounded /api/me attempts', async () => {
    const signals: AbortSignal[] = []
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const auxiliary = auxiliaryAuthResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (!url.endsWith('/api/me')) {
        return Promise.reject(new Error(`unexpected fetch: ${url}`))
      }
      const signal = init?.signal as AbortSignal
      signals.push(signal)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        )
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithAuth(<SessionProbe />)
    await settleBoundedRead()

    expect(signals).toHaveLength(3)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(screen.getByLabelText('session state')).toHaveTextContent('unavailable')
  })

  it.each([
    {
      recovery: 'anonymous',
      response: json({ error: 'unauthenticated' }, 401),
      expectedUser: '',
    },
    {
      recovery: 'authenticated',
      response: json({
        user: {
          sub: 'google:member-42',
          username: 'sibling',
          role: 'user',
          auth_mode: 'google',
        },
      }),
      expectedUser: 'sibling',
    },
  ])('starts a fresh bounded Retry that can recover to $recovery', async ({
    recovery,
    response,
    expectedUser,
  }) => {
    let meCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const auxiliary = auxiliaryAuthResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (!url.endsWith('/api/me')) {
        return Promise.reject(new Error(`unexpected fetch: ${url}`))
      }
      meCalls += 1
      return Promise.resolve(meCalls <= 3 ? json({ error: 'unavailable' }, 503) : response)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithAuth(<SessionProbe />)
    await settleBoundedRead()
    expect(screen.getByLabelText('session state')).toHaveTextContent('unavailable')

    fireEvent.click(screen.getByRole('button', { name: 'Retry session' }))
    await settleBoundedRead()

    expect(screen.getByLabelText('session state')).toHaveTextContent(recovery)
    expect(screen.getByLabelText('session user')).toHaveTextContent(expectedUser)
    expect(meCalls).toBe(4)
  })

  it.each([
    {
      nextSession: 'unavailable',
      response: json({ error: 'unavailable' }, 503),
      expectedCalls: 4,
    },
    {
      nextSession: 'anonymous',
      response: json({ error: 'unauthenticated' }, 401),
      expectedCalls: 2,
    },
  ])('revalidates a session-expiry event to $nextSession through /api/me', async ({
    nextSession,
    response,
    expectedCalls,
  }) => {
    let meCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const auxiliary = auxiliaryAuthResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (!url.endsWith('/api/me')) {
        return Promise.reject(new Error(`unexpected fetch: ${url}`))
      }
      meCalls += 1
      return Promise.resolve(
        meCalls === 1
          ? json({
              user: {
                sub: 'apple:42',
                username: 'member',
                role: 'user',
                auth_mode: 'apple',
              },
            })
          : response,
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithAuth(<SessionProbe />)
    await settleBoundedRead()
    expect(screen.getByLabelText('session state')).toHaveTextContent('authenticated')

    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    await settleBoundedRead()

    expect(screen.getByLabelText('session state')).toHaveTextContent(nextSession)
    expect(meCalls).toBe(expectedCalls)
  })

  it('clears protected query data after expiry revalidation confirms anonymous', async () => {
    let meCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const auxiliary = auxiliaryAuthResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (!url.endsWith('/api/me')) {
        return Promise.reject(new Error(`unexpected fetch: ${url}`))
      }
      meCalls += 1
      return Promise.resolve(
        meCalls === 1
          ? json({
              user: {
                sub: 'apple:42',
                username: 'member',
                role: 'user',
                auth_mode: 'apple',
              },
            })
          : json({ error: 'unauthenticated' }, 401),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const { queryClient } = renderWithAuth(<SessionProbe />)
    await settleBoundedRead()
    queryClient.setQueryData(['protected', 'watch-history'], { items: [1] })
    expect(queryClient.getQueryData(['protected', 'watch-history'])).toEqual({ items: [1] })

    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    await settleBoundedRead()

    expect(screen.getByLabelText('session state')).toHaveTextContent('anonymous')
    expect(queryClient.getQueryData(['protected', 'watch-history'])).toBeUndefined()
  })

  it('revalidates a suggestions unauthenticated 401 and clears protected cache only after /api/me confirms anonymous', async () => {
    const suggestions = deferred<Response>()
    const expiryListener = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, expiryListener)
    let meCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const auxiliary = auxiliaryAuthResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) {
        meCalls += 1
        return Promise.resolve(
          meCalls === 1
            ? json({
                user: {
                  sub: 'apple:42',
                  username: 'member',
                  role: 'user',
                  auth_mode: 'apple',
                },
              })
            : json({ error: 'unauthenticated' }, 401),
        )
      }
      if (url.includes('/api/suggestions/movie')) return suggestions.promise
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    renderWithAuth(<SuggestionsExpiryProbe />, queryClient)
    await settleBoundedRead()

    expect(screen.getByLabelText('session state')).toHaveTextContent('authenticated')
    expect(screen.getByLabelText('suggestions state')).toHaveTextContent('pending')
    queryClient.setQueryData(['protected', 'watch-history'], { items: [1] })

    suggestions.resolve(json({ error: 'unauthenticated' }, 401))
    await settleBoundedRead()

    expect(expiryListener).toHaveBeenCalledTimes(1)
    expect(meCalls).toBe(2)
    expect(screen.getByLabelText('session state')).toHaveTextContent('anonymous')
    expect(queryClient.getQueryData(['protected', 'watch-history'])).toBeUndefined()
    window.removeEventListener(SESSION_EXPIRED_EVENT, expiryListener)
  })

  it('aborts an initial read on unmount and ignores its late result', async () => {
    const pendingMe = deferred<Response>()
    let sessionSignal: AbortSignal | undefined
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const auxiliary = auxiliaryAuthResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) {
        sessionSignal = init?.signal as AbortSignal
        return pendingMe.promise
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const clearSpy = vi.spyOn(queryClient, 'clear')

    const view = renderWithAuth(<SessionProbe />, queryClient)
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
    })
    view.unmount()
    clearSpy.mockClear()

    pendingMe.resolve(
      json({
        user: { sub: 'apple:42', username: 'late', role: 'user', auth_mode: 'apple' },
      }),
    )
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
    })

    expect(sessionSignal?.aborted).toBe(true)
    expect(clearSpy).not.toHaveBeenCalled()
  })
})

describe('provider session confirmation', () => {
  type ProviderCase = {
    name: string
    button: string
    responseSub: string
    booleanResult: boolean
    activeSignIn: 'apple'
  }

  const providers: ProviderCase[] = [
    {
      name: 'Apple',
      button: 'Apple provider',
      responseSub: 'apple:000000.deadbeef.0000',
      booleanResult: true,
      activeSignIn: 'apple',
    },
  ]

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  async function flush() {
    await act(async () => {
      for (let i = 0; i < 12; i += 1) await Promise.resolve()
    })
  }

  function providerFetch(
    provider: ProviderCase,
    confirmation: () => Promise<Response>,
  ) {
    let meCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const auxiliary = auxiliaryAuthResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) {
        meCalls += 1
        return meCalls === 1
          ? Promise.resolve(json({ error: 'unauthenticated' }, 401))
          : confirmation()
      }
      if (url.endsWith('/api/auth/apple')) {
        return Promise.resolve(
          json({
            status: 'authorized',
            user: {
              sub: provider.responseSub,
              username: 'provider-response',
              role: 'user',
            },
          }),
        )
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    return { fetchMock, meCalls: () => meCalls }
  }

  async function startProvider(provider: ProviderCase) {
    renderWithAuth(<ProviderProbe />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: provider.button }))
    await flush()
  }

  it.each(providers)(
    'does not apply $name response identity before matching /api/me confirmation',
    async (provider) => {
      const pendingConfirmation = deferred<Response>()
      const { meCalls } = providerFetch(provider, () => pendingConfirmation.promise)

      await startProvider(provider)

      expect(meCalls()).toBe(2)
      expect(screen.getByLabelText('provider user')).toBeEmptyDOMElement()
      expect(screen.getByLabelText('active sign-in')).toHaveTextContent(
        provider.activeSignIn,
      )

      pendingConfirmation.resolve(
        json({
          user: {
            sub: provider.responseSub,
            username: 'confirmed-session',
            role: 'user',
            auth_mode: provider.responseSub.startsWith('local:')
              ? 'local'
              : provider.name.toLowerCase(),
          },
        }),
      )
      await flush()

      expect(screen.getByLabelText('provider user')).toHaveTextContent('confirmed-session')
      expect(screen.getByLabelText('active sign-in')).toBeEmptyDOMElement()
      if (provider.booleanResult) {
        expect(screen.getByLabelText('provider result')).toHaveTextContent('true')
      }
    },
  )

  it('does not start a second provider while Apple confirmation owns the slot', async () => {
    const apple = providers[0]
    const pendingConfirmation = deferred<Response>()
    const { fetchMock } = providerFetch(apple, () => pendingConfirmation.promise)

    await startProvider(apple)
    fireEvent.click(screen.getByRole('button', { name: 'Apple provider' }))
    await flush()

    expect(screen.getByLabelText('active sign-in')).toHaveTextContent('apple')
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/auth/apple')),
    ).toHaveLength(1)

    pendingConfirmation.resolve(
      json({
        user: {
          sub: apple.responseSub,
          username: 'confirmed-session',
          role: 'user',
          auth_mode: 'apple',
        },
      }),
    )
    await flush()
  })

  it.each([
    {
      outcome: '401',
      confirmation: () => Promise.resolve(json({ error: 'unauthenticated' }, 401)),
      message: /session.*establish/i,
    },
    {
      outcome: 'subject mismatch',
      confirmation: () =>
        Promise.resolve(
          json({
            user: {
              sub: 'apple:000000.different.0000',
              username: 'wrong-session',
              role: 'user',
              auth_mode: 'apple',
            },
          }),
        ),
      message: /session.*match/i,
    },
  ])('fails an Apple provider success closed on confirmation $outcome', async ({
    confirmation,
    message,
  }) => {
    const provider = providers[0]
    providerFetch(provider, confirmation)

    await startProvider(provider)
    await flush()

    expect(screen.getByLabelText('provider result')).toHaveTextContent('false')
    expect(screen.getByLabelText('provider user')).toBeEmptyDOMElement()
    expect(screen.getByLabelText('active sign-in')).toBeEmptyDOMElement()
    expect(screen.getByRole('alert')).toHaveTextContent(message)
  })

  it('reports a retryable error after three unavailable confirmation reads', async () => {
    const provider = providers[0]
    const { meCalls } = providerFetch(provider, () =>
      Promise.resolve(json({ error: 'unavailable' }, 503)),
    )

    await startProvider(provider)
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    await flush()

    expect(meCalls()).toBe(4)
    expect(screen.getByLabelText('provider result')).toHaveTextContent('false')
    expect(screen.getByLabelText('provider user')).toBeEmptyDOMElement()
    expect(screen.getByLabelText('active sign-in')).toBeEmptyDOMElement()
    expect(screen.getByRole('alert')).toHaveTextContent(/session.*try again/i)
  })

  it('does not start an orphan confirmation read when a provider settles after unmount', async () => {
    const pendingProvider = deferred<Response>()
    let meCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const auxiliary = auxiliaryAuthResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) {
        meCalls += 1
        return Promise.resolve(json({ error: 'unauthenticated' }, 401))
      }
      if (url.endsWith('/api/auth/apple')) return pendingProvider.promise
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    const view = renderWithAuth(<ProviderProbe />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Apple provider' }))
    await flush()
    view.unmount()

    pendingProvider.resolve(
      json({
        status: 'authorized',
        user: { sub: 'apple:000000.deadbeef.0000' },
      }),
    )
    await flush()

    expect(meCalls).toBe(1)
  })
})

describe('bounded provider and logout requests', () => {
  const NETWORK_TIMEOUT_MS = 15_000

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-18T12:00:00Z'))
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  async function flush() {
    await act(async () => {
      for (let i = 0; i < 12; i += 1) await Promise.resolve()
    })
  }

  function providerResponse(url: string): Response {
    if (url.endsWith('/api/auth/apple')) {
      return json({ status: 'authorized', user: { sub: 'apple:1', username: 'Apple', role: 'user' } })
    }
    throw new Error(`missing provider response for ${url}`)
  }

  it.each([
    { leg: 'Apple verification', button: 'Apple provider', path: '/api/auth/apple', active: 'apple' },
  ])('times out a black-holed $leg, releases the provider lock, and clears its timer', async ({
    button,
    path,
    active,
  }) => {
    const blocked = deferred<Response>()
    let blockOnce = true
    let blockedSignal: AbortSignal | undefined
    let blockedCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const auxiliary = auxiliaryAuthResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) return Promise.resolve(json({ error: 'unauthenticated' }, 401))
      if (url.includes(path)) {
        blockedCalls += 1
        if (blockOnce) {
          blockOnce = false
          blockedSignal = init?.signal as AbortSignal | undefined
          return blocked.promise
        }
      }
      return Promise.resolve(providerResponse(url))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithAuth(<ProviderProbe />)
    await flush()
    const baselineTimers = vi.getTimerCount()
    fireEvent.click(screen.getByRole('button', { name: button }))
    await flush()

    expect(screen.getByLabelText('active sign-in')).toHaveTextContent(active)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NETWORK_TIMEOUT_MS)
    })
    await flush()

    expect(blockedSignal?.aborted).toBe(true)
    expect(screen.getByLabelText('active sign-in')).toBeEmptyDOMElement()
    expect(screen.getByRole('alert')).toHaveTextContent(/timed out/i)
    expect(vi.getTimerCount()).toBe(baselineTimers)

    fireEvent.click(screen.getByRole('button', { name: button }))
    await flush()
    expect(blockedCalls).toBe(2)
  })

  it('aborts an in-flight provider request and removes its timer on unmount', async () => {
    let signal: AbortSignal | undefined
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const auxiliary = auxiliaryAuthResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) return Promise.resolve(json({ error: 'unauthenticated' }, 401))
      if (url.endsWith('/api/auth/apple')) {
        signal = init?.signal as AbortSignal | undefined
        return new Promise<Response>(() => {})
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    const view = renderWithAuth(<ProviderProbe />)
    await flush()
    const baselineTimers = vi.getTimerCount()
    fireEvent.click(screen.getByRole('button', { name: 'Apple provider' }))
    await flush()
    expect(vi.getTimerCount()).toBe(baselineTimers + 1)

    view.unmount()
    await flush()

    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(baselineTimers)
  })

  it('aborts an in-flight Apple verification when the attempt is cancelled', async () => {
    let signal: AbortSignal | undefined
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const auxiliary = auxiliaryAuthResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) return Promise.resolve(json({ error: 'unauthenticated' }, 401))
      if (url.endsWith('/api/auth/apple')) {
        signal = init?.signal as AbortSignal | undefined
        return new Promise<Response>(() => {})
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithAuth(<AppleCancelProbe />)
    await flush()
    const baselineTimers = vi.getTimerCount()
    fireEvent.click(screen.getByRole('button', { name: 'Start cancellable Apple' }))
    await flush()
    expect(screen.getByLabelText('cancel active sign-in')).toHaveTextContent('apple')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Apple' }))
    await flush()

    expect(signal?.aborted).toBe(true)
    expect(screen.getByLabelText('cancel active sign-in')).toBeEmptyDOMElement()
    expect(vi.getTimerCount()).toBe(baselineTimers)
  })

  it.each([
    { failure: 'timeout', response: () => new Promise<Response>(() => {}), advance: NETWORK_TIMEOUT_MS },
    { failure: 'HTTP failure', response: () => Promise.resolve(json({ error: 'down' }, 503)), advance: 0 },
  ])('clears local auth and releases the logout guard after $failure', async ({ response, advance }) => {
    let logoutCalls = 0
    let logoutSignal: AbortSignal | undefined
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const auxiliary = auxiliaryAuthResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) {
        return Promise.resolve(json({ user: { sub: 'apple:1', username: 'Member', role: 'user' } }))
      }
      if (url.endsWith('/api/auth/logout')) {
        logoutCalls += 1
        logoutSignal = init?.signal as AbortSignal | undefined
        return logoutCalls === 1 ? response() : Promise.resolve(json({ ok: true }))
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithAuth(<LogoutProbe />)
    await flush()
    expect(screen.getByLabelText('logout user')).toHaveTextContent('Member')
    fireEvent.click(screen.getByRole('button', { name: 'Sign out safely' }))
    await flush()
    if (advance) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(advance)
      })
      await flush()
      expect(logoutSignal?.aborted).toBe(true)
    }

    expect(screen.getByLabelText('logout result')).toHaveTextContent('rejected')
    expect(screen.getByLabelText('logout session')).toHaveTextContent('anonymous')
    expect(screen.getByLabelText('logout user')).toBeEmptyDOMElement()

    fireEvent.click(screen.getByRole('button', { name: 'Sign out safely' }))
    await flush()
    expect(logoutCalls).toBe(2)
  })
})
