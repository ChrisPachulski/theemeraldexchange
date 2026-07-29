import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchCast, castCharacter, type CastMember } from './tmdb'

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
