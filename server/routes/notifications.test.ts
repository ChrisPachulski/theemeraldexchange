// /api/notifications/discord — admin-only configuration of the
// "Emerald Exchange Discord" notification connector on BOTH Sonarr and
// Radarr. The route does a list → match by name → update-or-create
// dance on each upstream, so the fetch stub has to recognize:
//   GET  /api/v3/notification           → list
//   POST /api/v3/notification           → create
//   PUT  /api/v3/notification/:id       → update
//   DELETE /api/v3/notification/:id     → remove
//   POST /api/v3/notification/:id/test  → test
// The matcher just slices the URL by upstream host to know whether
// the call landed on Sonarr or Radarr.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { notifications } from './notifications.js'
import { createSession } from '../session.js'
import { env } from '../env.js'
import type { Env } from '../middleware/auth.js'

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', notifications)
  return app
}

async function adminCookie() {
  const t = await createSession({ sub: '1', username: 'admin-user', role: 'admin' })
  return `eex.session=${t}`
}
async function userCookie() {
  const t = await createSession({ sub: '2', username: 'guest', role: 'user' })
  return `eex.session=${t}`
}

type Match = (url: string, method: string) => boolean
type Handler = (url: string, init: RequestInit) => Response | Promise<Response>
const handlers: Array<{ match: Match; handler: Handler }> = []

beforeEach(() => {
  handlers.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      for (const { match, handler } of handlers) {
        if (match(url, method)) {
          return handler(url, init ?? {})
        }
      }
      return new Response('not stubbed: ' + method + ' ' + url, { status: 599 })
    }),
  )
})

afterEach(() => vi.unstubAllGlobals())

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function sonarrHost(): string {
  return new URL(env.sonarrUrl).host
}
function radarrHost(): string {
  return new URL(env.radarrUrl).host
}

const EMERALD = 'Emerald Exchange Discord'
const GOOD_WEBHOOK = 'https://discord.com/api/webhooks/123/abc'

