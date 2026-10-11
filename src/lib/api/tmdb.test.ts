import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchCast, fetchPerson, fetchRelated, fetchVideos, castCharacter, type CastMember } from './tmdb'

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

describe('fetchCast', () => {
  it('hits /api/tmdb/credits with type & tmdbId, credentials include', async () => {
    const cast = [{ id: 1, name: 'X', profile_path: null }]
    fetchMock.mockResolvedValueOnce(jsonRes({ cast }))

    const res = await fetchCast({ type: 'movie', tmdbId: 603 })

    const calledUrl = new URL(String(fetchMock.mock.calls[0][0]))
    expect(calledUrl.pathname).toBe('/api/tmdb/credits')
    expect(calledUrl.searchParams.get('type')).toBe('movie')
    expect(calledUrl.searchParams.get('tmdbId')).toBe('603')
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ credentials: 'include' }),
    )
    expect(res).toEqual(cast)
  })

  it('sends tvdbId and not tmdbId when tvdbId is set', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ cast: [] }))

    await fetchCast({ type: 'tv', tvdbId: 81189 })

    const calledUrl = new URL(String(fetchMock.mock.calls[0][0]))
    expect(calledUrl.searchParams.get('tvdbId')).toBe('81189')
    expect(calledUrl.searchParams.has('tmdbId')).toBe(false)
  })

  it('sends only type when neither id is set', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ cast: [] }))

    await fetchCast({ type: 'movie' })

    const calledUrl = new URL(String(fetchMock.mock.calls[0][0]))
    expect(calledUrl.searchParams.get('type')).toBe('movie')
    expect(calledUrl.searchParams.has('tmdbId')).toBe(false)
    expect(calledUrl.searchParams.has('tvdbId')).toBe(false)
  })

  it('treats a 503 (key not configured) as an empty cast', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }))

    await expect(fetchCast({ type: 'movie', tmdbId: 603 })).resolves.toEqual([])
  })

  it('preserves a 401 as a status-carrying error before degraded fallbacks', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({ error: 'unauthenticated' }, { status: 401 }),
    )

    await expect(fetchCast({ type: 'movie', tmdbId: 603 })).rejects.toMatchObject({
      status: 401,
    })
  })

  it('throws on other non-ok statuses', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }))

    await expect(fetchCast({ type: 'movie', tmdbId: 603 })).rejects.toThrow(
      /TMDB credits failed: 500/,
    )
  })

  it('returns [] when the body omits cast', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({}))

    await expect(fetchCast({ type: 'movie', tmdbId: 603 })).resolves.toEqual([])
  })
})

describe('castCharacter', () => {
  it('returns member.character verbatim, even if roles are also present', () => {
    const member: CastMember = {
      id: 1,
      name: 'X',
      profile_path: null,
      character: 'Neo',
      roles: [{ character: 'Other', episode_count: 99 }],
    }
    expect(castCharacter(member)).toBe('Neo')
  })

  it('picks the role with the highest episode_count', () => {
    const member: CastMember = {
      id: 1,
      name: 'X',
      profile_path: null,
      roles: [
        { character: 'A', episode_count: 3 },
        { character: 'B', episode_count: 10 },
      ],
    }
    expect(castCharacter(member)).toBe('B')
  })

  it('returns undefined when the top role has no character', () => {
    const member: CastMember = {
      id: 1,
      name: 'X',
      profile_path: null,
      roles: [{ episode_count: 10 }],
    }
    expect(castCharacter(member)).toBeUndefined()
  })

  it('returns undefined when neither character nor roles are present', () => {
    expect(castCharacter({ id: 1, name: 'X', profile_path: null })).toBeUndefined()
  })

  it('returns undefined for an empty roles array', () => {
    expect(
      castCharacter({ id: 1, name: 'X', profile_path: null, roles: [] }),
    ).toBeUndefined()
  })

  it('does not mutate the input roles array order', () => {
    const roles = [
      { character: 'A', episode_count: 3 },
      { character: 'B', episode_count: 10 },
    ]
    const member: CastMember = { id: 1, name: 'X', profile_path: null, roles }
    castCharacter(member)
    expect(roles[0].character).toBe('A')
    expect(roles[1].character).toBe('B')
  })
})

describe('fetchVideos / fetchRelated', () => {
  it('keys a movie by tmdbId and a show by tvdbId', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ videos: [{ key: 'abcdefghijk', name: 'Trailer', type: 'Trailer', official: true }] }))
    fetchMock.mockResolvedValueOnce(jsonRes({ items: [] }))

    await expect(fetchVideos({ kind: 'movie', id: 603 })).resolves.toHaveLength(1)
    await fetchRelated({ kind: 'tv', id: 81189 })

    const movie = new URL(String(fetchMock.mock.calls[0][0]))
    expect(movie.pathname).toBe('/api/tmdb/videos')
    expect(Object.fromEntries(movie.searchParams)).toEqual({ type: 'movie', tmdbId: '603' })
    const tv = new URL(String(fetchMock.mock.calls[1][0]))
    expect(tv.pathname).toBe('/api/tmdb/related')
    expect(Object.fromEntries(tv.searchParams)).toEqual({ type: 'tv', tvdbId: '81189' })
  })

  it('shapes related rows for TrendingRow', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({ items: [{ tmdbId: 1, title: 'A', year: 1999, posterPath: '/a.jpg' }, { tmdbId: 2, title: 'B', year: null, posterPath: null }] }),
    )

    await expect(fetchRelated({ kind: 'movie', id: 603 })).resolves.toEqual([
      { id: 1, title: 'A', year: 1999, posterPath: '/a.jpg' },
      { id: 2, title: 'B', year: undefined, posterPath: null },
    ])
  })

  it('treats a 503 (key not configured) or a missing list as nothing', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }))
    fetchMock.mockResolvedValueOnce(jsonRes({}))

    await expect(fetchVideos({ kind: 'movie', id: 603 })).resolves.toEqual([])
    await expect(fetchRelated({ kind: 'movie', id: 603 })).resolves.toEqual([])
  })
})

describe('fetchPerson', () => {
  it('returns the person, or null when TMDB is not configured', async () => {
    const person = { id: 6384, name: 'Keanu Reeves', profile_path: null, biography: 'Bio', known_for_department: 'Acting', cast: [] }
    fetchMock.mockResolvedValueOnce(jsonRes(person))
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }))

    await expect(fetchPerson(6384)).resolves.toEqual(person)
    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe('/api/tmdb/person/6384')
    await expect(fetchPerson(6384)).resolves.toBeNull()
  })

  it('throws on other failures', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 502 }))

    await expect(fetchPerson(1)).rejects.toThrow(/TMDB person failed: 502/)
  })
})
