import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Hono } from 'hono'
import { feedback } from './feedback.js'
import { createSession } from '../session.js'
import { _setUserFeedbackPathForTests } from '../services/userFeedback.js'
import { _setRejectionsPathForTests, getRejections } from '../services/rejections.js'
import type { Env } from '../middleware/auth.js'

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', feedback)
  return app
}

async function cookieFor(sub: string) {
  const t = await createSession({ sub, username: `user-${sub}`, role: 'user' })
  return `eex.session=${t}`
}

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'feedback-route-'))
  _setUserFeedbackPathForTests(join(tmpRoot, 'feedback.json'))
  _setRejectionsPathForTests(join(tmpRoot, 'rejections.json'))
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('feedback route — gating', () => {
  it('rejects unauthenticated', async () => {
    const r = await appUnderTest().request('/')
    expect(r.status).toBe(401)
  })
})

describe('feedback route — GET /', () => {
  it('returns empty buckets for first call', async () => {
    const r = await appUnderTest().request('/', {
      headers: { Cookie: await cookieFor('alice') },
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      movie: { liked: [], disliked: [] },
      tv: { liked: [], disliked: [] },
    })
  })
})

describe('feedback route — POST /', () => {
  it('400 on bad body / type / signal / tmdbId', async () => {
    const app = appUnderTest()
    const cookie = await cookieFor('alice')

    const bad = async (body: unknown) =>
      app.request('/', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

    expect((await bad({ type: 'foo', tmdbId: 1, signal: 'like' })).status).toBe(400)
    expect((await bad({ type: 'movie', tmdbId: 1, signal: 'meh' })).status).toBe(400)
    expect((await bad({ type: 'movie', tmdbId: -1, signal: 'like' })).status).toBe(400)
  })

  it('like writes title to user feedback only, not household rejections', async () => {
    const app = appUnderTest()
    const cookie = await cookieFor('alice')
    const r = await app.request('/', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'movie', tmdbId: 42, title: 'Sinners', signal: 'like' }),
    })
    expect(r.status).toBe(200)
    const fb = (await (await app.request('/', { headers: { Cookie: cookie } })).json()) as {
      movie: { liked: Array<{ id: number; title: string }> }
    }
    expect(fb.movie.liked).toContainEqual({ id: 42, title: 'Sinners' })
    expect((await getRejections()).movie.find((e) => e.id === 42)).toBeUndefined()
  })

  it('dislike writes title to BOTH user feedback and household rejections', async () => {
    const app = appUnderTest()
    const cookie = await cookieFor('alice')
    await app.request('/', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tv', tmdbId: 99, title: 'Pokémon', signal: 'dislike' }),
    })
    const fb = (await (await app.request('/', { headers: { Cookie: cookie } })).json()) as {
      tv: { disliked: Array<{ id: number; title: string }> }
    }
    expect(fb.tv.disliked).toContainEqual({ id: 99, title: 'Pokémon' })
    expect((await getRejections()).tv).toContainEqual({ id: 99, title: 'Pokémon' })
  })

  it('POST without title defaults to empty string in both stores', async () => {
    const app = appUnderTest()
    const cookie = await cookieFor('alice')
    await app.request('/', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'movie', tmdbId: 12, signal: 'dislike' }),
    })
    const fb = (await (await app.request('/', { headers: { Cookie: cookie } })).json()) as {
      movie: { disliked: Array<{ id: number; title: string }> }
    }
    expect(fb.movie.disliked).toContainEqual({ id: 12, title: '' })
    expect((await getRejections()).movie).toContainEqual({ id: 12, title: '' })
  })
})

describe('feedback route — DELETE', () => {
  it('removing a like only touches user feedback', async () => {
    const app = appUnderTest()
    const cookie = await cookieFor('alice')
    await app.request('/', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'movie', tmdbId: 5, title: 'X', signal: 'like' }),
    })
    const r = await app.request('/movie/5/like', {
      method: 'DELETE',
      headers: { Cookie: cookie },
    })
    expect(r.status).toBe(200)
    const fb = (await (await app.request('/', { headers: { Cookie: cookie } })).json()) as {
      movie: { liked: Array<{ id: number; title: string }> }
    }
    expect(fb.movie.liked.find((e) => e.id === 5)).toBeUndefined()
  })

  it('removing a dislike also clears household rejection when no one else dissents', async () => {
    const app = appUnderTest()
    const aliceCookie = await cookieFor('alice')
    await app.request('/', {
      method: 'POST',
      headers: { Cookie: aliceCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'movie', tmdbId: 7, title: 'X', signal: 'dislike' }),
    })
    expect((await getRejections()).movie.find((e) => e.id === 7)).toBeDefined()

    await app.request('/movie/7/dislike', {
      method: 'DELETE',
      headers: { Cookie: aliceCookie },
    })
    expect((await getRejections()).movie.find((e) => e.id === 7)).toBeUndefined()
  })

  it('removing a dislike preserves household rejection when another user still dislikes', async () => {
    const app = appUnderTest()
    const aliceCookie = await cookieFor('alice')
    const bobCookie = await cookieFor('bob')

    await app.request('/', {
      method: 'POST',
      headers: { Cookie: aliceCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'movie', tmdbId: 8, title: 'X', signal: 'dislike' }),
    })
    await app.request('/', {
      method: 'POST',
      headers: { Cookie: bobCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'movie', tmdbId: 8, title: 'X', signal: 'dislike' }),
    })
    expect((await getRejections()).movie.find((e) => e.id === 8)).toBeDefined()

    await app.request('/movie/8/dislike', {
      method: 'DELETE',
      headers: { Cookie: aliceCookie },
    })
    expect((await getRejections()).movie.find((e) => e.id === 8)).toBeDefined() // bob still dissents
  })
})
