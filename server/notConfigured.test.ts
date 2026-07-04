// Phase 0 (plan 006): optional integrations degrade to a typed 503, not a
// 500 or a boot failure. This proves the full wiring at the app layer —
// service helper throws NotConfiguredError → app.onError maps it to
// `{ error: '<service>_not_configured' }` — mirroring the long-standing
// tmdb_not_configured contract. Env is mocked with every integration
// UNSET (the fresh self-host posture).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { Hono } from 'hono'

let app: Hono

beforeAll(async () => {
  vi.resetModules()
  const GB = 1024 * 1024 * 1024
  vi.doMock('./env.js', () => ({
    env: {
      // Fresh self-host: no Plex, no *arr, no SAB configured.
      plexClientId: null,
      sonarrApiKey: null,
      radarrApiKey: null,
      sabApiKey: null,
      sessionSecret: process.env.SESSION_SECRET ?? 'test-secret',
      admins: [],
      // adminSubs short-circuits memberStatus to 'allowed' so the test
      // session clears the gate regardless of members-table state.
      adminSubs: ['plex:1'],
      appleClientId: null,
      googleClientIds: [],
      plexServerId: null,
      SERVER_DB_PATH: process.env.SERVER_DB_PATH ?? './data/server.db',
      port: 3001,
      isProd: true,
      allowedOrigins: ['https://app.example.test'],
      plexServerUrl: 'http://upstream-plex.test',
      sonarrUrl: 'http://upstream-sonarr.test',
      radarrUrl: 'http://upstream-radarr.test',
      sabUrl: 'http://upstream-sab.test',
      minFreeBytes: 100 * GB,
      maxMovieBytes: 10 * GB,
      maxMovieGb: 10,
      maxTvBytesPerEpisode: 5 * GB,
      maxTvGbPerEpisode: 5,
      rejectionsPath: './data/rejections.json',
      userFeedbackPath: './data/user-feedback.json',
      userWatchlistPath: './data/user-watchlist.json',
      userPoliciesPath: './data/user-policies.json',
      usageLogPath: './data/usage.jsonl',
      grabLogPath: './data/grabs.jsonl',
      tmdbApiKey: null,
      useLocalRecommender: false,
      recommenderUrl: 'http://recommender:8000',
    },
    isPlexConfigured: () => false,
    isAppleConfigured: () => false,
    isGoogleConfigured: () => false,
  }))
  const mod = await import('./app.js')
  app = mod.app
})

afterAll(() => {
  vi.doUnmock('./env.js')
  vi.resetModules()
})

async function sessionCookie() {
  const { createSession } = await import('./session.js')
  const token = await createSession({ sub: 'plex:1', username: 'owner', role: 'admin' })
  return `eex.session=${token}`
}

describe('unconfigured integrations → typed 503 (never 500, never boot-fail)', () => {
  it('GET /api/sonarr/api/v3/series → 503 sonarr_not_configured', async () => {
    const r = await app.request('/api/sonarr/api/v3/series', {
      headers: { Cookie: await sessionCookie() },
    })
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'sonarr_not_configured' })
  })

  it('GET /api/radarr/api/v3/movie → 503 radarr_not_configured', async () => {
    const r = await app.request('/api/radarr/api/v3/movie', {
      headers: { Cookie: await sessionCookie() },
    })
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'radarr_not_configured' })
  })

  it('GET /api/sab/api?mode=queue → 503 sab_not_configured', async () => {
    const r = await app.request('/api/sab/api?mode=queue', {
      headers: { Cookie: await sessionCookie() },
    })
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'sab_not_configured' })
  })

  it('GET /api/auth/plex/config → 503 plex_not_configured (public route)', async () => {
    const r = await app.request('/api/auth/plex/config')
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'plex_not_configured' })
  })
})
