import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Finding 14-0: a thrown handler exception must be captured to Glitchtip
// (Sentry.captureException) AND return a clean 500, instead of being silently
// dropped by Hono's default error path. @sentry/node is mocked so the test
// needs no DSN; we re-import app.ts inside an isolated module graph so the
// mocked Sentry is the instance app.onError actually calls, mount a throwing
// route, and assert both the capture call and the generic 500 response.

const captureException = vi.hoisted(() => vi.fn())
vi.mock('@sentry/node', () => ({
  captureException,
  init: vi.fn(),
  close: vi.fn(async () => true),
  onUnhandledRejectionIntegration: vi.fn(),
  onUncaughtExceptionIntegration: vi.fn(),
}))

describe('app.onError → Sentry.captureException (finding 14-0)', () => {
  beforeEach(() => {
    vi.resetModules()
    captureException.mockClear()
  })
  afterEach(() => {
    captureException.mockClear()
  })

  it('captures a handler exception and returns a generic 500', async () => {
    const { app } = await import('./app.js')

    // Mount a route that throws AFTER app.onError is registered.
    app.get('/api/__throw_test_14_0', () => {
      throw new Error('boom-secret-detail')
    })

    const res = await app.request('/api/__throw_test_14_0')
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    // Generic body — the thrown message must not leak to the client.
    expect(body.error).toBe('internal')
    expect(JSON.stringify(body)).not.toContain('boom-secret-detail')

    // The exception was reported to telemetry with the original error.
    expect(captureException).toHaveBeenCalled()
    const reportedMessages = captureException.mock.calls
      .map((c) => (c[0] instanceof Error ? c[0].message : String(c[0])))
    expect(reportedMessages).toContain('boom-secret-detail')
  })
})
