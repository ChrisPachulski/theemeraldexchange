// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuth, type AuthUser } from './auth'
import { SESSION_EXPIRED_EVENT } from './queryClient'

const webauthnMocks = vi.hoisted(() => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}))

vi.mock('@simplewebauthn/browser', () => webauthnMocks)

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    headers: new Headers({ 'Content-Type': 'application/json' }),
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

const OLD_USER: AuthUser = {
  sub: 'apple:old-member',
  username: 'Old member',
  role: 'user',
  auth_mode: 'apple',
}

const NEW_USER: AuthUser = {
  sub: 'apple:new-member',
  username: 'New member',
  role: 'user',
  auth_mode: 'apple',
}

function me(user: AuthUser): Response {
  return json({ user })
}

function auxiliaryResponse(url: string): Response | null {
  if (url.endsWith('/api/auth/methods')) {
    return json({ plex: true, apple: true, google: false, passkey: true })
  }
  if (url.endsWith('/api/setup/status')) return json({ claimable: false })
  return null
}

class FakeBroadcastChannel extends EventTarget {
  static instances: FakeBroadcastChannel[] = []

  readonly name: string
  readonly postMessage = vi.fn()
  readonly close = vi.fn()

  constructor(name: string) {
    super()
    this.name = name
    FakeBroadcastChannel.instances.push(this)
  }

  emitInvalidation(epoch = 1) {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'invalidate', epoch },
      }),
    )
  }
}

function LifecycleProbe() {
  const auth = useAuth()
  const [providerResult, setProviderResult] = useState('')
  return (
    <>
      <output aria-label="session state">{auth.sessionState}</output>
      <output aria-label="session user">{auth.user?.username ?? ''}</output>
      <output aria-label="session role">{auth.user?.role ?? ''}</output>
      <output aria-label="active sign-in">{auth.activeSignIn ?? ''}</output>
      <output aria-label="provider result">{providerResult}</output>
      <output aria-label="discovered servers">
        {auth.discoveredServers?.map((server) => server.name).join(', ') ?? ''}
      </output>
      <button type="button" onClick={() => void auth.retrySession()}>
        Retry session
      </button>
      <button
        type="button"
        onClick={() =>
          void auth.appleSignIn({ identityToken: 'apple-token' }).then((ok) =>
            setProviderResult(String(ok)),
          )
        }
      >
        Apple provider
      </button>
      <button
        type="button"
        onClick={() =>
          void auth.passkeyLogin().then((ok) => setProviderResult(String(ok)))
        }
      >
        Passkey provider
      </button>
      <button type="button" onClick={() => void auth.signIn()}>
        Plex provider
      </button>
      <button type="button" onClick={() => void auth.signOut()}>
        Sign out
      </button>
    </>
  )
}

function renderAuth(
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  strict = false,
) {
  const tree = (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <LifecycleProbe />
      </AuthProvider>
    </QueryClientProvider>
  )
  return {
    queryClient,
    ...render(strict ? <StrictMode>{tree}</StrictMode> : tree),
  }
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve()
  })
}

async function runScheduledRefresh() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
  await flush()
}

function meCallCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([input]) =>
    String(input).endsWith('/api/me'),
  ).length
}

function dispatchPageShow(persisted: boolean) {
  const event = new Event('pageshow') as PageTransitionEvent
  Object.defineProperty(event, 'persisted', { value: persisted })
  window.dispatchEvent(event)
}

