// Direct unit coverage for the Plex.tv API client (server/plex.ts). These
// tests pin the surfaces that the route-level tests (routes/users.test.ts,
// auth.test.ts) only exercise indirectly: the regex XML parsers, the
// pending-invite JSON normalization fallbacks, the 404 → [] best-effort
// behavior, probeResources' three result kinds, and buildAuthUrl.
//
// Mock style mirrors routes/users.test.ts: stubGlobal('fetch', vi.fn(...))
// matching requested URLs against a needle map. NodeNext ESM imports use
// the `.js` extension. The global vitest env supplies PLEX_CLIENT_ID, so
// env.plexClientId is already populated at import time.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createPin,
  checkPin,
  getUser,
  listResources,
  probeResources,
  signOut,
  listAcceptedUsers,
  listPendingInvites,
  listSharedServerInvitees,
  listLocalServerAccounts,
  listHomeUsers,
  buildAuthUrl,
} from './plex.js'
import { env } from './env.js'

type Stub = { status: number; body: string; contentType?: string }
const responses = new Map<string, Stub>()
const errorsByNeedle = new Map<string, Error>()

// The mock fn, captured so individual tests can inspect call args
// (requested URL, method, and headers).
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  responses.clear()
  errorsByNeedle.clear()
  fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    for (const [needle, err] of errorsByNeedle) {
      if (url.includes(needle)) throw err
    }
    for (const [needle, stub] of responses) {
      if (url.includes(needle)) {
        return new Response(stub.body, {
          status: stub.status,
          headers: { 'Content-Type': stub.contentType ?? 'application/json' },
        })
      }
    }
    return new Response('not stubbed: ' + url, { status: 599 })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

function stubJson(needle: string, body: unknown, status = 200) {
  responses.set(needle, {
    status,
    body: JSON.stringify(body),
    contentType: 'application/json',
  })
}
function stubText(needle: string, body: string, status: number) {
  responses.set(needle, { status, body, contentType: 'text/plain' })
}
function stubXml(needle: string, body: string, status = 200) {
  responses.set(needle, { status, body, contentType: 'application/xml' })
}

// Pull the request URL + init off a given fetch call.
function callAt(i: number): { url: string; init: RequestInit | undefined } {
  const args = fetchMock.mock.calls[i] as [string | URL | Request, RequestInit?]
  const input = args[0]
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
  return { url, init: args[1] }
}
function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const h = init?.headers as Record<string, string> | undefined
  return h?.[name]
}

const TOKEN = 'plex-token-abc'

describe('createPin', () => {
  it('returns the pin JSON and POSTs to /pins?strong=true', async () => {
    stubJson('/pins?strong=true', { id: 123, code: 'ABCD', authToken: null })
    const pin = await createPin()
    expect(pin).toEqual({ id: 123, code: 'ABCD', authToken: null })
    const { url, init } = callAt(0)
    expect(url).toContain('/pins?strong=true')
    expect(init?.method).toBe('POST')
  })

  it('throws on a non-ok status', async () => {
    stubText('/pins?strong=true', 'nope', 400)
    await expect(createPin()).rejects.toThrow('plex.createPin failed: 400')
  })
})

describe('checkPin', () => {
  it('returns the pin JSON and GETs /pins/{id}', async () => {
    stubJson('/pins/5', { id: 5, code: 'X', authToken: 'tok' })
    const pin = await checkPin(5)
    expect(pin).toEqual({ id: 5, code: 'X', authToken: 'tok' })
    expect(callAt(0).url).toContain('/pins/5')
  })

  it('throws on a non-ok status', async () => {
    stubText('/pins/5', 'boom', 500)
    await expect(checkPin(5)).rejects.toThrow('plex.checkPin failed: 500')
  })
})

describe('getUser', () => {
  it('returns the user JSON and sends X-Plex-Token', async () => {
    const user = {
      id: 1,
      uuid: 'u',
      username: 'me',
      email: 'me@x.com',
      thumb: null,
    }
    stubJson('/user', user)
    const got = await getUser(TOKEN)
    expect(got).toEqual(user)
    expect(headerOf(callAt(0).init, 'X-Plex-Token')).toBe(TOKEN)
  })

  it('throws on 401', async () => {
    stubText('/user', 'denied', 401)
    await expect(getUser(TOKEN)).rejects.toThrow('plex.getUser failed: 401')
  })
})

