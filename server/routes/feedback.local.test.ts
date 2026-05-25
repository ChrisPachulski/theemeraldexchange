import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Hono } from 'hono'
import type { Env } from '../middleware/auth.js'

let app: Hono<Env>
let createSessionFn: typeof import('../session.js').createSession
let setUserFeedbackPath: typeof import('../services/userFeedback.js')._setUserFeedbackPathForTests
let setRejectionsPath: typeof import('../services/rejections.js')._setRejectionsPathForTests

let tmpRoot: string

beforeAll(async () => {
  vi.resetModules()
  vi.doMock('../env.js', () => ({
    env: {
      plexClientId: 'test-client',
      sessionSecret: process.env.SESSION_SECRET ?? 'test-secret-test-secret-test-secret-test-secret',
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
      rejectionsPath: './data/rejections.feedback-local.json',
      userFeedbackPath: './data/user-feedback.feedback-local.json',
      usageLogPath: './data/usage.feedback-local.jsonl',
      grabLogPath: './data/grabs.feedback-local.jsonl',
      tmdbApiKey: null,
      useLocalRecommender: true,
      recommenderUrl: 'http://recommender.test',
      optimizerMaxTokens: 1024,
      optimizerMaxDriftPct: 0.2,
    },
  }))

  const { Hono } = await import('hono')
  const { feedback } = await import('./feedback.js')
  const session = await import('../session.js')
  const userFeedback = await import('../services/userFeedback.js')
  const rejections = await import('../services/rejections.js')
  createSessionFn = session.createSession
  setUserFeedbackPath = userFeedback._setUserFeedbackPathForTests
  setRejectionsPath = rejections._setRejectionsPathForTests
  const a = new Hono<Env>()
  a.route('/', feedback)
  app = a
})

afterAll(() => {
  vi.doUnmock('../env.js')
  vi.resetModules()
})

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'feedback-local-'))
  setUserFeedbackPath(join(tmpRoot, 'feedback.json'))
  setRejectionsPath(join(tmpRoot, 'rejections.json'))
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

async function userCookie() {
  const t = await createSessionFn({ sub: '42', username: 'guest', role: 'user' })
  return `eex.session=${t}`
}

async function postFeedback(signal: 'like' | 'dislike') {
  return app.request('/', {
    method: 'POST',
    headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'movie', tmdbId: 12345, title: 'X', signal }),
  })
}

async function mirrorBodies(path: string) {
  await new Promise((res) => setImmediate(res))
  const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>
  return fetchSpy.mock.calls
    .filter(([url]) => String(url).includes(path))
    .map(([, init]) => JSON.parse((init as RequestInit).body as string))
}

describe('feedback route — USE_LOCAL_RECOMMENDER=1', () => {
  it('clears mirrored like when toggling like to dislike', async () => {
    expect((await postFeedback('like')).status).toBe(200)
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockClear()

    expect((await postFeedback('dislike')).status).toBe(200)

    expect(await mirrorBodies('/events/feedback/clear')).toContainEqual({
      sub: '42',
      kind: 'movie',
      tmdb_id: 12345,
      signal: 'like',
    })
    expect(await mirrorBodies('/events/feedback')).toContainEqual({
      sub: '42',
      kind: 'movie',
      tmdb_id: 12345,
      signal: 'dislike',
    })
  })

  it('clears mirrored dislike when toggling dislike to like', async () => {
    expect((await postFeedback('dislike')).status).toBe(200)
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockClear()

    expect((await postFeedback('like')).status).toBe(200)

    expect(await mirrorBodies('/events/feedback/clear')).toContainEqual({
      sub: '42',
      kind: 'movie',
      tmdb_id: 12345,
      signal: 'dislike',
    })
    expect(await mirrorBodies('/events/feedback')).toContainEqual({
      sub: '42',
      kind: 'movie',
      tmdb_id: 12345,
      signal: 'like',
    })
  })
})
