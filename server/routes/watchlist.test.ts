import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Hono } from 'hono'
import { watchlist } from './watchlist.js'
import { createMemberSession as createSession } from '../test/authFixture.js'
import { _setUserWatchlistPathForTests } from '../services/userWatchlist.js'
import type { Env } from '../middleware/auth.js'

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', watchlist)
  return app
}

async function cookieFor(sub: 'alice' | 'bob') {
  // D7 requires namespace-prefixed subs; map names to distinct plex subs
  // so per-user isolation is exercised.
  const numericSub = sub === 'alice' ? 'plex:1' : 'plex:2'
  const t = await createSession({ sub: numericSub, username: `user-${sub}`, role: 'user' })
  return `eex.session=${t}`
}

let tmpRoot: string
let watchlistPath: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'watchlist-route-'))
  watchlistPath = join(tmpRoot, 'user-watchlist.json')
  _setUserWatchlistPathForTests(watchlistPath)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

type Item = {
  kind: 'movie' | 'tv'
  id: number
  title: string
  poster_path?: string
  added_at: string
}

async function getItems(app: ReturnType<typeof appUnderTest>, cookie: string): Promise<Item[]> {
  const r = await app.request('/', { headers: { Cookie: cookie } })
  expect(r.status).toBe(200)
  return ((await r.json()) as { items: Item[] }).items
}

function put(app: ReturnType<typeof appUnderTest>, cookie: string, path: string, body: unknown) {
  return app.request(path, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('watchlist route — gating', () => {
  it('rejects unauthenticated GET', async () => {
    const r = await appUnderTest().request('/')
    expect(r.status).toBe(401)
  })

  it('rejects unauthenticated PUT', async () => {
    const r = await appUnderTest().request('/movie/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'X' }),
    })
    expect(r.status).toBe(401)
  })
})

describe('watchlist route — GET /', () => {
  it('returns empty items for first call', async () => {
    const items = await getItems(appUnderTest(), await cookieFor('alice'))
    expect(items).toEqual([])
  })
})

describe('watchlist route — PUT', () => {
  it('adds a movie and returns the merged list', async () => {
    const app = appUnderTest()
    const cookie = await cookieFor('alice')
    const r = await put(app, cookie, '/movie/42', { title: 'Sinners', poster_path: '/s.jpg' })
    expect(r.status).toBe(200)
    const items = ((await r.json()) as { items: Item[] }).items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'movie', id: 42, title: 'Sinners', poster_path: '/s.jpg' })
    expect(typeof items[0].added_at).toBe('string')
  })

  it('upsert is idempotent — repeated PUT keeps one row and preserves added_at', async () => {
    const app = appUnderTest()
    const cookie = await cookieFor('alice')
    await put(app, cookie, '/tv/99', { title: 'Severance' })
    const first = await getItems(app, cookie)
    expect(first).toHaveLength(1)
    const firstAddedAt = first[0].added_at

    // Re-PUT same id with an updated title; row count stays 1, added_at
    // is preserved, title updates.
    const r = await put(app, cookie, '/tv/99', { title: 'Severance S2' })
    expect(r.status).toBe(200)
    const after = await getItems(app, cookie)
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(99)
    expect(after[0].title).toBe('Severance S2')
    expect(after[0].added_at).toBe(firstAddedAt)
  })

  it('poster_path can be dropped by omitting it on a later upsert', async () => {
    const app = appUnderTest()
    const cookie = await cookieFor('alice')
    await put(app, cookie, '/movie/7', { title: 'X', poster_path: '/p.jpg' })
    expect((await getItems(app, cookie))[0].poster_path).toBe('/p.jpg')
    await put(app, cookie, '/movie/7', { title: 'X' })
    expect((await getItems(app, cookie))[0].poster_path).toBeUndefined()
  })

  it('merges both kinds without colliding on a shared numeric id', async () => {
    const app = appUnderTest()
    const cookie = await cookieFor('alice')
    // Same numeric id in both buckets must not collide.
    await put(app, cookie, '/movie/5', { title: 'M' })
    await put(app, cookie, '/tv/5', { title: 'T' })
    const items = await getItems(app, cookie)
    expect(items).toHaveLength(2)
    // Both kinds survive independently under the same id.
    expect(items).toContainEqual(expect.objectContaining({ kind: 'movie', id: 5, title: 'M' }))
    expect(items).toContainEqual(expect.objectContaining({ kind: 'tv', id: 5, title: 'T' }))
  })

  it('orders items newest added_at first', async () => {
    const app = appUnderTest()
    const cookie = await cookieFor('alice')
    // Seed a store whose added_at values are clearly separated so the
    // ordering is unambiguous (route-set timestamps can collide within a
    // millisecond, which is fine — ordering only matters across real gaps).
    await fs.writeFile(
      watchlistPath,
      JSON.stringify({
        'plex:1': {
          movie: [{ id: 1, title: 'Old', added_at: '2024-01-01T00:00:00.000Z' }],
          tv: [{ id: 2, title: 'New', added_at: '2025-06-01T00:00:00.000Z' }],
        },
      }),
    )
    _setUserWatchlistPathForTests(watchlistPath)
    const items = await getItems(app, cookie)
    expect(items.map((i) => i.id)).toEqual([2, 1])
  })

  it('400 on bad kind / id / title', async () => {
    const app = appUnderTest()
    const cookie = await cookieFor('alice')
    expect((await put(app, cookie, '/foo/1', { title: 'X' })).status).toBe(400)
    expect((await put(app, cookie, '/movie/0', { title: 'X' })).status).toBe(400)
    expect((await put(app, cookie, '/movie/-1', { title: 'X' })).status).toBe(400)
    expect((await put(app, cookie, '/movie/1.5', { title: 'X' })).status).toBe(400)
    expect((await put(app, cookie, '/movie/1', { title: '' })).status).toBe(400)
    expect((await put(app, cookie, '/movie/1', {})).status).toBe(400)
    expect((await put(app, cookie, '/movie/1', { title: 'x'.repeat(513) })).status).toBe(400)
    expect(
      (await put(app, cookie, '/movie/1', { title: 'X', poster_path: 5 })).status,
    ).toBe(400)
  })

  it('413 when body exceeds the size cap', async () => {
    const app = appUnderTest()
    const cookie = await cookieFor('alice')
    const r = await app.request('/movie/1', {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'X', pad: 'p'.repeat(5000) }),
    })
    expect(r.status).toBe(413)
  })
})

