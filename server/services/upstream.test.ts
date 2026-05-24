import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fetchWithTimeout } from './upstream.js'

describe('fetchWithTimeout', () => {
  beforeEach(() => {
    vi.stubGlobal('console', {
      ...console,
      error: vi.fn(),
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('forwards the upstream response when fetch resolves in time', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 })),
    )
    const r = await fetchWithTimeout('http://upstream', {}, 1000, 'label')
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('ok')
  })

  it('synthesizes a 504 upstream_timeout when fetch aborts', async () => {
    // Stub fetch to honor the AbortSignal and reject with AbortError —
    // simulates a stuck upstream that doesn't respond before the timer
    // fires. The wrapper must convert this into a 504 Response so the
    // route layer's existing non-ok handling kicks in instead of an
    // unhandled rejection 500.
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: unknown, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('aborted')
              err.name = 'AbortError'
              reject(err)
            })
          }
        })
      }),
    )
    const r = await fetchWithTimeout('http://upstream', {}, 10, 'sonarr')
    expect(r.status).toBe(504)
    const body = (await r.json()) as { error: string; service: string }
    expect(body.error).toBe('upstream_timeout')
    expect(body.service).toBe('sonarr')
  })

  it('synthesizes a 504 upstream_unreachable on a network throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    const r = await fetchWithTimeout('http://upstream', {}, 1000, 'radarr')
    expect(r.status).toBe(504)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('upstream_unreachable')
  })

  it('clears the abort timer on success (no late aborts firing on later calls)', async () => {
    // The wrapper's finally block must clear the setTimeout regardless
    // of resolution path — otherwise a slow successful fetch could
    // still leave a pending timer that fires on a later test.
    vi.useFakeTimers()
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('ok', { status: 200 })),
      )
      const r = await fetchWithTimeout('http://upstream', {}, 1000, 'label')
      expect(r.status).toBe(200)
      // Advance past the timeout — if the timer were still pending and
      // abort() fired, that would be a leak. Nothing observable here,
      // but `getTimerCount` confirms the timer was cleared.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
