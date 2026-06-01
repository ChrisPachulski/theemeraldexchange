import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fetchWithTimeout, fetchStreamWithConnectTimeout, fetchJsonWithTimeout } from './upstream.js'

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

describe('fetchStreamWithConnectTimeout', () => {
  beforeEach(() => {
    vi.stubGlobal('console', {
      ...console,
      error: vi.fn(),
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the live Response (does NOT buffer the body) when headers arrive in time', async () => {
    // Unlike fetchWithTimeout, this wrapper must pass the SAME Response object
    // straight through (no arrayBuffer() re-wrap) so the body can stream.
    const upstream = new Response('streamingbody', { status: 200 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => upstream),
    )
    const r = await fetchStreamWithConnectTimeout('http://upstream', {}, 1000, 'media')
    expect(r.status).toBe(200)
    expect(r).toBe(upstream)
    expect(await r.text()).toBe('streamingbody')
  })

  it('synthesizes a 504 upstream_timeout when the connect/TTFB deadline fires', async () => {
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
    const r = await fetchStreamWithConnectTimeout('http://upstream', {}, 10, 'media')
    expect(r.status).toBe(504)
    const body = (await r.json()) as { error: string; service: string }
    expect(body.error).toBe('upstream_timeout')
    expect(body.service).toBe('media')
  })

  it('synthesizes a 504 upstream_unreachable on a network/DNS throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    const r = await fetchStreamWithConnectTimeout('http://upstream', {}, 1000, 'media')
    expect(r.status).toBe(504)
    const body = (await r.json()) as { error: string; service: string }
    expect(body.error).toBe('upstream_unreachable')
    expect(body.service).toBe('media')
  })

  it('clears the connect-timeout timer on the success path (no leaked timer)', async () => {
    // The success branch calls clearTimeout explicitly (no finally). Confirm it
    // ran so no abort timer leaks into the streaming phase.
    vi.useFakeTimers()
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('ok', { status: 200 })),
      )
      const r = await fetchStreamWithConnectTimeout('http://upstream', {}, 1000, 'media')
      expect(r.status).toBe(200)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the connect-timeout timer on the error path (no leaked timer)', async () => {
    // The catch branch also clears the timer (it resolves to a 504 rather than
    // throwing). Pin that the timer count returns to zero.
    vi.useFakeTimers()
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('fetch failed')
        }),
      )
      const r = await fetchStreamWithConnectTimeout('http://upstream', {}, 1000, 'media')
      expect(r.status).toBe(504)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('fetchJsonWithTimeout', () => {
  beforeEach(() => {
    vi.stubGlobal('console', {
      ...console,
      error: vi.fn(),
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves the parsed JSON body when the response is ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ token: 'abc' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    )
    const result = await fetchJsonWithTimeout('http://upstream', {}, 1000, 'plex')
    expect(result).toEqual({ token: 'abc' })
  })

  it('throws `${label}_${status}` and does NOT remap it to a reason error when the response is non-ok', async () => {
    // The guard on lines 125-127 re-throws the original status error instead of
    // mislabeling a non-ok HTTP response as a network 'upstream_unreachable'.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    )
    await expect(fetchJsonWithTimeout('http://upstream', {}, 1000, 'plex')).rejects.toThrow('plex_404')
  })

  it('throws `${label}_upstream_timeout` when fetch aborts', async () => {
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
    await expect(fetchJsonWithTimeout('http://upstream', {}, 10, 'tmdb')).rejects.toThrow('tmdb_upstream_timeout')
  })

  it('throws `${label}_upstream_unreachable` on a network throw and preserves the original cause', async () => {
    const original = new TypeError('fetch failed')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw original
      }),
    )
    const err = await fetchJsonWithTimeout('http://upstream', {}, 1000, 'tmdb').catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('tmdb_upstream_unreachable')
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(TypeError)
    expect((err as { cause?: unknown }).cause).toBe(original)
  })

  it('clears the abort timer on every path (success + throw)', async () => {
    // fetchJsonWithTimeout uses a finally clearTimeout, so both the resolved and
    // the rejected path must leave zero pending timers.
    vi.useFakeTimers()
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ token: 'abc' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
        ),
      )
      const result = await fetchJsonWithTimeout('http://upstream', {}, 1000, 'plex')
      expect(result).toEqual({ token: 'abc' })
      expect(vi.getTimerCount()).toBe(0)

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('nope', { status: 404 })),
      )
      await expect(fetchJsonWithTimeout('http://upstream', {}, 1000, 'plex')).rejects.toThrow('plex_404')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
