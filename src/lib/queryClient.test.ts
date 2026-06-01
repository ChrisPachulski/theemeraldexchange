// Covers the untested auth-expiry logic in queryClient.ts: the debounced
// SESSION_EXPIRED_EVENT dispatch on 401/403 and the no-retry-on-auth policy.
//
// vitest runs in the `node` environment here (the repo default — see
// vitest.config.ts). The project convention is node-env with manual global
// stubbing (see src/components/player/IptvPlayer.test.tsx and src/lib/auth.test.ts),
// and jsdom is NOT an installed dependency (it's only an optional peer of vitest).
// `handleAuthError` only needs window.dispatchEvent/addEventListener and the
// global CustomEvent — Node 19+ provides EventTarget and CustomEvent natively —
// so we stub `window` with a real EventTarget. This gives genuine event
// semantics without pulling in jsdom.
//
// The logic under test (`handleAuthError`) is not exported; we reach it through
// the public surface: the query/mutation cache `onError` config and the `retry`
// default option. `lastDispatch` is module-scoped, so each test re-imports a
// fresh module via vi.resetModules() to reset the debounce clock to 0.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type QueryClientModule = typeof import('./queryClient')
type ApiErrorCtor = typeof import('./api/errors').ApiError

// react-query v5 onError signature is (error, query|mutation [, ...]). Only the
// error is consumed by handleAuthError; the remaining args are unused, so a
// minimal stub typed as `never` satisfies eslint without an `any`.
const STUB = {} as never

// vi.resetModules() gives queryClient.ts a fresh copy of the ApiError class from
// ./api/errors. The test must construct errors from THAT same class instance, or
// `error instanceof ApiError` inside the module is false. So we import both from
// the same post-reset module graph and hand back the matching ApiError ctor.
async function freshModule(): Promise<{ mod: QueryClientModule; ApiError: ApiErrorCtor }> {
  vi.resetModules()
  const mod = await import('./queryClient')
  const { ApiError } = await import('./api/errors')
  return { mod, ApiError }
}

function fireQueryError(mod: QueryClientModule, error: unknown): void {
  mod.queryClient.getQueryCache().config.onError?.(error, STUB)
}

function fireMutationError(mod: QueryClientModule, error: unknown): void {
  mod.queryClient.getMutationCache().config.onError?.(error, STUB, STUB, STUB)
}

// A real EventTarget gives genuine addEventListener/dispatchEvent semantics.
type FakeWindow = EventTarget & { location?: { origin: string } }

function installWindow(): FakeWindow {
  const win = new EventTarget() as FakeWindow
  win.location = { origin: 'https://x.test' }
  vi.stubGlobal('window', win)
  return win
}

let win: FakeWindow
let listener: ReturnType<typeof vi.fn>

beforeEach(() => {
  // Hold time still so the 2s debounce is deterministic unless a test advances it.
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
  win = installWindow()
  listener = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('queryClient session-expiry dispatch', () => {
  it('dispatches SESSION_EXPIRED_EVENT once for an ApiError 401 surfaced through the queryCache', async () => {
    const { mod, ApiError } = await freshModule()
    win.addEventListener(mod.SESSION_EXPIRED_EVENT, listener)

    fireQueryError(mod, new ApiError(401, 'x'))

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].type).toBe(mod.SESSION_EXPIRED_EVENT)
    expect(mod.SESSION_EXPIRED_EVENT).toBe('exchange:session-expired')
  })

  it('dispatches for ApiError 403', async () => {
    const { mod, ApiError } = await freshModule()
    win.addEventListener(mod.SESSION_EXPIRED_EVENT, listener)

    fireQueryError(mod, new ApiError(403, 'forbidden'))

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does NOT dispatch for ApiError 500', async () => {
    const { mod, ApiError } = await freshModule()
    win.addEventListener(mod.SESSION_EXPIRED_EVENT, listener)

    fireQueryError(mod, new ApiError(500, 'boom'))

    expect(listener).not.toHaveBeenCalled()
  })

  it('does NOT dispatch for a non-ApiError (plain Error)', async () => {
    const { mod } = await freshModule()
    win.addEventListener(mod.SESSION_EXPIRED_EVENT, listener)

    fireQueryError(mod, new Error('network down'))

    expect(listener).not.toHaveBeenCalled()
  })

  it('debounces a burst: two 401s within 2000ms dispatch only once', async () => {
    const { mod, ApiError } = await freshModule()
    win.addEventListener(mod.SESSION_EXPIRED_EVENT, listener)

    // Date.now is pinned at 1_000_000 by beforeEach; second call is < 2000ms later.
    fireQueryError(mod, new ApiError(401, 'first'))
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + 1_999)
    fireQueryError(mod, new ApiError(401, 'second'))

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('dispatches again after the debounce window elapses', async () => {
    const { mod, ApiError } = await freshModule()
    win.addEventListener(mod.SESSION_EXPIRED_EVENT, listener)

    fireQueryError(mod, new ApiError(401, 'first'))
    // Advance to exactly the 2000ms boundary (now - lastDispatch === 2000, not < 2000).
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + 2_000)
    fireQueryError(mod, new ApiError(401, 'second'))

    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('mutationCache onError also dispatches on 401', async () => {
    const { mod, ApiError } = await freshModule()
    win.addEventListener(mod.SESSION_EXPIRED_EVENT, listener)

    fireMutationError(mod, new ApiError(401, 'x'))

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('retry option returns false for auth errors and respects failureCount otherwise', async () => {
    const { mod, ApiError } = await freshModule()
    const retry = mod.queryClient.getDefaultOptions().queries?.retry
    expect(typeof retry).toBe('function')
    const fn = retry as (failureCount: number, error: unknown) => boolean

    expect(fn(0, new ApiError(401, 'x'))).toBe(false)
    expect(fn(0, new ApiError(403, 'x'))).toBe(false)
    expect(fn(0, new Error('net'))).toBe(true)
    expect(fn(1, new Error('net'))).toBe(false)
  })

  it('no-window guard: handleAuthError tolerates window === undefined', async () => {
    // Take the `typeof window === 'undefined'` branch by removing the global,
    // then re-importing so the module evaluates against the missing window.
    vi.stubGlobal('window', undefined)
    const { mod, ApiError } = await freshModule()

    // Should be a no-op, not a throw, when there's no window to dispatch on.
    expect(() => fireQueryError(mod, new ApiError(401, 'x'))).not.toThrow()
  })
})
