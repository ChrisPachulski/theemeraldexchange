import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock @sentry/react before importing the module under test. initTelemetry()
// calls Sentry.init() and captureError() calls Sentry.captureException(); we
// don't want real SDK side-effects (or outbound traffic) in unit tests. The
// vi.mock factory is hoisted and survives vi.resetModules(), so the mock stays
// in effect for every dynamic import below.
vi.mock('@sentry/react', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
}))

import * as Sentry from '@sentry/react'

// telemetry.ts holds module-level mutable state (`initialised`,
// `handlersRegistered`). Each test gets a FRESH copy so init/no-op behaviour
// doesn't leak across tests. Load the module dynamically inside each test.
async function loadFresh() {
  vi.resetModules()
  return import('./telemetry')
}

// Shape of the global window stub we hand to the module. addEventListener is a
// spy because registerGlobalHandlers() calls it on a successful init.
type WindowStub = {
  __EXCHANGE_CONFIG__?: { glitchtipDsn?: string }
  addEventListener: ReturnType<typeof vi.fn>
  location: { origin: string }
}

function stubWindow(config?: { glitchtipDsn?: string }): WindowStub {
  const win: WindowStub = {
    addEventListener: vi.fn(),
    location: { origin: 'http://localhost' },
  }
  if (config) win.__EXCHANGE_CONFIG__ = config
  vi.stubGlobal('window', win as unknown as Window & typeof globalThis)
  return win
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('src/lib/telemetry', () => {
  // A. no-op when no DSN
  it('no-ops when neither injected config nor env DSN is present', async () => {
    stubWindow() // no __EXCHANGE_CONFIG__
    vi.stubEnv('VITE_GLITCHTIP_DSN', '')
    const { initTelemetry, isTelemetryActive } = await loadFresh()
    expect(initTelemetry()).toBe(false)
    expect(vi.mocked(Sentry.init)).not.toHaveBeenCalled()
    expect(isTelemetryActive()).toBe(false)
  })

  it('no-ops when the DSN is whitespace-only (trim + length guard)', async () => {
    stubWindow({ glitchtipDsn: '   ' })
    vi.stubEnv('VITE_GLITCHTIP_DSN', '')
    const { initTelemetry, isTelemetryActive } = await loadFresh()
    expect(initTelemetry()).toBe(false)
    expect(vi.mocked(Sentry.init)).not.toHaveBeenCalled()
    expect(isTelemetryActive()).toBe(false)
  })

  // B. DSN resolution precedence
  it('prefers the injected config DSN over the build-time env DSN', async () => {
    stubWindow({ glitchtipDsn: 'https://injected@glitchtip.test/1' })
    vi.stubEnv('VITE_GLITCHTIP_DSN', 'https://buildtime@glitchtip.test/2')
    const { initTelemetry } = await loadFresh()
    expect(initTelemetry()).toBe(true)
    expect(vi.mocked(Sentry.init)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(Sentry.init).mock.calls[0][0]?.dsn).toBe(
      'https://injected@glitchtip.test/1',
    )
  })

  it('falls back to the build-time env DSN when no config is injected', async () => {
    stubWindow() // no __EXCHANGE_CONFIG__
    vi.stubEnv('VITE_GLITCHTIP_DSN', 'https://buildtime@glitchtip.test/2')
    const { initTelemetry } = await loadFresh()
    expect(initTelemetry()).toBe(true)
    expect(vi.mocked(Sentry.init).mock.calls[0][0]?.dsn).toBe(
      'https://buildtime@glitchtip.test/2',
    )
  })

  // C. Sentry.init config invariants (§15 crash-data islands / no PII)
  it('initialises with tracesSampleRate 0 and sendDefaultPii false', async () => {
    stubWindow({ glitchtipDsn: 'https://injected@glitchtip.test/1' })
    vi.stubEnv('VITE_GLITCHTIP_DSN', '')
    const { initTelemetry } = await loadFresh()
    initTelemetry()
    const opts = vi.mocked(Sentry.init).mock.calls[0][0]
    expect(opts?.tracesSampleRate).toBe(0)
    expect(opts?.sendDefaultPii).toBe(false)
    expect(opts?.integrations).toBeTypeOf('function')
    const filtered = (opts?.integrations as (defaults: Array<{ name: string }>) => Array<{ name: string }>)([
      { name: 'BrowserSession' },
      { name: 'GlobalHandlers' },
    ])
    expect(filtered).toEqual([{ name: 'GlobalHandlers' }])
    expect(opts?.environment).toBe(import.meta.env.MODE)
  })

  it('fetches per-install config in the background and records the deployed release', async () => {
    stubWindow()
    vi.stubEnv('VITE_GLITCHTIP_DSN', '')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          dsn: 'https://server@glitchtip.test/7',
          environment: 'production',
          release: 'abc1234',
        }),
      ),
    )
    const { initTelemetryFromServer } = await loadFresh()
    expect(await initTelemetryFromServer()).toBe(true)
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost/api/telemetry/config',
      expect.objectContaining({ credentials: 'include' }),
    )
    expect(vi.mocked(Sentry.init)).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://server@glitchtip.test/7',
        environment: 'production',
        release: 'abc1234',
      }),
    )
  })

  it('scrubs token query values and sensitive context before sending', async () => {
    stubWindow({ glitchtipDsn: 'https://injected@glitchtip.test/1' })
    vi.stubEnv('VITE_GLITCHTIP_DSN', '')
    const { initTelemetry, captureError } = await loadFresh()
    initTelemetry()
    captureError(new Error('boom'), {
      url: '/api/media/stream?t=SECRET&x=1',
      mediaTitle: 'Private Movie',
    })
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(expect.any(Error), {
      extra: {
        url: '/api/media/stream?t=[redacted]&x=1',
        mediaTitle: '[redacted]',
      },
    })
  })

  it('redacts invite fragments from captured errors and every event URL field', async () => {
    const sentinel = 'TELEMETRY_INVITE_SENTINEL'
    const inviteUrl = `https://exchange.test/library#/invite/${sentinel}`
    stubWindow({ glitchtipDsn: 'https://injected@glitchtip.test/1' })
    vi.stubEnv('VITE_GLITCHTIP_DSN', '')
    const { initTelemetry, captureError } = await loadFresh()
    initTelemetry()

    const error = new Error(`Startup failed at ${inviteUrl}`)
    error.name = `StartupException ${inviteUrl}`
    error.stack = `Error: Startup failed at ${inviteUrl}\n at boot (${inviteUrl}:1:1)`
    captureError(error, { navigation: inviteUrl })

    const [capturedError, capturedContext] = vi.mocked(Sentry.captureException).mock.calls[0]
    expect(capturedError).toBeInstanceOf(Error)
    expect((capturedError as Error).name).not.toContain(sentinel)
    expect((capturedError as Error).message).not.toContain(sentinel)
    expect((capturedError as Error).stack).not.toContain(sentinel)
    expect(JSON.stringify(capturedContext)).not.toContain(sentinel)

    const options = vi.mocked(Sentry.init).mock.calls[0][0]
    const beforeSend = options?.beforeSend as unknown as (
      event: Record<string, unknown>,
    ) => Record<string, unknown>
    const event = {
      request: { url: inviteUrl },
      message: `Navigation failed: ${inviteUrl}`,
      exception: { values: [{ value: `Thrown from ${inviteUrl}` }] },
      breadcrumbs: [
        {
          category: 'navigation',
          message: `replaceState ${inviteUrl}`,
          data: { from: inviteUrl, to: inviteUrl },
        },
      ],
    }
    const redacted = beforeSend(event)

    expect(JSON.stringify(redacted)).not.toContain(sentinel)
    expect(JSON.stringify(redacted)).toContain('#/invite/[redacted]')
  })

  // D. idempotency / double-init guard
  it('initialises Sentry exactly once across repeated calls', async () => {
    stubWindow({ glitchtipDsn: 'https://injected@glitchtip.test/1' })
    vi.stubEnv('VITE_GLITCHTIP_DSN', '')
    const { initTelemetry, isTelemetryActive } = await loadFresh()
    expect(initTelemetry()).toBe(true)
    expect(initTelemetry()).toBe(true)
    expect(vi.mocked(Sentry.init)).toHaveBeenCalledTimes(1)
    expect(isTelemetryActive()).toBe(true)
  })

  // E. global handler registration
  it('registers window error + unhandledrejection handlers that capture', async () => {
    const win = stubWindow({ glitchtipDsn: 'https://injected@glitchtip.test/1' })
    vi.stubEnv('VITE_GLITCHTIP_DSN', '')
    const { initTelemetry } = await loadFresh()
    initTelemetry()

    expect(win.addEventListener).toHaveBeenCalledWith('error', expect.any(Function))
    expect(win.addEventListener).toHaveBeenCalledWith(
      'unhandledrejection',
      expect.any(Function),
    )

    type Listener = (event: unknown) => void
    const errorCall = win.addEventListener.mock.calls.find((c) => c[0] === 'error')
    const errorHandler = errorCall?.[1] as Listener
    errorHandler({ error: new Error('boom'), message: 'boom' })
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledTimes(1)

    const rejectionCall = win.addEventListener.mock.calls.find(
      (c) => c[0] === 'unhandledrejection',
    )
    const rejectionHandler = rejectionCall?.[1] as Listener
    rejectionHandler({ reason: new Error('x') })
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledTimes(2)
  })

  // F. captureError gating
  it('captureError no-ops before a successful init', async () => {
    stubWindow() // no DSN
    vi.stubEnv('VITE_GLITCHTIP_DSN', '')
    const { captureError } = await loadFresh()
    captureError(new Error('x'))
    expect(vi.mocked(Sentry.captureException)).not.toHaveBeenCalled()
  })

  it('captureError forwards error + extra context after init, and undefined with none', async () => {
    stubWindow({ glitchtipDsn: 'https://injected@glitchtip.test/1' })
    vi.stubEnv('VITE_GLITCHTIP_DSN', '')
    const { initTelemetry, captureError } = await loadFresh()
    initTelemetry()

    const withCtx = new Error('boom')
    captureError(withCtx, { foo: 'bar' })
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(expect.any(Error), {
      extra: { foo: 'bar' },
    })
    expect((vi.mocked(Sentry.captureException).mock.calls[0][0] as Error).message).toBe('boom')

    const noCtx = new Error('y')
    captureError(noCtx)
    expect(vi.mocked(Sentry.captureException)).toHaveBeenCalledWith(expect.any(Error), undefined)
    expect((vi.mocked(Sentry.captureException).mock.calls[1][0] as Error).message).toBe('y')
  })

  // G. isTelemetryActive reflects state
  it('isTelemetryActive is false on a fresh module and true after init', async () => {
    stubWindow({ glitchtipDsn: 'https://injected@glitchtip.test/1' })
    vi.stubEnv('VITE_GLITCHTIP_DSN', '')
    const { initTelemetry, isTelemetryActive } = await loadFresh()
    expect(isTelemetryActive()).toBe(false)
    initTelemetry()
    expect(isTelemetryActive()).toBe(true)
  })
})