describe('notifications — gates', () => {
  it('rejects unauthenticated GET with 401', async () => {
    const r = await appUnderTest().request('/discord')
    expect(r.status).toBe(401)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('rejects user role GET with 403 admin_only', async () => {
    const r = await appUnderTest().request('/discord', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ error: 'forbidden', reason: 'admin_only' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('rejects user role POST with 403', async () => {
    const r = await appUnderTest().request('/discord', {
      method: 'POST',
      headers: { Cookie: await userCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: GOOD_WEBHOOK }),
    })
    expect(r.status).toBe(403)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('rejects user role DELETE with 403', async () => {
    const r = await appUnderTest().request('/discord', {
      method: 'DELETE',
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(403)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('notifications GET /discord', () => {
  it('returns configured=true when both sides have an Emerald entry', async () => {
    handlers.push({
      match: (u, m) => u.includes(sonarrHost()) && m === 'GET' && u.endsWith('/api/v3/notification'),
      handler: () =>
        jsonResponse([
          { id: 7, name: EMERALD, implementation: 'Discord' },
          { id: 1, name: 'Some Other', implementation: 'Discord' },
        ]),
    })
    handlers.push({
      match: (u, m) => u.includes(radarrHost()) && m === 'GET' && u.endsWith('/api/v3/notification'),
      handler: () =>
        jsonResponse([{ id: 4, name: EMERALD, implementation: 'Discord' }]),
    })
    const r = await appUnderTest().request('/discord', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ sonarr: true, radarr: true, configured: true })
  })

  it('returns configured=false when neither side has Emerald entry', async () => {
    handlers.push({
      match: (_u, m) => m === 'GET',
      handler: () => jsonResponse([]),
    })
    const r = await appUnderTest().request('/discord', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ sonarr: false, radarr: false, configured: false })
  })

  it('list endpoint failure (500) → 502 sonarr_list_failed (no false-empty answer)', async () => {
    // The prior code returned configured:false on a list error, which
    // the POST handler then read as "no existing entries" and stacked
    // a duplicate webhook on every retry. Failures must surface as a
    // hard error so the SPA + mutation paths fail closed instead.
    handlers.push({
      match: (_u, m) => m === 'GET',
      handler: () => jsonResponse({ error: 'boom' }, 500),
    })
    const r = await appUnderTest().request('/discord', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(502)
    const body = (await r.json()) as { error: string; status: number }
    expect(body.error).toMatch(/_list_failed$/)
    expect(body.status).toBe(500)
  })

  it('POST refuses to mutate when the list endpoint is failing (no duplicate webhooks)', async () => {
    // Regression: previously, a 500 from listNotifications surfaced as
    // [] from the helper, which the POST handler interpreted as "no
    // existing connector" → POST a new one. On the next retry while
    // the upstream was still flapping, ANOTHER new one. The fix makes
    // POST refuse to write without a fresh list, so a transient
    // outage can't stack duplicates.
    handlers.push({
      match: (_u, m) => m === 'GET',
      handler: () => jsonResponse({ error: 'boom' }, 500),
    })
    let postAttempts = 0
    handlers.push({
      match: (_u, m) => m === 'POST',
      handler: () => {
        postAttempts++
        return jsonResponse({ id: 1 }, 201)
      },
    })
    const r = await appUnderTest().request('/discord', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webhookUrl: 'https://discord.com/api/webhooks/123/abc',
      }),
    })
    expect(r.status).toBe(502)
    const body = (await r.json()) as { error: string }
    expect(body.error).toMatch(/_list_failed$/)
    // CRITICAL: no notification POST issued at all — would otherwise
    // start the duplicate-on-retry stacking pattern.
    expect(postAttempts).toBe(0)
  })
})

describe('notifications POST /discord — validation', () => {
  it('400 webhookUrl_required when body is missing webhookUrl', async () => {
    const r = await appUnderTest().request('/discord', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'webhookUrl_required' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('400 webhookUrl_required when body is unparseable JSON', async () => {
    const r = await appUnderTest().request('/discord', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: '{not json',
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'webhookUrl_required' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('400 invalid_discord_webhook for a non-discord URL', async () => {
    const r = await appUnderTest().request('/discord', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: 'https://evil.example.com/api/webhooks/x/y' }),
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'invalid_discord_webhook' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('400 invalid_discord_webhook for whitespace-only string', async () => {
    const r = await appUnderTest().request('/discord', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: '   ' }),
    })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'webhookUrl_required' })
  })
})

describe('notifications POST /discord — create flow', () => {
  it('creates on both sides when nothing exists yet (no delete called)', async () => {
    let sonarrPosts = 0
    let radarrPosts = 0
    let deletes = 0
    handlers.push({
      match: (u, m) => m === 'GET' && u.endsWith('/api/v3/notification'),
      handler: () => jsonResponse([]),
    })
    handlers.push({
      match: (u, m) => m === 'DELETE' && u.includes('/api/v3/notification/'),
      handler: () => {
        deletes++
        return jsonResponse({}, 200)
      },
    })
    handlers.push({
      match: (u, m) => u.includes(sonarrHost()) && m === 'POST' && u.endsWith('/api/v3/notification'),
      handler: () => {
        sonarrPosts++
        return jsonResponse({ id: 50 }, 201)
      },
    })
    handlers.push({
      match: (u, m) => u.includes(radarrHost()) && m === 'POST' && u.endsWith('/api/v3/notification'),
      handler: () => {
        radarrPosts++
        return jsonResponse({ id: 51 }, 201)
      },
    })
    const r = await appUnderTest().request('/discord', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: GOOD_WEBHOOK }),
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, configured: true })
    expect(sonarrPosts).toBe(1)
    expect(radarrPosts).toBe(1)
    expect(deletes).toBe(0)
  })

  it('updates existing Emerald entries in place', async () => {
    const seen: string[] = []
    handlers.push({
      match: (u, m) => m === 'GET' && u.endsWith('/api/v3/notification'),
      handler: (u) => {
        const isSonarr = u.includes(sonarrHost())
        return jsonResponse([
          { id: isSonarr ? 100 : 200, name: EMERALD, implementation: 'Discord' },
        ])
      },
    })
    handlers.push({
      match: (u, m) => m === 'PUT' && u.includes('/api/v3/notification/'),
      handler: (u) => {
        seen.push('PUT ' + u.split('/api/v3/notification/')[1])
        return jsonResponse({}, 200)
      },
    })
    handlers.push({
      match: (u, m) => m === 'POST' && u.endsWith('/api/v3/notification'),
      handler: (u) => {
        seen.push('POST ' + (u.includes(sonarrHost()) ? 'sonarr' : 'radarr'))
        return jsonResponse({}, 201)
      },
    })
    const r = await appUnderTest().request('/discord', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: GOOD_WEBHOOK }),
    })
    expect(r.status).toBe(200)
    expect(seen).toContain('PUT 100')
    expect(seen).toContain('PUT 200')
    expect(seen).not.toContain('POST sonarr')
    expect(seen).not.toContain('POST radarr')
  })

  it('update of existing webhook fails → 502 abort, NO new connector POSTed', async () => {
    let createPosted = false
    handlers.push({
      match: (u, m) => m === 'GET' && u.endsWith('/api/v3/notification'),
      handler: (u) =>
        jsonResponse([
          { id: u.includes(sonarrHost()) ? 100 : 200, name: EMERALD, implementation: 'Discord' },
        ]),
    })
    handlers.push({
      match: (u, m) => m === 'PUT' && u.includes(sonarrHost()) && u.includes('/api/v3/notification/'),
      handler: () => new Response('sonarr-down', { status: 500 }),
    })
    handlers.push({
      match: (_u, m) => m === 'POST',
      handler: () => {
        createPosted = true
        return jsonResponse({ id: 999 }, 201)
      },
    })
    const r = await appUnderTest().request('/discord', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: GOOD_WEBHOOK }),
    })
    expect(r.status).toBe(502)
    const body = (await r.json()) as { error: string; status: number }
    expect(body.error).toBe('sonarr_update_failed')
    expect(body.status).toBe(500)
    expect(createPosted).toBe(false)
  })

  it('sonarr create returns 500 → 502 sonarr_create_failed with status', async () => {
    handlers.push({
      match: (u, m) => m === 'GET' && u.endsWith('/api/v3/notification'),
      handler: () => jsonResponse([]),
    })
    handlers.push({
      match: (u, m) => m === 'POST' && u.includes(sonarrHost()) && u.endsWith('/api/v3/notification'),
      handler: () => new Response('upstream boom', { status: 500 }),
    })
    const r = await appUnderTest().request('/discord', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: GOOD_WEBHOOK }),
    })
    expect(r.status).toBe(502)
    const body = (await r.json()) as { error: string; status: number; detail: string }
    expect(body.error).toBe('sonarr_create_failed')
    expect(body.status).toBe(500)
    expect(body.detail).toContain('upstream boom')
  })

  it('radarr create returns 502 → outer 502 radarr_create_failed (sonarr succeeded first)', async () => {
    handlers.push({
      match: (u, m) => m === 'GET' && u.endsWith('/api/v3/notification'),
      handler: () => jsonResponse([]),
    })
    handlers.push({
      match: (u, m) => m === 'POST' && u.includes(sonarrHost()) && u.endsWith('/api/v3/notification'),
      handler: () => jsonResponse({ id: 1 }, 201),
    })
    handlers.push({
      match: (u, m) => m === 'POST' && u.includes(radarrHost()) && u.endsWith('/api/v3/notification'),
      handler: () => new Response('radarr down', { status: 502 }),
    })
    const r = await appUnderTest().request('/discord', {
      method: 'POST',
      headers: { Cookie: await adminCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: GOOD_WEBHOOK }),
    })
    expect(r.status).toBe(502)
    const body = (await r.json()) as { error: string; status: number }
    expect(body.error).toBe('radarr_create_failed')
    expect(body.status).toBe(502)
  })
})

