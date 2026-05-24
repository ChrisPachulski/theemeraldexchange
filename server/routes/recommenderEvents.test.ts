// /api/recommender/event — narrow pass-through that mirrors client-
// side conversion signals (currently 'clicked' only) to the local
// recommender. The route itself is small; what we lock in here is
// the signal/kind/tmdbId validation surface so a malformed body can't
// reach the sidecar's INSERT statements where a CHECK constraint
// failure would 500 the mirror and leave SPA state mismatched.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { recommenderEvents } from './recommenderEvents.js'
import { createSession } from '../session.js'
import type { Env } from '../middleware/auth.js'

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', recommenderEvents)
  return app
}

async function userCookie() {
  const t = await createSession({ sub: '42', username: 'guest', role: 'user' })
  return `eex.session=${t}`
}

beforeEach(() => {
  // Stub the recommender mirror — the route fires postFeedback, which
  // hits fetch under the hood. Allow any call to succeed so the
  // route's own response isn't dependent on sidecar reachability.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /event — happy path', () => {
  it('accepts a valid clicked event for movie', async () => {
    const r = await appUnderTest().request('/event', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'movie', tmdbId: 12345, signal: 'clicked' }),
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
  })

  it('accepts a valid clicked event for tv', async () => {
    const r = await appUnderTest().request('/event', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'tv', tmdbId: 99, signal: 'clicked' }),
    })
    expect(r.status).toBe(200)
  })
})

describe('POST /event — validation', () => {
  it('401s without a session', async () => {
    const r = await appUnderTest().request('/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'movie', tmdbId: 1, signal: 'clicked' }),
    })
    expect(r.status).toBe(401)
  })

  it('400s an unrecognized kind', async () => {
    const r = await appUnderTest().request('/event', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'audio', tmdbId: 1, signal: 'clicked' }),
    })
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error?: string }
    expect(body.error).toBe('invalid_kind')
  })

  it.each([
    { label: 'NaN', tmdbId: Number.NaN },
    { label: 'Infinity', tmdbId: Infinity },
    { label: 'decimal', tmdbId: 1.5 },
    { label: 'zero', tmdbId: 0 },
    { label: 'negative', tmdbId: -42 },
    { label: 'string', tmdbId: '123' },
  ])('400s on tmdbId=$label', async ({ tmdbId }) => {
    const r = await appUnderTest().request('/event', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'movie', tmdbId, signal: 'clicked' }),
    })
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error?: string }
    expect(body.error).toBe('invalid_tmdbId')
  })

  it('400s any signal other than clicked (locks the surface so this route cannot bypass /api/feedback guards)', async () => {
    const r = await appUnderTest().request('/event', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'movie', tmdbId: 1, signal: 'like' }),
    })
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error?: string }
    expect(body.error).toBe('invalid_signal')
  })

  it('400s a non-JSON body', async () => {
    const r = await appUnderTest().request('/event', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(r.status).toBe(400)
  })
})
