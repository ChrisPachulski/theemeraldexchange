// Locks in the ON-branch of the env.useLocalRecommender gate at
// /api/recommender/event. The default-off branch is covered in
// recommenderEvents.test.ts; this file uses vi.doMock to flip the
// env into local-recommender mode and asserts the mirror DOES fire,
// without disturbing the rest of the suite.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import type { Hono } from 'hono'
import type { Env } from '../middleware/auth.js'

let app: Hono<Env>
let createSessionFn: typeof import('../session.js').createSession

beforeAll(async () => {
  vi.resetModules()
  // Minimal env stand-in mirroring env.ts. Only useLocalRecommender +
  // recommenderUrl matter for this route; everything else is just so
  // the env import doesn't throw at module evaluation time.
  vi.doMock('../env.js', () => ({
    env: {
      plexClientId: 'test-client',
      sessionSecret:
        process.env.SESSION_SECRET ?? 'test-secret-test-secret-test-secret-test-secret',
      admins: [],
      plexServerId: null,
      port: 3001,
      isProd: false,
      allowedOrigins: [],
      plexServerUrl: 'http://upstream-plex.test',
      sonarrUrl: 'http://upstream-sonarr.test',
      sonarrApiKey: 'k',
      radarrUrl: 'http://upstream-radarr.test',
      radarrApiKey: 'k',
      sabUrl: 'http://upstream-sab.test',
      sabApiKey: 'k',
      minFreeBytes: 100 * 1024 ** 3,
      maxMovieBytes: 10 * 1024 ** 3,
      maxMovieGb: 10,
      maxTvBytesPerEpisode: 5 * 1024 ** 3,
      maxTvGbPerEpisode: 5,
      defaultProfileName: 'choose me',
      rejectionsPath: './data/rejections.json',
      userFeedbackPath: './data/user-feedback.json',
      usageLogPath: './data/usage.jsonl',
      grabLogPath: './data/grabs.jsonl',
      tmdbApiKey: null,
      useLocalRecommender: true,
      recommenderUrl: 'http://recommender.test',
      optimizerMaxTokens: 1024,
      optimizerMaxDriftPct: 0.2,
    },
  }))
  const { Hono } = await import('hono')
  const { recommenderEvents } = await import('./recommenderEvents.js')
  const session = await import('../session.js')
  createSessionFn = session.createSession
  const a = new Hono<Env>()
  a.route('/', recommenderEvents)
  app = a
})

afterAll(() => {
  vi.doUnmock('../env.js')
  vi.resetModules()
})

async function userCookie() {
  const t = await createSessionFn({ sub: '42', username: 'guest', role: 'user' })
  return `eex.session=${t}`
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /event — USE_LOCAL_RECOMMENDER=1', () => {
  it('mirrors a clicked event to the sidecar /events/feedback', async () => {
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>
    const r = await app.request('/event', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'movie', tmdbId: 12345, signal: 'clicked' }),
    })
    expect(r.status).toBe(200)

    // The mirror is fire-and-forget — give the microtask queue a tick
    // so the void postFeedback call gets a chance to invoke fetch
    // before we inspect the spy.
    await new Promise((res) => setImmediate(res))

    const mirrorCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes('/events/feedback'),
    )
    expect(mirrorCalls.length).toBe(1)
    const [calledUrl, init] = mirrorCalls[0]
    expect(String(calledUrl)).toBe('http://recommender.test/events/feedback')
    expect((init as RequestInit).method).toBe('POST')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body).toEqual({
      sub: '42',
      kind: 'movie',
      tmdb_id: 12345,
      signal: 'clicked',
    })
  })

  it('still 400s a bad body without invoking the mirror — validation runs before the gate', async () => {
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>
    const r = await app.request('/event', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'movie', tmdbId: 1.5, signal: 'clicked' }),
    })
    expect(r.status).toBe(400)
    await new Promise((res) => setImmediate(res))
    const mirrorCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes('/events/feedback'),
    )
    expect(mirrorCalls).toEqual([])
  })
})
