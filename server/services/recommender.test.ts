// Recommender sidecar client. Pure fetch helper — these tests verify
// the request shape (URL, method, body, headers) and the documented
// error-throwing behavior on non-OK responses. Network is fully
// stubbed via vi.stubGlobal('fetch', …).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  scoreOnce,
  postFeedback,
  postRejection,
  postLibrarySync,
  RecommenderError,
} from './recommender.js'
import { env } from '../env.js'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('scoreOnce', () => {
  it('POSTs to /score with the request body and json content-type', async () => {
    const fakeResp = {
      items: [
        {
          tmdb_id: 1,
          title: 'A',
          year: 2024,
          poster_path: null,
          overview: null,
          score: 0.9,
          provenance: 'personalized',
          reason: 'liked X',
        },
      ],
      model_version: 'v1',
      recipe: 'pure',
      diag: {},
    }
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify(fakeResp), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const out = await scoreOnce({
      sub: 'plex:42',
      kind: 'movie',
      n: 10,
      exclude_recently_shown: true,
      library: [{ tmdb_id: 550, title: 'Fight Club' }],
      feedback: [{ tmdb_id: 1, signal: 'like' }],
      household_rejections: [9],
    })

    expect(out).toEqual(fakeResp)
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [calledUrl, init] = fetchSpy.mock.calls[0]
    expect(calledUrl).toBe(`${env.recommenderUrl}/score`)
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' })
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({
      sub: 'plex:42',
      kind: 'movie',
      n: 10,
      exclude_recently_shown: true,
      library: [{ tmdb_id: 550, title: 'Fight Club' }],
      household_rejections: [9],
    })
    // AbortSignal must be wired for the timeout
    expect(init.signal).toBeDefined()
  })

  it('throws RecommenderError with upstream status on non-OK', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('boom', { status: 503 }),
    )
    let caught: unknown
    try {
      await scoreOnce({ sub: 'x', kind: 'tv', n: 5 })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(RecommenderError)
    const err = caught as RecommenderError
    expect(err.status).toBe(503)
    expect(err.message).toContain('recommender /score 503')
    expect(err.message).toContain('boom')
  })

  it('wraps a thrown fetch (network failure) into RecommenderError without a status', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('ENOTFOUND recommender'),
    )
    let caught: unknown
    try {
      await scoreOnce({ sub: 'x', kind: 'movie', n: 1 })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(RecommenderError)
    const err = caught as RecommenderError
    expect(err.status).toBeUndefined()
    expect(err.message).toContain('ENOTFOUND')
  })

  it('truncates long error bodies (slice 0,200)', async () => {
    const huge = 'x'.repeat(1000)
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(huge, { status: 500 }),
    )
    let caught: unknown
    try {
      await scoreOnce({ sub: 'x', kind: 'movie', n: 1 })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(RecommenderError)
    const err = caught as RecommenderError
    // 200 chars + the prefix; if we ever forget the slice this string
    // would carry the full 1000 chars and this assertion catches it.
    expect(err.message.length).toBeLessThan(300)
  })
})

describe('postFeedback (fire-and-forget)', () => {
  it('POSTs to /events/feedback with the event body', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(null, { status: 200 }),
    )
    await postFeedback({ sub: 'u-1', kind: 'movie', tmdb_id: 7, signal: 'like' })
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>
    const [calledUrl, init] = fetchSpy.mock.calls[0]
    expect(calledUrl).toBe(`${env.recommenderUrl}/events/feedback`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      sub: 'u-1',
      kind: 'movie',
      tmdb_id: 7,
      signal: 'like',
    })
  })

  it('swallows a thrown fetch (does not bubble)', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('network down'),
    )
    await expect(
      postFeedback({ sub: 'u', kind: 'tv', tmdb_id: 1, signal: 'shown' }),
    ).resolves.toBeUndefined()
  })
})

describe('postRejection (fire-and-forget)', () => {
  it('POSTs to /events/rejection with kind + tmdb_id', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(null, { status: 200 }),
    )
    await postRejection({ kind: 'tv', tmdb_id: 42 })
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>
    const [calledUrl, init] = fetchSpy.mock.calls[0]
    expect(calledUrl).toBe(`${env.recommenderUrl}/events/rejection`)
    expect(JSON.parse(init.body)).toEqual({ kind: 'tv', tmdb_id: 42 })
  })

  it('swallows network errors', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('down'))
    await expect(postRejection({ kind: 'movie', tmdb_id: 1 })).resolves.toBeUndefined()
  })
})

describe('postLibrarySync (fire-and-forget)', () => {
  it('POSTs to /events/library/sync with kind + items', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(null, { status: 200 }),
    )
    await postLibrarySync('movie', [{ tmdb_id: 1, title: 'A', source: 'radarr' }])
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>
    const [calledUrl, init] = fetchSpy.mock.calls[0]
    expect(calledUrl).toBe(`${env.recommenderUrl}/events/library/sync`)
    expect(JSON.parse(init.body)).toEqual({
      kind: 'movie',
      items: [{ tmdb_id: 1, title: 'A', source: 'radarr' }],
    })
  })

  it('swallows network errors', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('down'))
    await expect(postLibrarySync('tv', [])).resolves.toBeUndefined()
  })
})
