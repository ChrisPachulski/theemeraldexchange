import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { settings } from './settings.js'
import { createMemberSession as createSession } from '../test/authFixture.js'
import { serverDb } from '../services/serverDb.js'
import { getUserApiKey, setUserApiKey } from '../services/userApiKeys.js'
import type { Env } from '../middleware/auth.js'

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', settings)
  return app
}

async function cookieFor(sub: string) {
  const t = await createSession({ sub, username: `user-${sub}`, role: 'user' })
  return `eex.session=${t}`
}

const KEY = 'sk-ant-api03-settings-route-key-ZZZZ'

beforeEach(() => {
  serverDb().raw.exec('DELETE FROM user_api_keys;')
})

describe('settings route — authz', () => {
  it('rejects unauthenticated GET/PUT/DELETE with 401', async () => {
    const app = appUnderTest()
    expect((await app.request('/anthropic-key')).status).toBe(401)
    expect(
      (
        await app.request('/anthropic-key', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: KEY }),
        })
      ).status,
    ).toBe(401)
    expect((await app.request('/anthropic-key', { method: 'DELETE' })).status).toBe(401)
  })
})

describe('settings route — anthropic key lifecycle', () => {
  it('GET reports set:false before any key is stored', async () => {
    const r = await appUnderTest().request('/anthropic-key', {
      headers: { Cookie: await cookieFor('plex:401') },
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ set: false })
  })

  it('PUT stores the key; GET reflects set + masked last4 and never the key', async () => {
    const app = appUnderTest()
    const cookie = await cookieFor('plex:401')
    const put = await app.request('/anthropic-key', {
      method: 'PUT',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ key: KEY }),
    })
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({ set: true, last4: 'ZZZZ' })

    const get = await app.request('/anthropic-key', { headers: { Cookie: cookie } })
    const body = await get.text()
    expect(JSON.parse(body)).toEqual({ set: true, last4: 'ZZZZ' })
    expect(body).not.toContain('sk-ant-')

    // Stored encrypted, retrievable server-side for the suggestions path.
    expect(getUserApiKey('plex:401')).toBe(KEY)
    const row = serverDb()
      .raw.prepare('SELECT ciphertext FROM user_api_keys WHERE sub = ?')
      .get('plex:401') as { ciphertext: string }
    expect(row.ciphertext).not.toContain('sk-ant-')
  })

  it('PUT trims whitespace around a pasted key', async () => {
    const cookie = await cookieFor('plex:401')
    const r = await appUnderTest().request('/anthropic-key', {
      method: 'PUT',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ key: `  ${KEY}\n` }),
    })
    expect(r.status).toBe(200)
    expect(getUserApiKey('plex:401')).toBe(KEY)
  })

  it('PUT rejects malformed keys with 400 and does not echo the value', async () => {
    const cookie = await cookieFor('plex:401')
    for (const bad of ['', 'not-a-key', 'sk-ant-', 'sk-ant-has space', 42, null]) {
      const r = await appUnderTest().request('/anthropic-key', {
        method: 'PUT',
        headers: { Cookie: cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ key: bad }),
      })
      expect(r.status).toBe(400)
      const text = await r.text()
      expect(text).toContain('invalid_key')
      // Never echo the submitted value. ('sk-ant-' itself is excluded —
      // the static hint legitimately names the expected prefix.)
      if (typeof bad === 'string' && bad.length > 0 && bad !== 'sk-ant-') {
        expect(text).not.toContain(bad)
      }
    }
    expect(getUserApiKey('plex:401')).toBeNull()
  })

  it('PUT rejects an oversized body with 413', async () => {
    const cookie = await cookieFor('plex:401')
    const r = await appUnderTest().request('/anthropic-key', {
      method: 'PUT',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'sk-ant-' + 'x'.repeat(64 * 1024) }),
    })
    expect(r.status).toBe(413)
  })

  it('DELETE clears the key', async () => {
    const app = appUnderTest()
    const cookie = await cookieFor('plex:401')
    setUserApiKey('plex:401', KEY)
    const del = await app.request('/anthropic-key', {
      method: 'DELETE',
      headers: { Cookie: cookie },
    })
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ set: false })
    expect(getUserApiKey('plex:401')).toBeNull()
  })

  it("rows are sub-scoped: user B never sees or clears user A's key", async () => {
    const app = appUnderTest()
    setUserApiKey('plex:401', KEY)
    const cookieB = await cookieFor('plex:402')

    const get = await app.request('/anthropic-key', { headers: { Cookie: cookieB } })
    expect(await get.json()).toEqual({ set: false })

    await app.request('/anthropic-key', { method: 'DELETE', headers: { Cookie: cookieB } })
    expect(getUserApiKey('plex:401')).toBe(KEY)
  })

  it('rejects a PUT or DELETE whose expected principal no longer matches the session', async () => {
    const app = appUnderTest()
    const cookie = await cookieFor('plex:402')
    setUserApiKey('plex:401', KEY)

    const put = await app.request('/anthropic-key', {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        'content-type': 'application/json',
        'x-eex-expected-sub': 'plex:401',
      },
      body: JSON.stringify({ key: 'sk-ant-api03-wrong-principal-NEW2' }),
    })
    const del = await app.request('/anthropic-key', {
      method: 'DELETE',
      headers: { Cookie: cookie, 'x-eex-expected-sub': 'plex:401' },
    })

    expect(put.status).toBe(409)
    expect(del.status).toBe(409)
    expect(await put.json()).toEqual({ error: 'principal_changed' })
    expect(await del.json()).toEqual({ error: 'principal_changed' })
    expect(getUserApiKey('plex:401')).toBe(KEY)
    expect(getUserApiKey('plex:402')).toBeNull()
  })
})
