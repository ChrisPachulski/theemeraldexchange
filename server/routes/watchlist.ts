// Per-user watchlist CRUD. Admin-free: every authenticated household
// member manages their OWN list only (scoped by session.sub). No route
// here can read or mutate another user's watchlist.
//
// The store (services/userWatchlist.ts) keeps movie and tv in separate
// buckets so ids can't collide across kinds. This route flattens them
// into a single `items` array tagged with `kind`, newest added_at first,
// which is the shape the SPA renders directly.

import { Hono } from 'hono'
import { requireAuth, type Env } from '../middleware/auth.js'
import { parseLimitedJson } from '../services/parseLimitedJson.js'
import {
  getWatchlist,
  upsertWatchlist,
  removeWatchlist,
  type WatchlistKind,
} from '../services/userWatchlist.js'

// A watchlist entry is a title + optional poster path — well under 1 KB.
// Anything bigger is hostile or a paste accident; bound the body read so
// it can't balloon memory (mirrors settings.ts).
const MAX_BODY_BYTES = 4 * 1024
const MAX_TITLE_LEN = 512

export const watchlist = new Hono<Env>()

watchlist.use('*', requireAuth)

function isKind(v: unknown): v is WatchlistKind {
  return v === 'movie' || v === 'tv'
}

function parseId(raw: string): number | null {
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n <= 0) return null
  return n
}

// Merge both kinds into one newest-first list — the response shape shared
// by GET, PUT and DELETE so the client always gets the current view back.
async function itemsFor(sub: string) {
  const wl = await getWatchlist(sub)
  const items = [
    ...wl.movie.map((e) => ({ kind: 'movie' as const, ...e })),
    ...wl.tv.map((e) => ({ kind: 'tv' as const, ...e })),
  ]
  // Newest added_at first; ISO-8601 strings sort lexicographically in
  // timestamp order, so a plain string compare is correct here.
  items.sort((a, b) => (a.added_at < b.added_at ? 1 : a.added_at > b.added_at ? -1 : 0))
  return items
}

watchlist.get('/', async (c) => {
  const session = c.get('session')
  return c.json({ items: await itemsFor(session.sub) })
})

watchlist.put('/:kind/:id', async (c) => {
  const session = c.get('session')
  const kindParam = c.req.param('kind')
  if (!isKind(kindParam)) return c.json({ error: 'invalid_kind' }, 400)
  const id = parseId(c.req.param('id'))
  if (id === null) return c.json({ error: 'invalid_id' }, 400)

  const parsed = await parseLimitedJson(c, MAX_BODY_BYTES)
  if (parsed.tooLarge) return c.json({ error: 'body_too_large' }, 413)
  const body = (parsed.body ?? {}) as { title?: unknown; poster_path?: unknown }

  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title || title.length > MAX_TITLE_LEN) {
    return c.json({ error: 'invalid_title' }, 400)
  }
  let poster_path: string | undefined
  if (body.poster_path !== undefined) {
    if (typeof body.poster_path !== 'string' || body.poster_path.length > MAX_TITLE_LEN) {
      return c.json({ error: 'invalid_poster_path' }, 400)
    }
    poster_path = body.poster_path
  }

  await upsertWatchlist(session.sub, kindParam, { id, title, poster_path })
  return c.json({ items: await itemsFor(session.sub) })
})

watchlist.delete('/:kind/:id', async (c) => {
  const session = c.get('session')
  const kindParam = c.req.param('kind')
  if (!isKind(kindParam)) return c.json({ error: 'invalid_kind' }, 400)
  const id = parseId(c.req.param('id'))
  if (id === null) return c.json({ error: 'invalid_id' }, 400)

  await removeWatchlist(session.sub, kindParam, id)
  return c.json({ items: await itemsFor(session.sub) })
})
