import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Hono } from 'hono'
import { rejections } from './rejections.js'
import { createSession } from '../session.js'
import { _setRejectionsPathForTests } from '../services/rejections.js'
import type { Env } from '../middleware/auth.js'

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', rejections)
  return app
}

async function userCookie() {
  const t = await createSession({ sub: '1', username: 'guest', role: 'user' })
  return `eex.session=${t}`
}

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'rejections-route-'))
  _setRejectionsPathForTests(join(tmpRoot, 'rejections.json'))
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('rejections route', () => {
  it('rejects unauthenticated', async () => {
    const r = await appUnderTest().request('/')
    expect(r.status).toBe(401)
  })

  it('GET returns empty on first read', async () => {
    const r = await appUnderTest().request('/', { headers: { Cookie: await userCookie() } })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ movie: [], tv: [] })
  })

  it('POST adds with title, GET reflects', async () => {
    const app = appUnderTest()
    const cookie = await userCookie()
    const r1 = await app.request('/', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'movie', tmdbId: 12345, title: 'Some Movie' }),
    })
    expect(r1.status).toBe(200)
    const r2 = await app.request('/', { headers: { Cookie: cookie } })
    const body = (await r2.json()) as { movie: Array<{ id: number; title: string }> }
    expect(body.movie).toContainEqual({ id: 12345, title: 'Some Movie' })
  })

  it('POST without title still adds (empty title)', async () => {
    const app = appUnderTest()
    const cookie = await userCookie()
    await app.request('/', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'movie', tmdbId: 7777 }),
    })
    const body = (await (await app.request('/', { headers: { Cookie: cookie } })).json()) as {
      movie: Array<{ id: number; title: string }>
    }
    expect(body.movie).toContainEqual({ id: 7777, title: '' })
  })

  it('POST rejects invalid type', async () => {
    const r = await appUnderTest().request('/', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'show', tmdbId: 1 }),
    })
    expect(r.status).toBe(400)
  })

  it('POST rejects invalid tmdbId', async () => {
    const r = await appUnderTest().request('/', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tv', tmdbId: -5 }),
    })
    expect(r.status).toBe(400)
  })

  it('DELETE removes', async () => {
    const app = appUnderTest()
    const cookie = await userCookie()
    await app.request('/', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'tv', tmdbId: 99, title: 'X' }),
    })
    const r = await app.request('/tv/99', { method: 'DELETE', headers: { Cookie: cookie } })
    expect(r.status).toBe(200)
    const after = (await (await app.request('/', { headers: { Cookie: cookie } })).json()) as {
      tv: Array<{ id: number; title: string }>
    }
    expect(after.tv.find((e) => e.id === 99)).toBeUndefined()
  })
})