describe('browser session lifecycle reconciliation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeBroadcastChannel.instances = []
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    webauthnMocks.startAuthentication.mockResolvedValue({ id: 'credential' })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('re-reads session truth for cross-tab login and logout without echoing the signal', async () => {
    let call = 0
    const responses = [me(OLD_USER), me(NEW_USER), json({ error: 'unauthenticated' }, 401)]
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const auxiliary = auxiliaryResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) return Promise.resolve(responses[call++]!)
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { queryClient } = renderAuth()
    await flush()

    queryClient.setQueryData(['private'], 'old cache')
    const channel = FakeBroadcastChannel.instances.at(-1)!
    channel.emitInvalidation(1)
    await runScheduledRefresh()

    expect(screen.getByLabelText('session user')).toHaveTextContent('New member')
    expect(queryClient.getQueryData(['private'])).toBeUndefined()

    queryClient.setQueryData(['private'], 'new cache')
    channel.emitInvalidation(2)
    await runScheduledRefresh()

    expect(screen.getByLabelText('session state')).toHaveTextContent('anonymous')
    expect(screen.getByLabelText('session user')).toBeEmptyDOMElement()
    expect(queryClient.getQueryData(['private'])).toBeUndefined()
    expect(channel.postMessage).not.toHaveBeenCalled()
    expect(meCallCount(fetchMock)).toBe(3)
  })

  it('broadcasts only a tokenless invalidation after provider login and local logout', async () => {
    let meCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const auxiliary = auxiliaryResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) {
        meCalls += 1
        return Promise.resolve(
          meCalls === 1 ? json({ error: 'unauthenticated' }, 401) : me(NEW_USER),
        )
      }
      if (url.endsWith('/api/auth/apple')) {
        return Promise.resolve(json({ status: 'authorized', user: NEW_USER }))
      }
      if (url.endsWith('/api/auth/logout')) return Promise.resolve(json({ ok: true }))
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderAuth()
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Apple provider' }))
    await flush()

    const channel = FakeBroadcastChannel.instances.at(-1)!
    expect(screen.getByLabelText('provider result')).toHaveTextContent('true')
    expect(channel.postMessage).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await flush()

    expect(screen.getByLabelText('session state')).toHaveTextContent('anonymous')
    expect(channel.postMessage).toHaveBeenCalledTimes(2)
    for (const [message] of channel.postMessage.mock.calls) {
      expect(Object.keys(message as object).sort()).toEqual(['epoch', 'type'])
      expect(message).toMatchObject({ type: 'invalidate', epoch: expect.any(Number) })
      expect(JSON.stringify(message)).not.toMatch(/apple|token|invite|member/i)
    }
  })

  it('keeps local sign-out truthful when broadcasting throws', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const auxiliary = auxiliaryResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) return Promise.resolve(me(OLD_USER))
      if (url.endsWith('/api/auth/logout')) return Promise.resolve(json({ ok: true }))
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderAuth()
    await flush()
    const channel = FakeBroadcastChannel.instances.at(-1)!
    channel.postMessage.mockImplementationOnce(() => {
      throw new Error('channel unavailable')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await flush()

    expect(screen.getByLabelText('session state')).toHaveTextContent('anonymous')
    expect(screen.getByLabelText('session user')).toBeEmptyDOMElement()
  })

  it('broadcasts a lifecycle-confirmed transition to anonymous', async () => {
    let meCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const auxiliary = auxiliaryResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) {
        meCalls += 1
        return Promise.resolve(
          meCalls === 1 ? me(OLD_USER) : json({ error: 'unauthenticated' }, 401),
        )
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderAuth()
    await flush()
    const channel = FakeBroadcastChannel.instances.at(-1)!

    window.dispatchEvent(new Event('focus'))
    await runScheduledRefresh()

    expect(screen.getByLabelText('session state')).toHaveTextContent('anonymous')
    expect(channel.postMessage).toHaveBeenCalledTimes(1)
  })

  it('clears provider discovery state on a lifecycle-confirmed anonymous session', async () => {
    const plexUser: AuthUser = {
      sub: 'plex:42',
      username: 'Plex member',
      role: 'user',
      auth_mode: 'plex',
    }
    let meCalls = 0
    const popup = { closed: false, close: vi.fn(), location: { href: '' } }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const auxiliary = auxiliaryResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) {
        meCalls += 1
        if (meCalls === 1) return Promise.resolve(json({ error: 'unauthenticated' }, 401))
        if (meCalls === 2) return Promise.resolve(me(plexUser))
        return Promise.resolve(json({ error: 'unauthenticated' }, 401))
      }
      if (url.endsWith('/api/auth/plex/config')) {
        return Promise.resolve(json({ clientId: 'client-id', product: 'Exchange' }))
      }
      if (url.startsWith('https://plex.tv/api/v2/pins?')) {
        return Promise.resolve(json({ id: 123, code: 'plex-code' }, 201))
      }
      if (url.endsWith('/api/auth/plex/check')) {
        return Promise.resolve(
          json({
            status: 'authorized',
            user: plexUser,
            discoveredServers: [
              { name: 'Family NAS', id: 'server-id', owned: true },
            ],
          }),
        )
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderAuth()
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Plex provider' }))
    await flush()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500)
    })
    await flush()
    expect(screen.getByLabelText('discovered servers')).toHaveTextContent('Family NAS')

    window.dispatchEvent(new Event('focus'))
    await runScheduledRefresh()

    expect(screen.getByLabelText('session state')).toHaveTextContent('anonymous')
    expect(screen.getByLabelText('discovered servers')).toBeEmptyDOMElement()
  })

  it('ignores normal-load pageshow but revalidates a BFCache restore', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const auxiliary = auxiliaryResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) return Promise.resolve(me(OLD_USER))
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderAuth()
    await flush()

    dispatchPageShow(false)
    await runScheduledRefresh()
    expect(meCallCount(fetchMock)).toBe(1)

    dispatchPageShow(true)
    await runScheduledRefresh()
    expect(meCallCount(fetchMock)).toBe(2)
  })

  it('deduplicates a focus, visibility, and pageshow burst without polling', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const auxiliary = auxiliaryResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) return Promise.resolve(me(OLD_USER))
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderAuth()
    await flush()

    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    dispatchPageShow(true)
    await runScheduledRefresh()

    expect(meCallCount(fetchMock)).toBe(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(meCallCount(fetchMock)).toBe(2)
  })

  it('preserves query data and foreground UI when a lifecycle read confirms the same user', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const auxiliary = auxiliaryResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) return Promise.resolve(me(OLD_USER))
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { queryClient } = renderAuth()
    await flush()
    queryClient.setQueryData(['private'], 'keep me')
    const clearSpy = vi.spyOn(queryClient, 'clear')

    window.dispatchEvent(new Event('focus'))
    expect(screen.getByLabelText('session state')).toHaveTextContent('authenticated')
    await runScheduledRefresh()

    expect(screen.getByLabelText('session state')).toHaveTextContent('authenticated')
    expect(screen.getByLabelText('session user')).toHaveTextContent('Old member')
    expect(queryClient.getQueryData(['private'])).toBe('keep me')
    expect(clearSpy).not.toHaveBeenCalled()
    expect(meCallCount(fetchMock)).toBe(2)
  })

  it.each([
    {
      change: 'identity',
      next: NEW_USER,
      expectedUser: 'New member',
      expectedRole: 'user',
    },
    {
      change: 'role',
      next: { ...OLD_USER, role: 'admin' as const },
      expectedUser: 'Old member',
      expectedRole: 'admin',
    },
  ])('clears per-user query data when lifecycle reconciliation changes $change', async ({
    next,
    expectedUser,
    expectedRole,
  }) => {
    let meCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const auxiliary = auxiliaryResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) {
        meCalls += 1
        return Promise.resolve(me(meCalls === 1 ? OLD_USER : next))
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { queryClient } = renderAuth()
    await flush()
    queryClient.setQueryData(['private'], 'discard me')

    window.dispatchEvent(new Event('focus'))
    await runScheduledRefresh()

    expect(screen.getByLabelText('session user')).toHaveTextContent(expectedUser)
    expect(screen.getByLabelText('session role')).toHaveTextContent(expectedRole)
    expect(queryClient.getQueryData(['private'])).toBeUndefined()
  })

  it('keeps the authenticated user and cache on a transient lifecycle failure', async () => {
    let meCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const auxiliary = auxiliaryResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) {
        meCalls += 1
        return Promise.resolve(
          meCalls === 1 ? me(OLD_USER) : json({ error: 'unavailable' }, 503),
        )
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { queryClient } = renderAuth()
    await flush()
    queryClient.setQueryData(['private'], 'keep me')

    window.dispatchEvent(new Event('focus'))
    await runScheduledRefresh()

    expect(meCalls).toBe(4)
    expect(screen.getByLabelText('session state')).toHaveTextContent('authenticated')
    expect(screen.getByLabelText('session user')).toHaveTextContent('Old member')
    expect(queryClient.getQueryData(['private'])).toBe('keep me')
  })

  it('defers lifecycle refresh while a foreground session retry owns /api/me', async () => {
    const heldRetry = deferred<Response>()
    let meCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const auxiliary = auxiliaryResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (!url.endsWith('/api/me')) {
        return Promise.reject(new Error(`unexpected fetch: ${url}`))
      }
      meCalls += 1
      if (meCalls === 1) return Promise.resolve(me(OLD_USER))
      if (meCalls === 2) return heldRetry.promise
      return Promise.resolve(json({ error: 'unavailable' }, 503))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderAuth()
    await flush()

    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    await flush()
    expect(screen.getByLabelText('session state')).toHaveTextContent('loading')
    expect(meCalls).toBe(2)

    window.dispatchEvent(new Event('focus'))
    await runScheduledRefresh()

    expect(meCalls).toBe(2)
    expect(screen.getByLabelText('session state')).toHaveTextContent('loading')

    heldRetry.resolve(me(OLD_USER))
    await flush()
    await runScheduledRefresh()

    expect(meCalls).toBe(5)
    expect(screen.getByLabelText('session state')).toHaveTextContent('authenticated')
    expect(screen.getByLabelText('session user')).toHaveTextContent('Old member')
  })

  it('coalesces expiry hints while the authoritative session read is in flight', async () => {
    const heldRetry = deferred<Response>()
    let meCalls = 0
    let retrySignal: AbortSignal | undefined
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const auxiliary = auxiliaryResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (!url.endsWith('/api/me')) {
        return Promise.reject(new Error(`unexpected fetch: ${url}`))
      }
      meCalls += 1
      if (meCalls === 1) return Promise.resolve(me(OLD_USER))
      retrySignal = init?.signal as AbortSignal
      return heldRetry.promise
    })
    vi.stubGlobal('fetch', fetchMock)
    const { queryClient } = renderAuth()
    await flush()
    queryClient.setQueryData(['private'], 'old cache')

    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    await flush()
    expect(meCalls).toBe(2)
    expect(screen.getByLabelText('session state')).toHaveTextContent('loading')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100)
    })
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    await flush()

    expect(meCalls).toBe(2)
    expect(retrySignal?.aborted).toBe(false)

    heldRetry.resolve(json({ code: 'unauthenticated', error: 'unauthenticated' }, 401))
    await flush()

    expect(meCalls).toBe(2)
    expect(screen.getByLabelText('session state')).toHaveTextContent('anonymous')
    expect(screen.getByLabelText('session user')).toBeEmptyDOMElement()
    expect(queryClient.getQueryData(['private'])).toBeUndefined()
  })

  it('lets a newer foreground read win over a stale lifecycle result', async () => {
    const stale = deferred<Response>()
    let meCalls = 0
    let staleSignal: AbortSignal | undefined
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const auxiliary = auxiliaryResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (!url.endsWith('/api/me')) {
        return Promise.reject(new Error(`unexpected fetch: ${url}`))
      }
      meCalls += 1
      if (meCalls === 1) return Promise.resolve(me(OLD_USER))
      if (meCalls === 2) {
        staleSignal = init?.signal as AbortSignal
        return stale.promise
      }
      return Promise.resolve(me(NEW_USER))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderAuth()
    await flush()

    window.dispatchEvent(new Event('focus'))
    await runScheduledRefresh()
    fireEvent.click(screen.getByRole('button', { name: 'Retry session' }))
    await flush()

    expect(staleSignal?.aborted).toBe(true)
    expect(screen.getByLabelText('session user')).toHaveTextContent('New member')

    stale.resolve(me({ ...OLD_USER, username: 'Stale member' }))
    await flush()

    expect(screen.getByLabelText('session user')).toHaveTextContent('New member')
  })

  it('falls back to focus reconciliation when BroadcastChannel is unavailable', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    let meCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const auxiliary = auxiliaryResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) {
        meCalls += 1
        return Promise.resolve(me(meCalls === 1 ? OLD_USER : NEW_USER))
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderAuth()
    await flush()

    window.dispatchEvent(new Event('focus'))
    await runScheduledRefresh()

    expect(screen.getByLabelText('session user')).toHaveTextContent('New member')
  })

  it('leaves one live channel/listener under StrictMode and removes it on unmount', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const auxiliary = auxiliaryResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) return Promise.resolve(me(OLD_USER))
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    const view = renderAuth(undefined, true)
    await flush()

    expect(FakeBroadcastChannel.instances).toHaveLength(2)
    const [discarded, live] = FakeBroadcastChannel.instances
    expect(discarded.close).toHaveBeenCalledTimes(1)
    expect(live.close).not.toHaveBeenCalled()
    const before = meCallCount(fetchMock)

    discarded.emitInvalidation()
    live.emitInvalidation()
    await runScheduledRefresh()
    expect(meCallCount(fetchMock) - before).toBe(1)

    view.unmount()
    expect(live.close).toHaveBeenCalledTimes(1)
  })

  it.each([
    { provider: 'Apple', button: 'Apple provider', active: 'apple' },
    { provider: 'passkey', button: 'Passkey provider', active: 'passkey-login' },
  ])('defers session expiry during held $provider confirmation and drains one refresh', async ({
    button,
    active,
  }) => {
    const heldConfirmation = deferred<Response>()
    let meCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const auxiliary = auxiliaryResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) {
        meCalls += 1
        if (meCalls === 1) return Promise.resolve(json({ error: 'unauthenticated' }, 401))
        if (meCalls === 2) return heldConfirmation.promise
        return Promise.resolve(me(NEW_USER))
      }
      if (url.endsWith('/api/auth/apple')) {
        return Promise.resolve(json({ status: 'authorized', user: NEW_USER }))
      }
      if (url.endsWith('/api/auth/passkey/login/options')) {
        return Promise.resolve(json({ options: { challenge: 'challenge' }, challengeId: 'id' }))
      }
      if (url.endsWith('/api/auth/passkey/login/verify')) {
        return Promise.resolve(json({ ok: true, user: NEW_USER }))
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderAuth()
    await flush()

    fireEvent.click(screen.getByRole('button', { name: button }))
    await flush()
    expect(screen.getByLabelText('active sign-in')).toHaveTextContent(active)
    expect(meCalls).toBe(2)

    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    await runScheduledRefresh()

    expect(meCalls).toBe(2)
    expect(screen.getByLabelText('active sign-in')).toHaveTextContent(active)
    expect(screen.getByLabelText('provider result')).toBeEmptyDOMElement()

    heldConfirmation.resolve(me(NEW_USER))
    await flush()
    await runScheduledRefresh()

    expect(meCalls).toBe(3)
    expect(screen.getByLabelText('provider result')).toHaveTextContent('true')
    expect(screen.getByLabelText('active sign-in')).toBeEmptyDOMElement()
    expect(screen.getByLabelText('session user')).toHaveTextContent('New member')
  })

  it('invalidates a pre-logout session read so its late 200 cannot resurrect the user', async () => {
    const stale = deferred<Response>()
    let meCalls = 0
    let staleSignal: AbortSignal | undefined
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const auxiliary = auxiliaryResponse(url)
      if (auxiliary) return Promise.resolve(auxiliary)
      if (url.endsWith('/api/me')) {
        meCalls += 1
        if (meCalls === 1) return Promise.resolve(me(OLD_USER))
        staleSignal = init?.signal as AbortSignal
        return stale.promise
      }
      if (url.endsWith('/api/auth/logout')) return Promise.resolve(json({ ok: true }))
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { queryClient } = renderAuth()
    await flush()
    queryClient.setQueryData(['private'], 'discard me')

    window.dispatchEvent(new Event('focus'))
    await runScheduledRefresh()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await flush()

    expect(staleSignal?.aborted).toBe(true)
    expect(screen.getByLabelText('session state')).toHaveTextContent('anonymous')
    expect(queryClient.getQueryData(['private'])).toBeUndefined()

    stale.resolve(me({ ...OLD_USER, username: 'Late old member' }))
    await flush()

    expect(screen.getByLabelText('session state')).toHaveTextContent('anonymous')
    expect(screen.getByLabelText('session user')).toBeEmptyDOMElement()
  })
})