describe('notifications DELETE /discord', () => {
  it('removes both sides and reports removed count', async () => {
    handlers.push({
      match: (u, m) => m === 'GET' && u.endsWith('/api/v3/notification'),
      handler: (u) =>
        jsonResponse([
          { id: u.includes(sonarrHost()) ? 7 : 8, name: EMERALD, implementation: 'Discord' },
        ]),
    })
    let deletes = 0
    handlers.push({
      match: (u, m) => m === 'DELETE' && u.includes('/api/v3/notification/'),
      handler: () => {
        deletes++
        return jsonResponse({}, 200)
      },
    })
    const r = await appUnderTest().request('/discord', {
      method: 'DELETE',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, removed: 2 })
    expect(deletes).toBe(2)
  })

  it('no Emerald entry → removed: 0, no DELETE issued', async () => {
    handlers.push({
      match: (u, m) => m === 'GET' && u.endsWith('/api/v3/notification'),
      handler: () => jsonResponse([]),
    })
    handlers.push({
      match: (_u, m) => m === 'DELETE',
      handler: () => {
        throw new Error('should not be called')
      },
    })
    const r = await appUnderTest().request('/discord', {
      method: 'DELETE',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, removed: 0 })
  })

  it('DELETE upstream partial failure surfaces 502 with the failing app and the success count', async () => {
    // Previously this returned 200 {ok:true, removed:1} — the SPA said
    // "Removed. Sonarr + Radarr will stop pinging Discord." while
    // Radarr's connector was still active and the household kept
    // getting Radarr pings on the next grab. Both deletes are still
    // attempted (Sonarr's succeeds and removed:1 reflects that), but
    // the route now reports the failure honestly so the user knows to
    // retry or investigate.
    handlers.push({
      match: (u, m) => m === 'GET' && u.endsWith('/api/v3/notification'),
      handler: (u) =>
        jsonResponse([
          { id: u.includes(sonarrHost()) ? 7 : 8, name: EMERALD, implementation: 'Discord' },
        ]),
    })
    let sonarrDeleted = false
    handlers.push({
      match: (u, m) => m === 'DELETE' && u.includes(sonarrHost()),
      handler: () => {
        sonarrDeleted = true
        return jsonResponse({}, 200)
      },
    })
    handlers.push({
      match: (u, m) => m === 'DELETE' && u.includes(radarrHost()),
      handler: () => new Response('boom', { status: 500 }),
    })
    const r = await appUnderTest().request('/discord', {
      method: 'DELETE',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(502)
    const body = (await r.json()) as {
      error: string
      removed: number
      failures: Array<{ app: string; id: number; status: number }>
    }
    expect(body.error).toBe('partial_delete_failed')
    expect(body.removed).toBe(1)
    expect(body.failures).toEqual([{ app: 'radarr', id: 8, status: 500 }])
    // Sonarr is still attempted first — partial cleanup matters even
    // when the radarr leg fails.
    expect(sonarrDeleted).toBe(true)
  })

  it('DELETE upstream total failure surfaces 502 with both apps listed', async () => {
    handlers.push({
      match: (u, m) => m === 'GET' && u.endsWith('/api/v3/notification'),
      handler: (u) =>
        jsonResponse([
          { id: u.includes(sonarrHost()) ? 7 : 8, name: EMERALD, implementation: 'Discord' },
        ]),
    })
    handlers.push({
      match: (_u, m) => m === 'DELETE',
      handler: () => new Response('boom', { status: 500 }),
    })
    const r = await appUnderTest().request('/discord', {
      method: 'DELETE',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(502)
    const body = (await r.json()) as {
      removed: number
      failures: Array<{ app: string; id: number; status: number }>
    }
    expect(body.removed).toBe(0)
    expect(body.failures.map((f) => f.app).sort()).toEqual(['radarr', 'sonarr'])
  })
})

describe('notifications POST /discord/test', () => {
  it('rejects user role with 403', async () => {
    const r = await appUnderTest().request('/discord/test', {
      method: 'POST',
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(403)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('409 not_configured when there is no Emerald entry on sonarr', async () => {
    handlers.push({
      match: (u, m) => m === 'GET' && u.endsWith('/api/v3/notification'),
      handler: () => jsonResponse([]),
    })
    const r = await appUnderTest().request('/discord/test', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(409)
    expect(await r.json()).toEqual({ error: 'not_configured' })
  })

  it('200 ok when sonarr test endpoint succeeds', async () => {
    handlers.push({
      match: (u, m) => m === 'GET' && u.includes(sonarrHost()) && u.endsWith('/api/v3/notification'),
      handler: () => jsonResponse([{ id: 7, name: EMERALD, implementation: 'Discord' }]),
    })
    handlers.push({
      match: (u, m) => m === 'POST' && u.includes('/api/v3/notification/7/test'),
      handler: () => jsonResponse({}, 200),
    })
    const r = await appUnderTest().request('/discord/test', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
  })

  it('502 test_failed when sonarr test endpoint returns non-OK', async () => {
    handlers.push({
      match: (u, m) => m === 'GET' && u.includes(sonarrHost()) && u.endsWith('/api/v3/notification'),
      handler: () => jsonResponse([{ id: 7, name: EMERALD, implementation: 'Discord' }]),
    })
    handlers.push({
      match: (u, m) => m === 'POST' && u.includes('/api/v3/notification/7/test'),
      handler: () => new Response('webhook unreachable', { status: 400 }),
    })
    const r = await appUnderTest().request('/discord/test', {
      method: 'POST',
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(502)
    const body = (await r.json()) as { error: string; status: number; detail: string }
    expect(body.error).toBe('test_failed')
    expect(body.status).toBe(400)
    expect(body.detail).toContain('webhook unreachable')
  })
})
