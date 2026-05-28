import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ApiError } from './errors'
import { mediaApi, posterFor } from './media'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  globalThis.fetch = fetchMock as typeof fetch
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } })
})

function jsonRes(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

describe('mediaApi', () => {
  it('movies(q) hits /api/media/movies?q=... with credentials', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ items: [], total: 0 }))

    await mediaApi.movies('matrix')

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/media/movies?q=matrix'),
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('movies() without a query omits the q param', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ items: [], total: 0 }))

    await mediaApi.movies()

    const calledUrl = String(fetchMock.mock.calls[0][0])
    expect(calledUrl).toContain('/api/media/movies')
    expect(calledUrl).not.toContain('q=')
  })

  it('normalizes snake_case rows to camelCase', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({
        items: [
          {
            id: 7,
            tmdb_id: 603,
            imdb_id: 'tt0133093',
            title: 'The Matrix',
            year: 1999,
            added_at: '2026-01-01T00:00:00Z',
            file_id: 42,
            overview: null,
            poster_path: null,
          },
        ],
        total: 1,
      }),
    )

    const res = await mediaApi.movies('matrix')

    expect(res.total).toBe(1)
    expect(res.items[0]).toMatchObject({
      id: 7,
      tmdbId: 603,
      imdbId: 'tt0133093',
      title: 'The Matrix',
      year: 1999,
      addedAt: '2026-01-01T00:00:00Z',
      fileId: 42,
      overview: null,
      posterPath: null,
    })
  })

  it('shows() normalizes show rows including tvdbId', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({
        items: [
          {
            id: 3,
            tmdb_id: null,
            tvdb_id: 81189,
            title: 'Breaking Bad',
            year: 2008,
            added_at: '2026-02-02T00:00:00Z',
            imdb_id: null,
            overview: null,
            poster_path: null,
          },
        ],
        total: 1,
      }),
    )

    const res = await mediaApi.shows()
    expect(res.items[0]).toMatchObject({
      id: 3,
      tmdbId: null,
      tvdbId: 81189,
      title: 'Breaking Bad',
      addedAt: '2026-02-02T00:00:00Z',
    })
  })

  it('defaults total to items.length when the response omits it', async () => {
    // The show-scoped /shows/{id}/episodes route has no `total`.
    fetchMock.mockResolvedValueOnce(
      jsonRes({
        items: [
          { id: 1, show_id: 3, season: 1, episode: 1, title: 'Pilot', air_date: null, file_id: 9 },
          { id: 2, show_id: 3, season: 1, episode: 2, title: null, air_date: null, file_id: 10 },
        ],
      }),
    )

    const res = await mediaApi.episodes(3)
    expect(res.total).toBe(2)
    expect(res.items[0]).toMatchObject({ showId: 3, season: 1, episode: 1, fileId: 9 })
  })

  it('throws a typed ApiError on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({ error: 'not_found' }, { status: 404 }),
    )

    await expect(mediaApi.movies('nope')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      code: 'not_found',
    } satisfies Partial<ApiError>)
  })

  it('scan() POSTs /api/media/scan', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ status: 'started', jobId: 'abc' }))

    const res = await mediaApi.scan()

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/media/scan'),
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    )
    expect(res).toMatchObject({ status: 'started' })
  })
})

describe('posterFor', () => {
  it('returns undefined when posterPath is null (fallback path)', () => {
    expect(posterFor({ posterPath: null })).toBeUndefined()
    expect(posterFor({})).toBeUndefined()
  })

  it('builds a TMDB image URL when posterPath is present', () => {
    expect(posterFor({ posterPath: '/abc.jpg' })).toBe(
      'https://image.tmdb.org/t/p/w342/abc.jpg',
    )
  })
})
