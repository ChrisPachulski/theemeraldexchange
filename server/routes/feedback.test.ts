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

  it('like writes only to user feedback, not household rejections', async () => {
    const app = appUnderTest()
    const cookie = await cookieFor('alice')
    const r = await app.request('/', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'movie', tmdbId: 42, signal: 'like' }),
    })
    expect(r.status).toBe(200)
    const fb = (await (await app.request('/', { headers: { Cookie: cookie } })).json()) as {
      movie: { liked: number[] }
    }
    expect(fb.movie.liked).toContain(42)
    expect((await getRejections()).movie).not.toContain(42)
  })

  it('dislike writes to BOTH user feedback and household rejections', async () => {
    const app = appUnderTest()
    const cookie = await cookieFor('alice')
    await app.request('/', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tv', tmdbId: 99, signal: 'dislike' }),
    })
    const fb = (await (await app.request('/', { headers: { Cookie: cookie } })).json()) as {
      tv: { disliked: number[] }
    }
    expect(fb.tv.disliked).toContain(99)
    expect((await getRejections()).tv).toContain(99)
  })
})

describe('feedback route — DELETE', () => {
  it('removing a like only touches user feedback', async () => {
    const app = appUnderTest()
    const cookie = await cookieFor('alice')
    await app.request('/', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'movie', tmdbId: 5, signal: 'like' }),
    })
    const r = await app.request('/movie/5/like', {
      method: 'DELETE',
      headers: { Cookie: cookie },
    })
    expect(r.status).toBe(200)
    const fb = (await (await app.request('/', { headers: { Cookie: cookie } })).json()) as {
      movie: { liked: number[] }
    }
    expect(fb.movie.liked).not.toContain(5)
  })

  it('removing a dislike also clears household rejection when no one else dissents', async () => {
    const app = appUnderTest()
    const aliceCookie = await cookieFor('alice')
    await app.request('/', {
      method: 'POST',
      headers: { Cookie: aliceCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'movie', tmdbId: 7, signal: 'dislike' }),
    })
    expect((await getRejections()).movie).toContain(7)

    await app.request('/movie/7/dislike', {
      method: 'DELETE',
      headers: { Cookie: aliceCookie },
    })
    expect((await getRejections()).movie).not.toContain(7)
  })

  it('removing a dislike preserves household rejection when another user still dislikes', async () => {
    const app = appUnderTest()
    const aliceCookie = await cookieFor('alice')
    const bobCookie = await cookieFor('bob')

    await app.request('/', {
      method: 'POST',
      headers: { Cookie: aliceCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'movie', tmdbId: 8, signal: 'dislike' }),
    })
    await app.request('/', {
      method: 'POST',
      headers: { Cookie: bobCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'movie', tmdbId: 8, signal: 'dislike' }),
    })
    expect((await getRejections()).movie).toContain(8)

    await app.request('/movie/8/dislike', {
      method: 'DELETE',
      headers: { Cookie: aliceCookie },
    })
    expect((await getRejections()).movie).toContain(8) // bob still dissents
  })
})
