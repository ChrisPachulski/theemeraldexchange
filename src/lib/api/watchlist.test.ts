import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyToggle, watchlistApi, type WatchlistEntry } from './watchlist'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  globalThis.fetch = fetchMock as typeof fetch
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } })
})

const entry = (kind: 'movie' | 'tv', id: number): WatchlistEntry => ({
  kind,
  id,
  title: `T${id}`,
  added_at: '2026-10-01T00:00:00.000Z',
})

describe('watchlistApi', () => {
  it('adds with PUT /:kind/:id and the title + poster body, reading back the echoed list', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ items: [entry('tv', 81189)] }))

    const items = await watchlistApi.toggle({ kind: 'tv', id: 81189, title: 'Breaking Bad', posterPath: '/p.jpg', on: true })

    const [url, init] = fetchMock.mock.calls[0]
    expect(new URL(url).pathname).toBe('/api/watchlist/tv/81189')
    expect(init).toMatchObject({ method: 'PUT', credentials: 'include' })
    expect(JSON.parse(init.body)).toEqual({ title: 'Breaking Bad', poster_path: '/p.jpg' })
    expect(items).toEqual([entry('tv', 81189)])
  })

  it('removes with DELETE and no body', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ items: [] }))

    await watchlistApi.toggle({ kind: 'movie', id: 603, title: 'The Matrix', on: false })

    const [url, init] = fetchMock.mock.calls[0]
    expect(new URL(url).pathname).toBe('/api/watchlist/movie/603')
    expect(init.method).toBe('DELETE')
    expect(init.body).toBeUndefined()
  })

  it('throws a status-carrying error on failure', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'invalid_title' }, { status: 400 }))

    await expect(watchlistApi.list()).rejects.toMatchObject({ status: 400 })
  })
})

describe('applyToggle', () => {
  const now = new Date('2026-10-10T00:00:00.000Z')

  it('puts an added title first, replacing an older row for it', () => {
    const next = applyToggle([entry('movie', 1), entry('movie', 2)], { kind: 'movie', id: 2, title: 'Two', on: true }, now)
    expect(next.map((e) => [e.id, e.title])).toEqual([[2, 'Two'], [1, 'T1']])
    expect(next[0].added_at).toBe(now.toISOString())
  })

  it('removes only the same kind and id (a show and a movie may share an id)', () => {
    const next = applyToggle([entry('movie', 7), entry('tv', 7)], { kind: 'tv', id: 7, title: 'x', on: false })
    expect(next).toEqual([entry('movie', 7)])
  })
})
