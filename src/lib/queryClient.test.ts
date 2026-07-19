// Covers the auth-expiry logic in queryClient.ts: debounced
// SESSION_EXPIRED_EVENT dispatch on 401 plus an explicit unauthenticated code,
// forbidden-403 exclusion, and the no-retry-on-auth policy.
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
  // react-query v5 types the queryCache onError error param as `Error`. The
  // helper keeps `unknown` so tests can pass plain Errors and ApiErrors alike;
  // handleAuthError only reads `.status`/`instanceof ApiError`, so the cast is
  // sound for the values these tests own.
  mod.queryClient.getQueryCache().config.onError?.(error as Error, STUB)
}

function fireMutationError(mod: QueryClientModule, error: unknown): void {
  // mutationCache onError in this query-core is
  // (error, variables, onMutateResult, mutation, context) — 5 params. Only the
  // error is consumed by handleAuthError; the trailing four are STUBs.
  mod.queryClient.getMutationCache().config.onError?.(error as Error, STUB, STUB, STUB, STUB)
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

// A vitest Mock is not structurally a DOM EventListener, so register it through
// one typed bridge (the standard `as unknown as` double-cast, no `any`). Keeping
// the cast in a single helper means the test bodies stay readable and the mock's
// `.mock.calls` assertion ergonomics are preserved.
function addListener(target: EventTarget, type: string): void {
  target.addEventListener(type, listener as unknown as EventListener)
}

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
  it('dispatches SESSION_EXPIRED_EVENT once for an edge unauthenticated 401 surfaced through the queryCache', async () => {
    const { mod, ApiError } = await freshModule()
    addListener(win, mod.SESSION_EXPIRED_EVENT)

    fireQueryError(mod, new ApiError(401, 'x', 'unauthenticated'))

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].type).toBe(mod.SESSION_EXPIRED_EVENT)
    expect(mod.SESSION_EXPIRED_EVENT).toBe('exchange:session-expired')
  })

  it('does NOT dispatch for a forbidden ApiError 403 (parental section_blocked, admin_only)', async () => {
    // A 403 means the cookie is valid but the section/action is forbidden.
    // Forcing a logout here dumps a signed-in family member to the login
    // walkthrough the moment they touch a policy-blocked tab (e.g. Downloads),
    // and re-login loops straight back into it. Must surface in place, never
    // clear the session.
    const { mod, ApiError } = await freshModule()
    addListener(win, mod.SESSION_EXPIRED_EVENT)

    fireQueryError(mod, new ApiError(403, 'section blocked', 'section_blocked'))
    fireQueryError(mod, new ApiError(403, 'admin only', 'forbidden'))

    expect(listener).not.toHaveBeenCalled()
  })

  it('does NOT dispatch for a 403 even when it is coded unauthenticated', async () => {
    const { mod, ApiError } = await freshModule()
    addListener(win, mod.SESSION_EXPIRED_EVENT)

    fireQueryError(mod, new ApiError(403, 'session expired', 'unauthenticated'))

    expect(listener).not.toHaveBeenCalled()
  })

  it('does NOT dispatch for ApiError 500', async () => {
    const { mod, ApiError } = await freshModule()
    addListener(win, mod.SESSION_EXPIRED_EVENT)

    fireQueryError(mod, new ApiError(500, 'boom'))

    expect(listener).not.toHaveBeenCalled()
  })

  it('does NOT dispatch for a status-less error (plain Error)', async () => {
    const { mod } = await freshModule()
    addListener(win, mod.SESSION_EXPIRED_EVENT)

    fireQueryError(mod, new Error('network down'))

    expect(listener).not.toHaveBeenCalled()
  })

  it('does NOT dispatch for a private status-only 401 without the edge error code', async () => {
    class PrivateError extends Error {
      status: number
      constructor(status: number) {
        super(`private ${status}`)
        this.status = status
      }
    }
    const { mod } = await freshModule()
    addListener(win, mod.SESSION_EXPIRED_EVENT)

    fireQueryError(mod, new PrivateError(401))

    expect(listener).not.toHaveBeenCalled()
  })

  it('does NOT dispatch for an upstream 401 carrying a non-session error code', async () => {
    const { mod, ApiError } = await freshModule()
    addListener(win, mod.SESSION_EXPIRED_EVENT)

    fireQueryError(mod, new ApiError(401, 'upstream rejected credentials', 'upstream_unauthorized'))

    expect(listener).not.toHaveBeenCalled()
  })

  it('does NOT dispatch for a duck-typed non-auth status (500) or a non-numeric status', async () => {
    const { mod } = await freshModule()
    addListener(win, mod.SESSION_EXPIRED_EVENT)

    fireQueryError(mod, Object.assign(new Error('boom'), { status: 500 }))
    fireQueryError(mod, Object.assign(new Error('weird'), { status: '401' }))

    expect(listener).not.toHaveBeenCalled()
  })

  it('retry treats duck-typed 401/403 as non-retryable too', async () => {
    const { mod } = await freshModule()
    const retry = mod.queryClient.getDefaultOptions().queries?.retry
    const fn = retry as (failureCount: number, error: unknown) => boolean

    expect(fn(0, Object.assign(new Error('x'), { status: 401 }))).toBe(false)
    expect(fn(0, Object.assign(new Error('x'), { status: 403 }))).toBe(false)
    expect(fn(0, Object.assign(new Error('x'), { status: 500 }))).toBe(true)
  })

  it('debounces a burst: two 401s within 2000ms dispatch only once', async () => {
    const { mod, ApiError } = await freshModule()
    addListener(win, mod.SESSION_EXPIRED_EVENT)

    // Date.now is pinned at 1_000_000 by beforeEach; second call is < 2000ms later.
    fireQueryError(mod, new ApiError(401, 'first', 'unauthenticated'))
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + 1_999)
    fireQueryError(mod, new ApiError(401, 'second', 'unauthenticated'))

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('dispatches again after the debounce window elapses', async () => {
    const { mod, ApiError } = await freshModule()
    addListener(win, mod.SESSION_EXPIRED_EVENT)

    fireQueryError(mod, new ApiError(401, 'first', 'unauthenticated'))
    // Advance to exactly the 2000ms boundary (now - lastDispatch === 2000, not < 2000).
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + 2_000)
    fireQueryError(mod, new ApiError(401, 'second', 'unauthenticated'))

    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('mutationCache onError also dispatches on 401', async () => {
    const { mod, ApiError } = await freshModule()
    addListener(win, mod.SESSION_EXPIRED_EVENT)

    fireMutationError(mod, new ApiError(401, 'x', 'unauthenticated'))

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('queryCache and mutationCache share one debounce: a 401 on each within 2000ms dispatches only once', async () => {
    const { mod, ApiError } = await freshModule()
    addListener(win, mod.SESSION_EXPIRED_EVENT)

    // Both caches funnel through the same module-scoped `lastDispatch` clock.
    // Date.now is pinned at 1_000_000 by beforeEach; the second hit is < 2000ms later.
    fireQueryError(mod, new ApiError(401, 'query', 'unauthenticated'))
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + 1_999)
    fireMutationError(mod, new ApiError(401, 'mutation', 'unauthenticated'))

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('exports one notifier whose debounce is shared with React Query producers', async () => {
    const { mod, ApiError } = await freshModule()
    addListener(win, mod.SESSION_EXPIRED_EVENT)
    const notify = (
      mod as QueryClientModule & { notifySessionExpired?: (error: unknown) => void }
    ).notifySessionExpired

    expect(notify).toBeTypeOf('function')
    if (!notify) return

    notify(new ApiError(401, 'imperative fetch', 'unauthenticated'))
    fireQueryError(mod, new ApiError(401, 'query fetch', 'unauthenticated'))

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
    expect(() => fireQueryError(mod, new ApiError(401, 'x', 'unauthenticated'))).not.toThrow()
  })
})