describe('listResources', () => {
  it('returns the resource array and hits /resources?includeHttps=1', async () => {
    const resources = [
      {
        name: 'home',
        clientIdentifier: 'cid',
        owned: true,
        home: false,
        provides: 'server',
      },
    ]
    stubJson('/resources?includeHttps=1', resources)
    const got = await listResources(TOKEN)
    expect(got).toEqual(resources)
    expect(callAt(0).url).toContain('/resources?includeHttps=1')
  })

  it('throws on 503', async () => {
    stubText('/resources?includeHttps=1', 'down', 503)
    await expect(listResources(TOKEN)).rejects.toThrow(
      'plex.listResources failed: 503',
    )
  })
})

describe('probeResources', () => {
  it('returns kind=ok on 200', async () => {
    const resources = [
      {
        name: 'home',
        clientIdentifier: 'cid',
        owned: false,
        home: false,
        provides: 'server',
      },
    ]
    stubJson('/resources?includeHttps=1', resources)
    const probe = await probeResources(TOKEN)
    expect(probe).toEqual({ kind: 'ok', resources })
  })

  it('returns kind=http_error with the status on a non-ok HTTP response', async () => {
    stubText('/resources?includeHttps=1', 'forbidden', 403)
    const probe = await probeResources(TOKEN)
    expect(probe).toEqual({ kind: 'http_error', status: 403 })
  })

  it('returns kind=network_error when fetch throws', async () => {
    errorsByNeedle.set('/resources?includeHttps=1', new Error('boom'))
    const probe = await probeResources(TOKEN)
    expect(probe).toEqual({ kind: 'network_error' })
  })
})

describe('signOut', () => {
  it('resolves and POSTs to /signout with X-Plex-Token', async () => {
    stubText('/signout', '', 200)
    await expect(signOut(TOKEN)).resolves.toBeUndefined()
    const { url, init } = callAt(0)
    expect(url).toContain('/signout')
    expect(init?.method).toBe('POST')
    expect(headerOf(init, 'X-Plex-Token')).toBe(TOKEN)
  })

  it('throws on 500', async () => {
    stubText('/signout', 'err', 500)
    await expect(signOut(TOKEN)).rejects.toThrow('plex.signOut failed: 500')
  })
})

describe('listAcceptedUsers', () => {
  it('parses self-closing <User/> elements, skips non-numeric ids, unescapes XML', async () => {
    stubXml(
      'plex.tv/api/users',
      `<MediaContainer>
        <User id="10" username="al &amp; ice" email="alice@x.com" thumb="t1" />
        <User id="11" username="bob" email="bob@x.com" thumb="t2" />
        <User id="abc" username="ghost" email="ghost@x.com" />
      </MediaContainer>`,
    )
    const users = await listAcceptedUsers(TOKEN)
    expect(users).toHaveLength(2)
    expect(users[0]).toMatchObject({
      id: 10,
      username: 'al & ice',
      email: 'alice@x.com',
      thumb: 't1',
      status: 'accepted',
    })
    expect(users[1]).toMatchObject({ id: 11, username: 'bob', email: 'bob@x.com' })
    expect(users.some((u) => u.username === 'ghost')).toBe(false)
  })

  it('throws on a non-ok status', async () => {
    stubText('plex.tv/api/users', 'err', 500)
    await expect(listAcceptedUsers(TOKEN)).rejects.toThrow(
      'plex.listAcceptedUsers failed: 500',
    )
  })
})

describe('listPendingInvites', () => {
  it('normalizes a raw array: numeric id, email-only fallback, and drops empties', async () => {
    stubJson('/friends/requested', [
      { id: 50, username: 'carol', email: 'carol@x.com' },
      { email: 'dave@x.com' }, // email-only → username/title fall back, id synthesized negative
      { thumb: 'orphan' }, // no title/username/email → filtered out
    ])
    const invites = await listPendingInvites(TOKEN)
    expect(invites).toHaveLength(2)

    const carol = invites.find((u) => u.username === 'carol')
    expect(carol).toMatchObject({ id: 50, status: 'pending', email: 'carol@x.com' })

    const dave = invites.find((u) => u.email === 'dave@x.com')
    expect(dave).toBeDefined()
    expect(dave?.username).toBe('dave@x.com')
    expect(dave?.title).toBe('dave@x.com')
    expect(dave?.id).toBeLessThan(0)
  })

  it('parses the wrapped { friends: [...] } form', async () => {
    stubJson('/friends/requested', {
      friends: [{ id: 60, username: 'erin', email: 'erin@x.com' }],
    })
    const invites = await listPendingInvites(TOKEN)
    expect(invites).toHaveLength(1)
    expect(invites[0]).toMatchObject({ id: 60, username: 'erin', status: 'pending' })
  })

  it('returns [] on 404 without throwing', async () => {
    stubText('/friends/requested', '', 404)
    await expect(listPendingInvites(TOKEN)).resolves.toEqual([])
  })

  it('throws on other non-ok statuses', async () => {
    stubText('/friends/requested', 'err', 500)
    await expect(listPendingInvites(TOKEN)).rejects.toThrow(
      'plex.listPendingInvites failed: 500',
    )
  })
})