describe('watchlist route — DELETE', () => {
  it('removes an item and returns the remaining list', async () => {
    const app = appUnderTest()
    const cookie = await cookieFor('alice')
    await put(app, cookie, '/movie/1', { title: 'A' })
    await put(app, cookie, '/movie/2', { title: 'B' })
    const r = await app.request('/movie/1', { method: 'DELETE', headers: { Cookie: cookie } })
    expect(r.status).toBe(200)
    const items = ((await r.json()) as { items: Item[] }).items
    expect(items.map((i) => i.id)).toEqual([2])
  })

  it('DELETE of an absent item is a no-op 200', async () => {
    const app = appUnderTest()
    const cookie = await cookieFor('alice')
    const r = await app.request('/movie/999', { method: 'DELETE', headers: { Cookie: cookie } })
    expect(r.status).toBe(200)
    expect(((await r.json()) as { items: Item[] }).items).toEqual([])
  })

  it('400 on bad kind / id', async () => {
    const app = appUnderTest()
    const cookie = await cookieFor('alice')
    const del = (p: string) => app.request(p, { method: 'DELETE', headers: { Cookie: cookie } })
    expect((await del('/foo/1')).status).toBe(400)
    expect((await del('/movie/0')).status).toBe(400)
    expect((await del('/movie/1.5')).status).toBe(400)
  })
})

describe('watchlist route — per-user isolation', () => {
  it("user A's watchlist is invisible to user B", async () => {
    const app = appUnderTest()
    const alice = await cookieFor('alice')
    const bob = await cookieFor('bob')

    await put(app, alice, '/movie/42', { title: 'Alice pick' })
    expect((await getItems(app, alice)).map((i) => i.id)).toEqual([42])
    // Bob sees nothing.
    expect(await getItems(app, bob)).toEqual([])

    // Bob adds his own; still doesn't leak into Alice's.
    await put(app, bob, '/tv/7', { title: 'Bob pick' })
    expect((await getItems(app, bob)).map((i) => i.id)).toEqual([7])
    expect((await getItems(app, alice)).map((i) => i.id)).toEqual([42])
  })
})
