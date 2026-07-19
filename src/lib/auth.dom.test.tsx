// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AuthProvider, useAuth } from './auth'
import { SESSION_EXPIRED_EVENT } from './queryClient'

const webauthnMocks = vi.hoisted(() => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}))

vi.mock('@simplewebauthn/browser', () => webauthnMocks)

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
  const { signIn, activeSignIn, user, signInError } = useAuth()
  return (
    <>
      <button type="button" onClick={() => void signIn()}>
        Start Plex sign-in
      </button>
      <button type="button" onClick={() => void signIn('A'.repeat(20))}>
        Start with incomplete invite
      </button>
      <output aria-label="signed-in user">{user?.username ?? ''}</output>
      <output aria-label="active sign-in">{activeSignIn ?? ''}</output>
      {signInError && <p role="alert">{signInError}</p>}
    </>
  )
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

function ProviderProbe() {
  const auth = useAuth() as ReturnType<typeof useAuth> & {
    activeSignIn?: 'plex' | 'apple' | 'passkey-login' | 'passkey-register' | null
  }
  const { signIn, appleSignIn, passkeyLogin, passkeyRegister, user, signInError } = auth
  const [result, setResult] = useState('')
  return (
    <>
      <button type="button" onClick={() => void signIn()}>
        Plex provider
      </button>
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
      <button
        type="button"
        onClick={() => void passkeyLogin().then((ok) => setResult(String(ok)))}
      >
        Passkey login provider
      </button>
      <button
        type="button"
        onClick={() =>
          void passkeyRegister({ handle: 'Sibling' }).then((ok) =>
            setResult(String(ok)),
          )
        }
      >
        Passkey registration provider
      </button>
      <output aria-label="provider result">{result}</output>
      <output aria-label="provider user">{user?.username ?? ''}</output>
      <output aria-label="active sign-in">{auth.activeSignIn ?? ''}</output>
      {signInError && <p role="alert">{signInError}</p>}
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
    return json({ plex: true, apple: true, google: false, passkey: true })
  }
  if (url.endsWith('/api/setup/status')) return json({ claimable: false })
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
          json({ user: { sub: 'plex:42', username: '', role: 'owner' } }),
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
                sub: 'plex:42',
                username: 'member',
                role: 'user',
                auth_mode: 'plex',
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
                sub: 'plex:42',
                username: 'member',
                role: 'user',
                auth_mode: 'plex',
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
        user: { sub: 'plex:42', username: 'late', role: 'user', auth_mode: 'plex' },
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
    activeSignIn: 'plex' | 'apple' | 'passkey-login' | 'passkey-register'
  }

  const providers: ProviderCase[] = [
    {
      name: 'Plex',
      button: 'Plex provider',
      responseSub: 'plex:42',
      booleanResult: false,
      activeSignIn: 'plex',
    },
    {
      name: 'Apple',
      button: 'Apple provider',
      responseSub: 'apple:000000.deadbeef.0000',
      booleanResult: true,
      activeSignIn: 'apple',
    },
    {
      name: 'passkey login',
      button: 'Passkey login provider',
      responseSub: 'local:LOGIN',
      booleanResult: true,
      activeSignIn: 'passkey-login',
    },
    {
      name: 'passkey registration',
      button: 'Passkey registration provider',
      responseSub: 'local:REGISTER',
      booleanResult: true,
      activeSignIn: 'passkey-register',
    },
  ]

  let popup: { closed: boolean; close: ReturnType<typeof vi.fn>; location: { href: string } }

  beforeEach(() => {
    vi.useFakeTimers()
    popup = { closed: false, close: vi.fn(), location: { href: '' } }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    webauthnMocks.startAuthentication.mockResolvedValue({ id: 'credential-login' })
    webauthnMocks.startRegistration.mockResolvedValue({ id: 'credential-register' })
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
      if (url.endsWith('/api/auth/plex/config')) {
        return Promise.resolve(json({ clientId: 'client-id', product: 'The Emerald Exchange' }))
      }
      if (url.startsWith('https://plex.tv/api/v2/pins?')) {
        return Promise.resolve(json({ id: 123, code: 'plex-code' }, 201))
      }
      if (url.endsWith('/api/auth/plex/check')) {
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
      if (url.endsWith('/api/auth/passkey/login/options')) {
        return Promise.resolve(json({ options: { challenge: 'login' }, challengeId: 'login' }))
      }
      if (url.endsWith('/api/auth/passkey/login/verify')) {
        return Promise.resolve(
          json({
            ok: true,
            user: {
              sub: provider.responseSub,
              username: 'provider-response',
              role: 'user',
            },
          }),
        )
      }
      if (url.endsWith('/api/auth/passkey/register/options')) {
        return Promise.resolve(
          json({ options: { challenge: 'register' }, challengeId: 'register' }),
        )
      }
      if (url.endsWith('/api/auth/passkey/register/verify')) {
        return Promise.resolve(
          json({
            ok: true,
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
    if (provider.name === 'Plex') {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500)
      })
    }
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
    const apple = providers[1]
    const pendingConfirmation = deferred<Response>()
    const { fetchMock } = providerFetch(apple, () => pendingConfirmation.promise)

    await startProvider(apple)
    fireEvent.click(screen.getByRole('button', { name: 'Passkey login provider' }))
    await flush()

    expect(screen.getByLabelText('active sign-in')).toHaveTextContent('apple')
    expect(webauthnMocks.startAuthentication).not.toHaveBeenCalled()
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith('/api/auth/passkey/login/options'),
      ),
    ).toHaveLength(0)

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
    { name: 'login', providerIndex: 2, cancel: webauthnMocks.startAuthentication },
    { name: 'registration', providerIndex: 3, cancel: webauthnMocks.startRegistration },
  ])('clears passkey $name activity after authenticator cancellation', async ({
    providerIndex,
    cancel,
  }) => {
    const provider = providers[providerIndex]
    providerFetch(provider, () =>
      Promise.resolve(json({ error: 'confirmation should not run' }, 500)),
    )
    cancel.mockRejectedValueOnce(new DOMException('cancelled', 'NotAllowedError'))

    await startProvider(provider)

    expect(screen.getByLabelText('provider result')).toHaveTextContent('false')
    expect(screen.getByLabelText('active sign-in')).toBeEmptyDOMElement()
    expect(screen.getByRole('alert')).toHaveTextContent(/cancelled/i)
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
    const provider = providers[1]
    providerFetch(provider, confirmation)

    await startProvider(provider)
    await flush()

    expect(screen.getByLabelText('provider result')).toHaveTextContent('false')
    expect(screen.getByLabelText('provider user')).toBeEmptyDOMElement()
    expect(screen.getByLabelText('active sign-in')).toBeEmptyDOMElement()
    expect(screen.getByRole('alert')).toHaveTextContent(message)
  })

  it('reports a retryable error after three unavailable confirmation reads', async () => {
    const provider = providers[2]
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

describe('Plex popup completion', () => {
  let popup: { closed: boolean; close: ReturnType<typeof vi.fn>; location: { href: string } }
  let fetchMock: ReturnType<typeof vi.fn>
  let plexCheck: Mock<(init?: RequestInit) => Promise<Response>>
  let meCalls: number

  const authorized = {
    status: 'authorized',
    user: { sub: 'plex:42', username: 'brother', role: 'user', auth_mode: 'plex' },
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-18T12:00:00Z'))
    meCalls = 0
    popup = { closed: false, close: vi.fn(), location: { href: '' } }
    plexCheck = vi.fn((_init?: RequestInit) =>
      Promise.resolve(json({ status: 'pending' })),
    )
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)

    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/me')) {
        meCalls += 1
        return Promise.resolve(
          meCalls === 1
            ? json({ error: 'unauthenticated' }, 401)
            : json({ user: authorized.user }),
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
    expect(screen.getByLabelText('active sign-in')).toBeEmptyDOMElement()
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
    expect(screen.getByLabelText('active sign-in')).toBeEmptyDOMElement()
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