describe('listSharedServerInvitees', () => {
  // env is `as const` at the type level (server/env.ts), but mutable at
  // runtime; cast through Record to flip the gated property, matching the
  // pattern proven in server/auth.test.ts. Restore the original after.
  const setServerId = (v: string | null) => {
    ;(env as Record<string, unknown>).plexServerId = v
  }
  const ORIGINAL_SERVER_ID = env.plexServerId
  afterEach(() => {
    setServerId(ORIGINAL_SERVER_ID)
  })

  it('returns [] and does NOT call fetch when plexServerId is falsy', async () => {
    setServerId(null)
    const result = await listSharedServerInvitees(TOKEN)
    expect(result).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('parses <SharedServer/> elements, maps accepted vs pending, identity uses userID', async () => {
    setServerId('home-server-machine-id')
    stubXml(
      'shared_servers',
      `<MediaContainer>
        <SharedServer userID="42" username="alice" email="a@x.com" accepted="1" />
        <SharedServer userID="43" username="bob" email="b@x.com" accepted="0" />
        <SharedServer username="ghost" email="ghost@x.com" />
      </MediaContainer>`,
    )
    const invitees = await listSharedServerInvitees(TOKEN)
    expect(invitees).toHaveLength(2)
    expect(invitees[0]).toMatchObject({ id: 42, username: 'alice', status: 'accepted' })
    expect(invitees[1]).toMatchObject({ id: 43, username: 'bob', status: 'pending' })
    expect(invitees.some((u) => u.username === 'ghost')).toBe(false)
  })

  it('returns [] on 404 when plexServerId is set', async () => {
    setServerId('home-server-machine-id')
    stubText('shared_servers', '', 404)
    await expect(listSharedServerInvitees(TOKEN)).resolves.toEqual([])
  })
})

describe('listLocalServerAccounts', () => {
  it('parses <Account/> elements, skips id=0 and empty-name accounts', async () => {
    stubXml(
      '/accounts',
      `<MediaContainer>
        <Account id="0" name="Local" />
        <Account id="7" name="bob" thumb="t" />
        <Account id="9" name="" />
      </MediaContainer>`,
    )
    const accounts = await listLocalServerAccounts(TOKEN)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({
      id: 7,
      username: 'bob',
      status: 'accepted',
      email: null,
    })
    expect(callAt(0).url).toContain('/accounts')
  })

  it('returns [] on 404', async () => {
    stubText('/accounts', '', 404)
    await expect(listLocalServerAccounts(TOKEN)).resolves.toEqual([])
  })
})

describe('listHomeUsers', () => {
  it('parses <User/> elements as accepted and hits /api/home/users', async () => {
    stubXml(
      '/api/home/users',
      `<MediaContainer>
        <User id="20" username="kid1" email="" />
        <User id="21" username="kid2" email="" />
      </MediaContainer>`,
    )
    const users = await listHomeUsers(TOKEN)
    expect(users).toHaveLength(2)
    expect(users.every((u) => u.status === 'accepted')).toBe(true)
    expect(callAt(0).url).toContain('/api/home/users')
  })

  it('returns [] on 404', async () => {
    stubText('/api/home/users', '', 404)
    await expect(listHomeUsers(TOKEN)).resolves.toEqual([])
  })
})

describe('buildAuthUrl', () => {
  it('builds the plex.tv auth URL with clientID, code, and product context', () => {
    const url = buildAuthUrl('ABCD123')
    expect(url.startsWith('https://app.plex.tv/auth#')).toBe(true)
    expect(url).toContain(`clientID=${env.plexClientId}`)
    expect(url).toContain('code=ABCD123')
    expect(url).toContain(encodeURIComponent('context[device][product]'))
  })
})

