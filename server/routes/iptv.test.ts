import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'
import { promises as fsp } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openIptvDb, type IptvDb } from '../services/iptvDb.js'
import { iptv, __test } from './iptv.js'
import { __setSsrfLookupForTests } from '../services/ssrfGuard.js'
import { signStreamToken } from '../services/iptvStreamToken.js'
import { _resetLiveRemuxIndexForTests } from '../services/iptvLiveRemuxMap.js'
import { _setUserPoliciesPathForTests } from '../services/userPolicies.js'
import { __resetRateLimitsForTests } from '../middleware/rateLimit.js'
import { env } from '../env.js'

const dbState = vi.hoisted(() => ({
  testDb: null as IptvDb | null,
}))

type TestAuthEnv = {
  Variables: {
    session: { sub: string; username: string; role: 'admin' | 'user' }
  }
}

const authState = vi.hoisted(() => ({
  session: { sub: 'plex:42', username: 'Test', role: 'admin' as 'admin' | 'user' },
}))

const membershipState = vi.hoisted(() => ({
  status: 'allowed' as 'allowed' | 'revoked' | 'not_member',
}))

// Sub claim the fake token decoder reports. Tests override it to exercise the
// strict namespaced-sub requirement (the M1 bare-numeric grace is removed).
const tokenState = vi.hoisted(() => ({
  sub: 'plex:42',
}))

vi.mock('../middleware/auth.js', async () => {
  const requireTestAuth: MiddlewareHandler<TestAuthEnv> = async (c, next) => {
    c.set('session', authState.session)
    await next()
  }
  return {
    requireAuth: requireTestAuth,
    requireAdmin: requireTestAuth,
  }
})

vi.mock('../services/membership.js', () => ({
  memberStatus: vi.fn(() => membershipState.status),
}))

vi.mock('../services/xtream.js', () => ({
  getAccountInfo: vi.fn(async () => ({
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    maxConnections: 4,
    status: 'Active',
  })),
  credsFromEnv: vi.fn(() => ({ host: 'https://panel.example.com', username: 'u', password: 'p' })),
}))

vi.mock('../services/iptvStreamToken.js', () => {
  const decodeFake = (t: string) => {
    const match = /^fake\.([^.]+)\.([^.]+)(?:\.([^.]+))?$/.exec(t)
    if (!match) throw new Error('invalid_signature')
    const now = Math.floor(Date.now() / 1000)
    return {
      exp: now + 60,
      iat: now,
      jti: match[3] ?? '01J0000000000000000000000X',
      k: match[1],
      nbf: now,
      rid: Buffer.from(match[2], 'base64url').toString('utf-8'),
      sub: tokenState.sub,
      v: 1,
    }
  }
  return {
    signStreamToken: vi.fn((_secret: string, opts: { kind: string; resourceId: string; jti?: string }) =>
      `fake.${opts.kind}.${Buffer.from(opts.resourceId, 'utf-8').toString('base64url')}${opts.jti ? `.${opts.jti}` : ''}`),
    verifyStreamToken: vi.fn((_secret: string, t: string) => decodeFake(t)),
  }
})

const concurrencyState = vi.hoisted(() => {
  const sessions: Array<{
    sessionId: string
    sub: string
    kind: 'live' | 'vod' | 'series' | 'catchup' | 'remux'
    resourceId: string
    title: string | null
    ip: string | null
    startedAt: number
    lastSeen: number
  }> = []
  const releasedByResource: Array<{ sub: string; kind: string; resourceId: string }> = []

  return {
    sessions,
    releasedByResource,
    tracker: {
      tryAcquire: ({ sub, sessionId, kind, resourceId, ip, title }: {
        sub: string
        sessionId: string
        kind: 'live' | 'vod' | 'series' | 'catchup' | 'remux'
        resourceId: string
        ip?: string | null
        title?: string | null
      }) => {
        const now = Date.now()
        sessions.push({
          sessionId,
          sub,
          kind,
          resourceId,
          title: title ?? null,
          ip: ip ?? null,
          startedAt: now,
          lastSeen: now,
        })
        return { ok: true, sessionId }
      },
      heartbeat: () => {},
      heartbeatByResource: () => true,
      release: (sessionId: string) => {
        const index = sessions.findIndex((session) => session.sessionId === sessionId)
        if (index !== -1) sessions.splice(index, 1)
      },
      releaseByResource: (sub: string, kind: string, resourceId: string) => {
        releasedByResource.push({ sub, kind, resourceId })
        return true
      },
      sweep: () => {},
      size: () => sessions.length,
      list: () => sessions,
    },
  }
})

vi.mock('../services/iptvConcurrency.js', () => ({
  streamConcurrency: vi.fn(() => concurrencyState.tracker),
}))

// S9: mock sourcePrecedence so grant endpoints resolve without probing real upstreams
vi.mock('../services/sourcePrecedence.js', () => ({
  resolveSourcePrecedence: vi.fn(async ({ kind, id }: { kind: string; id: string }) => ({
    resolved: { source: 'iptv', kind, id },
  })),
}))

// D3: mock tokenReplayCache so tests don't cross-contaminate via the singleton cache
vi.mock('../services/tokenReplayCache.js', () => ({
  checkReplay: vi.fn(() => ({ allowed: true })),
  startGcSweep: vi.fn(),
  stopGcSweep: vi.fn(),
  clearReplayCache: vi.fn(),
}))

// Remux live-delivery (AVPlayer) coverage scaffolding. The two remux routes
// (index.m3u8 + seg) call into ../services/iptvRemux.js (which would spawn
// ffmpeg) and read the manifest/segments off disk via node:fs. We replace both
// with in-memory fakes so the route handlers run without touching the real FS
// or spawning a transcoder. Shared mutable state lives in vi.hoisted so each
// test can flip session activity / manifest content.
const remuxState = vi.hoisted(() => ({
  // sessionId currently considered "active" by listRemuxSessions
  activeSessions: new Set<string>(),
  // virtual filesystem: path -> contents (manifest string, '' for segments)
  files: new Map<string, string>(),
  startCalls: [] as Array<{ streamId: string; sub: string; upstreamUrl: string }>,
  // streamIds iptvRemux currently remembers as dead-channel placeholders, so a
  // test can drive the dead-feed failover / channel_offline_upstream path.
  deadFeeds: new Set<string>(),
}))

vi.mock('../services/iptvRemux.js', () => ({
  startRemuxSession: vi.fn((opts: { streamId: string; sub: string; upstreamUrl: string }) => {
    remuxState.startCalls.push(opts)
    const sessionId = 'sess-1'
    remuxState.activeSessions.add(sessionId)
    return { sessionId, dir: '/tmp/remux/sess-1', manifestPath: '/tmp/remux/sess-1/index.m3u8' }
  }),
  listRemuxSessions: vi.fn(() => [...remuxState.activeSessions].map((sessionId) => ({ sessionId }))),
  stopRemuxSession: vi.fn((sessionId: string) => {
    remuxState.activeSessions.delete(sessionId)
  }),
  heartbeatRemuxSession: vi.fn(),
  channelNeedsReencode: vi.fn(() => false),
  channelIsDeadFeed: vi.fn((streamId: string) => remuxState.deadFeeds.has(streamId)),
  markChannelDeadFeed: vi.fn((streamId: string) => {
    remuxState.deadFeeds.add(streamId)
  }),
  DEAD_FEED_CLEAN_EOF_MS: 60_000,
}))

// node:fs is shared with better-sqlite3 migrations (which readFileSync the .sql
// files) and other consumers, so the mock MUST only divert the remux virtual
// paths (/tmp/remux/...) and delegate everything else to the real fs. Otherwise
// migration SQL reads come back empty and the test DB has no tables.
const isRemuxPath = (p: unknown) => String(p).startsWith('/tmp/remux/')
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const existsSync = vi.fn((p: string, ...rest: unknown[]) =>
    isRemuxPath(p) ? remuxState.files.has(String(p)) : (actual.existsSync as (...a: unknown[]) => boolean)(p, ...rest),
  )
  const readFileSync = vi.fn((p: string, ...rest: unknown[]) =>
    isRemuxPath(p) ? (remuxState.files.get(String(p)) ?? '') : (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest),
  )
  // createReadStream's return value is irrelevant for remux because streamBridge
  // is mocked; delegate non-remux reads to the real implementation.
  const createReadStream = vi.fn((p: string, ...rest: unknown[]) =>
    isRemuxPath(p) ? (({}) as unknown as import('node:fs').ReadStream) : (actual.createReadStream as (...a: unknown[]) => unknown)(p, ...rest),
  )
  return {
    ...actual,
    existsSync,
    readFileSync,
    createReadStream,
    default: {
      ...(actual as unknown as { default: typeof import('node:fs') }).default,
      existsSync,
      readFileSync,
      createReadStream,
    },
  }
})

// streamBridge wraps fs.createReadStream's return into a web stream; mocking it
// lets the seg route produce a deterministic body without node:stream interop.
vi.mock('../services/streamBridge.js', () => ({
  nodeReadableToWebStream: vi.fn(
    () =>
      new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(new Uint8Array([0x47, 0x40]))
          ctrl.close()
        },
      }),
  ),
}))

function fakeToken(kind: string, resourceId: string): string {
  return `fake.${kind}.${Buffer.from(resourceId, 'utf-8').toString('base64url')}`
}

beforeEach(() => {
  authState.session = { sub: 'plex:42', username: 'Test', role: 'admin' }
  membershipState.status = 'allowed'
  tokenState.sub = 'plex:42'
  concurrencyState.sessions.length = 0
  concurrencyState.releasedByResource.length = 0
  dbState.testDb?.raw.exec('DELETE FROM iptv_playlist_tokens;')
})

describe('GET /api/iptv/health', () => {
  it('returns account info shape', async () => {
    const app = new Hono().route('/api/iptv', iptv)
    const res = await app.request('/api/iptv/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      expiresAt: string | null
      maxConnections: number
      status: string
    }
    expect(body.maxConnections).toBe(4)
    expect(body.status).toBe('Active')
    expect(typeof body.expiresAt).toBe('string')
  })
})

describe('playlist token lifecycle', () => {
  const app = new Hono().route('/api/iptv', iptv)

  async function mintPlaylistToken() {
    const res = await app.request('/api/iptv/playlist/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: 'internal.local:3001',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'api.example.com',
      },
      body: JSON.stringify({ deviceName: '  Kitchen TV  ' }),
    })
    expect(res.status).toBe(200)
    return (await res.json()) as { jti: string; url: string; deviceName: string }
  }

  it('generates forwarded HTTPS playlist URLs and exposes owner revoke/list routes', async () => {
    const minted = await mintPlaylistToken()
    expect(minted.deviceName).toBe('Kitchen TV')
    expect(minted.url).toMatch(/^https:\/\/api\.example\.com\/api\/iptv\/playlist\.m3u\?t=/)

    const list = await app.request('/api/iptv/playlist/tokens')
    expect(list.status).toBe(200)
    const listBody = (await list.json()) as { tokens: Array<{ jti: string; revoked: boolean }> }
    expect(listBody.tokens).toEqual([expect.objectContaining({ jti: minted.jti, revoked: false })])

    const del = await app.request(`/api/iptv/playlist/tokens/${minted.jti}`, { method: 'DELETE' })
    expect(del.status).toBe(200)

    const playlist = await app.request(new URL(minted.url).pathname + new URL(minted.url).search)
    expect(playlist.status).toBe(401)
    expect((await playlist.json()) as { error: string }).toEqual({ error: 'token_revoked' })
  })

  it('rejects playlist tokens for revoked members and persists token revocation', async () => {
    const minted = await mintPlaylistToken()
    membershipState.status = 'revoked'

    const playlist = await app.request(new URL(minted.url).pathname + new URL(minted.url).search)
    expect(playlist.status).toBe(401)
    expect((await playlist.json()) as { error: string }).toEqual({ error: 'access_revoked' })

    const row = dbState.testDb!.stmts.getPlaylistToken.get(minted.jti) as { revoked_at: string | null }
    expect(row.revoked_at).not.toBeNull()
  })

  describe('publicBaseUrl host allowlisting', () => {
    const envRw = env as unknown as { allowedOrigins: string[] }
    const prevOrigins = envRw.allowedOrigins

    afterAll(() => {
      envRw.allowedOrigins = prevOrigins
    })

    async function mintWithForwardedHost(forwardedHost: string) {
      const res = await app.request('/api/iptv/playlist/token', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'internal.local:3001',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': forwardedHost,
        },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(200)
      return (await res.json()) as { url: string }
    }

    it('accepts a forwarded host that matches an allowed origin exactly', async () => {
      envRw.allowedOrigins = ['https://theemeraldexchange.example']
      const minted = await mintWithForwardedHost('theemeraldexchange.example')
      expect(minted.url).toMatch(/^https:\/\/theemeraldexchange\.example\/api\/iptv\/playlist\.m3u\?t=/)
    })

    it('accepts a forwarded host that is a subdomain of an allowed origin (api.<spa-domain>)', async () => {
      envRw.allowedOrigins = ['https://theemeraldexchange.example']
      const minted = await mintWithForwardedHost('api.theemeraldexchange.example')
      expect(minted.url).toMatch(/^https:\/\/api\.theemeraldexchange\.example\//)
    })

    it('falls back to the first allowed origin for a forwarded host outside the allowlist', async () => {
      envRw.allowedOrigins = ['https://theemeraldexchange.example']
      for (const evil of ['evil.example.com', 'eviltheemeraldexchange.example', 'theemeraldexchange.example.evil.com']) {
        const minted = await mintWithForwardedHost(evil)
        expect(minted.url).toMatch(/^https:\/\/theemeraldexchange\.example\//)
      }
    })

    it('passes the forwarded host through when no allowlist is configured (dev)', async () => {
      envRw.allowedOrigins = []
      const minted = await mintWithForwardedHost('api.example.com')
      expect(minted.url).toMatch(/^https:\/\/api\.example\.com\//)
    })
  })

  it('rejects the legacy M1 rid "all" (D2a fallback removed)', async () => {
    const res = await app.request(`/api/iptv/playlist.m3u?t=${fakeToken('playlist', 'all')}`)
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('invalid_token')
    expect(body.detail).toBe('resource_mismatch')
  })

  it('rejects a playlist token whose jti has no persisted row (jti-less M1 bypass removed)', async () => {
    // Valid HMAC + canonical rid, but the jti was never persisted at mint —
    // the revocation-table lookup is now unconditional, so this must 401
    // instead of bypassing the revocation check like pre-D12 tokens did.
    const res = await app.request(
      `/api/iptv/playlist.m3u?t=${fakeToken('playlist', 'iptv-channels-all')}`,
    )
    expect(res.status).toBe(401)
    expect((await res.json()) as { error: string }).toEqual({ error: 'token_not_found' })
  })

  it('rejects a stream token carrying a bare-numeric legacy sub (grace window closed)', async () => {
    tokenState.sub = '42'
    const res = await app.request('/api/iptv/stream/live/10.ts?t=' + fakeToken('live', '10'))
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('invalid_token')
    expect(body.detail).toBe('sub_invalid_format')
  })

  it('caps playlist token request bodies', async () => {
    const res = await app.request('/api/iptv/playlist/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '2048' },
      body: '{}',
    })
    expect(res.status).toBe(413)
  })
})

describe('DELETE /api/iptv/sessions/:sessionId', () => {
  const app = new Hono().route('/api/iptv', iptv)

  function seedSession(sessionId: string, sub: string) {
    concurrencyState.sessions.push({
      sessionId,
      sub,
      kind: 'live',
      resourceId: '10',
      title: 'CNN',
      ip: null,
      startedAt: 1,
      lastSeen: 1,
    })
  }

  it('allows an admin session to release another user session', async () => {
    seedSession('other-session', 'plex:other')

    const res = await app.request('/api/iptv/sessions/other-session', { method: 'DELETE' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, released: 'other-session' })
    expect(concurrencyState.sessions).toHaveLength(0)
  })

  it('forbids a non-admin session from releasing another user session', async () => {
    authState.session = { sub: 'plex:42', username: 'Test', role: 'user' }
    seedSession('other-session', 'plex:other')

    const res = await app.request('/api/iptv/sessions/other-session', { method: 'DELETE' })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
    expect(concurrencyState.sessions).toHaveLength(1)
  })

  it('allows a non-admin session to release its own session', async () => {
    authState.session = { sub: 'plex:42', username: 'Test', role: 'user' }
    seedSession('own-session', 'plex:42')

    const res = await app.request('/api/iptv/sessions/own-session', { method: 'DELETE' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, released: 'own-session' })
    expect(concurrencyState.sessions).toHaveLength(0)
  })
})

describe('guide preview intent + remux session teardown (finding 89)', () => {
  const app = new Hono().route('/api/iptv', iptv)
  const manifestPath = '/tmp/remux/sess-1/index.m3u8'
  // ≥ START_SEGMENTS (4) so the manifest poll's readiness gate is satisfied at
  // once and a live remux session is registered (see the remux delivery tests).
  const sampleManifest =
    '#EXTM3U\n#EXTINF:6,\nseg_00000.ts\n#EXTINF:6,\nseg_00001.ts\n' +
    '#EXTINF:6,\nseg_00002.ts\n#EXTINF:6,\nseg_00003.ts\n'

  beforeEach(() => {
    remuxState.activeSessions.clear()
    remuxState.files.clear()
    remuxState.startCalls.length = 0
    remuxState.deadFeeds.clear()
    _resetLiveRemuxIndexForTests()
  })

  // Bring channel 10 up as a live remux session for the current account: grant it,
  // then poll its manifest so ffmpeg (mock) + liveRemuxIndex both exist.
  async function watchChannel10() {
    await app.request('/api/iptv/stream/live/10/grant?client=avplayer', { method: 'POST' })
    remuxState.files.set(manifestPath, sampleManifest)
    const res = await app.request(
      `/api/iptv/stream/live/10/remux/index.m3u8?t=${fakeToken('remux', '10')}`,
    )
    expect(res.status).toBe(200)
    expect(remuxState.activeSessions.has('sess-1')).toBe(true)
  }

  it('a preview-intent grant does NOT evict the account\'s active watch session', async () => {
    await watchChannel10()
    // Same account focuses channel 20 in the guide → PREVIEW grant. It must NOT
    // run the one-tuner teardown, so channel 10's live session survives.
    const preview = await app.request(
      '/api/iptv/stream/live/20/grant?client=avplayer&intent=preview',
      { method: 'POST' },
    )
    expect(preview.status).toBe(200)
    expect(remuxState.activeSessions.has('sess-1')).toBe(true)
  })

  it('a normal (non-preview) grant DOES evict the account\'s other live channel', async () => {
    await watchChannel10()
    // Contrast: without intent=preview, tuning a new channel tears the old down.
    await app.request('/api/iptv/stream/live/20/grant?client=avplayer', { method: 'POST' })
    expect(remuxState.activeSessions.has('sess-1')).toBe(false)
  })

  it('DELETE /sessions of a remux slot stops the underlying ffmpeg immediately', async () => {
    await watchChannel10()
    // The concurrency tracker holds the 'remux' slot minted at grant time
    // (resourceId = the streamId). Killing that slot via the sessions widget must
    // ALSO stop the remux ffmpeg so the provider connection releases now, not at
    // the 90s idle sweep. Red before the DELETE fix: release() frees only the
    // slot and leaves sess-1 active.
    concurrencyState.sessions.push({
      sessionId: 'grant-remux-10',
      sub: 'plex:42',
      kind: 'remux',
      resourceId: '10',
      title: 'CNN',
      ip: null,
      startedAt: 1,
      lastSeen: 1,
    })
    const res = await app.request('/api/iptv/sessions/grant-remux-10', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(remuxState.activeSessions.has('sess-1')).toBe(false)
  })
})

describe('live stream grant + proxy', () => {
  const app = new Hono().route('/api/iptv', iptv)

  it('issues a tokenized URL on POST /stream/live/:id/grant', async () => {
    const res = await app.request('/api/iptv/stream/live/10/grant', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { url: string; delivery: string }
    expect(body.url).toContain('/api/iptv/stream/live/10.ts?t=fake.live.MTA')
    expect(body.delivery).toBe('mpegts')
  })

  it('rejects bad tokens on the .ts endpoint', async () => {
    const res = await app.request('/api/iptv/stream/live/10.ts?t=bogus')
    expect(res.status).toBe(401)
  })

  // Regression: live grant tokens used the 300s finite-asset TTL. A live session
  // is unbounded and the player re-fetches the SAME tokenized manifest URL
  // forever — the handler re-checks exp each poll, so live cable froze at exactly
  // 5 minutes. Live tokens must outlast a sitting; finite kinds stay short.
  async function grantTtl(path: string, kind: string): Promise<number> {
    const mock = vi.mocked(signStreamToken)
    mock.mockClear()
    const res = await app.request(path, { method: 'POST' })
    expect(res.status).toBe(200)
    const call = mock.mock.calls.find(([, o]) => (o as { kind: string }).kind === kind)
    expect(call, `grant should mint a ${kind} token`).toBeDefined()
    return (call![1] as { ttlSecs: number }).ttlSecs
  }

  it('live remux (AVPlayer/HLS) grant token uses the long live TTL', async () => {
    expect(await grantTtl('/api/iptv/stream/live/10/grant?client=avplayer', 'remux')).toBe(
      env.IPTV_LIVE_TOKEN_TTL_SECS,
    )
    expect(env.IPTV_LIVE_TOKEN_TTL_SECS).toBeGreaterThan(env.IPTV_STREAM_TOKEN_TTL_SECS)
  })

  it('live .ts grant token uses the long live TTL', async () => {
    expect(await grantTtl('/api/iptv/stream/live/10/grant', 'live')).toBe(
      env.IPTV_LIVE_TOKEN_TTL_SECS,
    )
  })

  // Per-user policy section gate (requireSection('live')). A member whose
  // policy denies the `live` section gets 403 before any concurrency slot
  // is acquired; allowed members and admins reach the normal grant path.
  describe('live section policy', () => {
    let policyDir: string
    let policyPath: string
    beforeEach(async () => {
      policyDir = await fsp.mkdtemp(join(tmpdir(), 'iptv-policy-'))
      policyPath = join(policyDir, 'user-policies.json')
      _setUserPoliciesPathForTests(policyPath)
    })
    afterEach(async () => {
      _setUserPoliciesPathForTests(env.userPoliciesPath)
      await fsp.rm(policyDir, { recursive: true, force: true })
    })

    it('403 section_blocked for a non-admin whose policy denies live', async () => {
      authState.session = { sub: 'plex:99', username: 'Kid', role: 'user' }
      await fsp.writeFile(
        policyPath,
        JSON.stringify({
          'plex:99': {
            maxContentRating: null,
            allowedSections: { live: false, downloads: true, arr: true },
            kid: true,
          },
        }),
      )
      _setUserPoliciesPathForTests(policyPath)
      const res = await app.request('/api/iptv/stream/live/10/grant', { method: 'POST' })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'section_blocked' })
    })

    it('allows a non-admin whose policy permits live', async () => {
      authState.session = { sub: 'plex:99', username: 'Teen', role: 'user' }
      await fsp.writeFile(
        policyPath,
        JSON.stringify({
          'plex:99': {
            maxContentRating: null,
            allowedSections: { live: true, downloads: false, arr: false },
            kid: false,
          },
        }),
      )
      _setUserPoliciesPathForTests(policyPath)
      const res = await app.request('/api/iptv/stream/live/10/grant', { method: 'POST' })
      expect(res.status).toBe(200)
    })

    it('admin is never blocked even under a live:false policy', async () => {
      authState.session = { sub: 'plex:42', username: 'Test', role: 'admin' }
      await fsp.writeFile(
        policyPath,
        JSON.stringify({
          'plex:42': {
            maxContentRating: null,
            allowedSections: { live: false, downloads: false, arr: false },
            kid: false,
          },
        }),
      )
      _setUserPoliciesPathForTests(policyPath)
      const res = await app.request('/api/iptv/stream/live/10/grant', { method: 'POST' })
      expect(res.status).toBe(200)
    })
  })
})

describe('catchup stream grant + proxy', () => {
  const app = new Hono().route('/api/iptv', iptv)

  it('issues a tokenized catchup URL for an archived channel', async () => {
    const startUtc = new Date(Date.now() - 60 * 60_000).toISOString()
    const res = await app.request(
      `/api/iptv/stream/catchup/10/grant?startUtc=${encodeURIComponent(startUtc)}&durationMin=30`,
      { method: 'POST' },
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { url: string; delivery: string }
    expect(body.delivery).toBe('mpegts')
    expect(body.url).toContain(`/api/iptv/stream/catchup/10/${encodeURIComponent(startUtc)}/30.ts?t=`)
    expect(body.url).toContain(fakeToken('catchup', `10|${startUtc}|30`))
  })

  it('proxies catchup through the Xtream timeshift endpoint', async () => {
    const startUtc = '2026-05-24T12:00:00Z'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('ts', { status: 200 }))

    const res = await app.request(
      `/api/iptv/stream/catchup/10/${encodeURIComponent(startUtc)}/30.ts?t=${fakeToken('catchup', `10|${startUtc}|30`)}`,
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp2t')
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://panel.example.com/streaming/timeshift.php?username=u&password=p&stream=10&start=2026-05-24:12-00&duration=30',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    fetchSpy.mockRestore()
  })

  // Catchup is time-shifted live content and shares the `live` section gate:
  // a member whose policy denies Live TV must not get a catchup token either,
  // even when no rating cap is set (capBlocksUnrated is a no-op when
  // maxContentRating is null, so the section gate is the only thing that stops
  // them). Mirrors the live-grant section-policy tests above.
  describe('catchup section policy', () => {
    let catchupPolicyDir: string
    let catchupPolicyPath: string
    beforeEach(async () => {
      catchupPolicyDir = await fsp.mkdtemp(join(tmpdir(), 'iptv-catchup-policy-'))
      catchupPolicyPath = join(catchupPolicyDir, 'user-policies.json')
      _setUserPoliciesPathForTests(catchupPolicyPath)
    })
    afterEach(async () => {
      _setUserPoliciesPathForTests(env.userPoliciesPath)
      authState.session = { sub: 'plex:42', username: 'Test', role: 'admin' }
      await fsp.rm(catchupPolicyDir, { recursive: true, force: true })
    })

    const grantUrl = () => {
      const startUtc = new Date(Date.now() - 60 * 60_000).toISOString()
      return `/api/iptv/stream/catchup/10/grant?startUtc=${encodeURIComponent(startUtc)}&durationMin=30`
    }

    it('403 section_blocked for a non-admin whose policy denies live (no rating cap)', async () => {
      authState.session = { sub: 'plex:99', username: 'Kid', role: 'user' }
      await fsp.writeFile(
        catchupPolicyPath,
        JSON.stringify({
          'plex:99': {
            maxContentRating: null,
            allowedSections: { live: false, downloads: true, arr: true },
            kid: true,
          },
        }),
      )
      _setUserPoliciesPathForTests(catchupPolicyPath)
      const res = await app.request(grantUrl(), { method: 'POST' })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'section_blocked' })
    })

    it('allows a non-admin whose policy permits live', async () => {
      authState.session = { sub: 'plex:99', username: 'Teen', role: 'user' }
      await fsp.writeFile(
        catchupPolicyPath,
        JSON.stringify({
          'plex:99': {
            maxContentRating: null,
            allowedSections: { live: true, downloads: false, arr: false },
            kid: false,
          },
        }),
      )
      _setUserPoliciesPathForTests(catchupPolicyPath)
      const res = await app.request(grantUrl(), { method: 'POST' })
      expect(res.status).toBe(200)
    })
  })
})

vi.mock('../services/iptvSync.js', () => ({
  syncOnce: vi.fn(async () => ({
    busy: false, channels: 10, vod: 20, series: 5, episodes: 50, epg: 100, categories: 6,
    startedAt: '2026-05-24T00:00:00Z', finishedAt: '2026-05-24T00:00:30Z', durationMs: 30000,
  })),
}))
vi.mock('../services/iptvDbSingleton.js', () => ({
  iptvDb: () => {
    if (!dbState.testDb) throw new Error('test iptv db not initialized')
    return dbState.testDb
  },
  closeIptvDb: () => {
    dbState.testDb?.close()
    dbState.testDb = null
  },
}))

vi.mock('../services/iptvCatalog.js', () => ({
  listCategories: vi.fn(() => [{ category_id: 1, name: 'News', parent_id: 0 }]),
  listLive: vi.fn(() => ({ items: [{ stream_id: 10, num: 1, name: 'CNN' }], total: 1, limit: 50, offset: 0 })),
  listVod: vi.fn(() => ({ items: [{ stream_id: 20, name: 'Matrix' }], total: 1, limit: 50, offset: 0 })),
  listSeries: vi.fn(() => ({ items: [{ series_id: 30, name: 'GoT' }], total: 1, limit: 50, offset: 0 })),
  getVodDetail: vi.fn(() => ({ stream_id: 20, name: 'Matrix', container_extension: 'mp4' })),
  getSeriesDetail: vi.fn(() => ({ series_id: 30, name: 'GoT', seasons: [{ season: 1, episodes: [] }] })),
}))

beforeAll(() => {
  // Deterministic SSRF resolver: every name resolves to a public IP unless a
  // specific test overrides it. Keeps guardedFetch's resolve-and-validate step
  // off real, flaky, network-bound DNS (findings 8-0/16-0/3-1).
  __setSsrfLookupForTests(async () => [{ address: '203.0.113.7' }])
  dbState.testDb = openIptvDb(':memory:')
  dbState.testDb.stmts.upsertChannel.run({
    stream_id: 10,
    num: 1,
    name: 'CNN',
    stream_icon: null,
    epg_channel_id: 'cnn.us',
    category_id: 1,
    is_adult: 0,
    tv_archive: 1,
    tv_archive_duration: 7,
    added_ts: null,
    fetched_at: '2026-05-24T00:00:00Z',
  })
  dbState.testDb.stmts.upsertVod.run({
    stream_id: 20,
    name: 'Matrix',
    stream_icon: null,
    rating: 8.7,
    category_id: null,
    container_extension: 'mp4',
    added_ts: null,
    tmdb_id: 603,
    year: 1999,
    plot: 'Neo',
    director: 'Lana Wachowski, Lilly Wachowski',
    cast_csv: 'Keanu Reeves, Carrie-Anne Moss',
    fetched_at: '2026-05-24T00:00:00Z',
  })
  dbState.testDb.stmts.upsertSeries.run({
    series_id: 30,
    name: 'GoT',
    cover: null,
    plot: null,
    rating: null,
    category_id: null,
    tmdb_id: null,
    last_modified: null,
    fetched_at: '2026-05-24T00:00:00Z',
  })
  dbState.testDb.stmts.upsertEpisode.run({
    episode_id: 'ep-1',
    series_id: 30,
    season: 1,
    episode_num: 1,
    title: 'Pilot',
    container_extension: 'mkv',
    added_ts: null,
    plot: null,
    duration_secs: null,
  })
})

afterAll(() => {
  __setSsrfLookupForTests(null)
  dbState.testDb?.close()
  dbState.testDb = null
})

describe('vod stream grant + proxy', () => {
  const app = new Hono().route('/api/iptv', iptv)

  it('issues a tokenized URL with detected ext', async () => {
    const res = await app.request('/api/iptv/stream/vod/20/grant', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string; delivery: string; mime: string }
    expect(body.url).toContain('/api/iptv/stream/vod/20/mp4?t=fake.vod.MjA')
    expect(body.delivery).toBe('progressive')
    expect(body.mime).toBe('video/mp4')
  })

  it('proxies Range requests upstream', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('abc', {
      status: 206,
      headers: {
        'content-length': '3',
        'content-range': 'bytes 0-2/10',
        'accept-ranges': 'bytes',
      },
    }))

    const res = await app.request('/api/iptv/stream/vod/20/mp4?t=fake.vod.MjA', {
      headers: { Range: 'bytes=0-2' },
    })

    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-2/10')
    expect(fetchSpy).toHaveBeenCalledWith('https://panel.example.com/movie/u/p/20.mp4', expect.objectContaining({
      headers: { Range: 'bytes=0-2' },
      redirect: 'manual',
    }))
    fetchSpy.mockRestore()
  })

  it('releases the concurrency slot when the client aborts a progressive VOD stream', async () => {
    // Upstream hangs forever (only the abort signal settles it) — the route is
    // mid-proxy when the client disconnects. The slot must be released
    // immediately, exactly like the live/catchup byte paths, instead of
    // waiting for the 30s idle sweep.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const s = init?.signal
          if (!s) return
          if (s.aborted) return reject(s.reason)
          s.addEventListener('abort', () => reject(s.reason), { once: true })
        }),
    )
    try {
      const ac = new AbortController()
      // app.request() is typed Response | Promise<Response>; normalize to a
      // promise before .catch (the aborted request itself may reject).
      const pending = Promise.resolve(
        app.request('/api/iptv/stream/vod/20/mp4?t=fake.vod.MjA', { signal: ac.signal }),
      ).catch(() => undefined)
      await new Promise((r) => setTimeout(r, 20))
      ac.abort()
      await pending
      expect(concurrencyState.releasedByResource).toContainEqual({
        sub: 'plex:42',
        kind: 'vod',
        resourceId: '20',
      })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('releases the concurrency slot when the client aborts a progressive series stream', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const s = init?.signal
          if (!s) return
          if (s.aborted) return reject(s.reason)
          s.addEventListener('abort', () => reject(s.reason), { once: true })
        }),
    )
    try {
      const ac = new AbortController()
      const pending = Promise.resolve(
        app.request(`/api/iptv/stream/series/ep-1/mkv?t=${fakeToken('series', 'ep-1')}`, {
          signal: ac.signal,
        }),
      ).catch(() => undefined)
      await new Promise((r) => setTimeout(r, 20))
      ac.abort()
      await pending
      expect(concurrencyState.releasedByResource).toContainEqual({
        sub: 'plex:42',
        kind: 'series',
        resourceId: 'ep-1',
      })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  // MED/LOW-24: the series byte route interpolates `ext` raw into the upstream
  // provider URL, so a `%3F`-decoded query string in ext must be rejected before
  // any upstream fetch fires — the same guard the VOD byte route already applies.
  it('rejects an injected query string in the series byte ext (invalid_id, no upstream fetch)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const res = await app.request(
      `/api/iptv/stream/series/ep-1/mp4%3Fdel%3D1?t=${fakeToken('series', 'ep-1')}`,
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_id')
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('rewrites HLS playlists to signed segment proxy URLs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response([
      '#EXTM3U',
      '#EXTINF:6.0,',
      'seg-001.ts',
    ].join('\n'), {
      status: 200,
      headers: { 'content-type': 'application/vnd.apple.mpegurl' },
    }))

    const res = await app.request(`/api/iptv/stream/vod/20/m3u8?t=${fakeToken('vod', '20')}`)
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://panel.example.com/movie/u/p/20.m3u8',
      expect.objectContaining({ redirect: 'manual' }),
    )
    expect(text).toContain(`/api/iptv/stream/segment?u=${encodeURIComponent(fakeToken('segment', 'https://panel.example.com/movie/u/p/seg-001.ts'))}`)
    fetchSpy.mockRestore()
  })
})

// Regression (S0-3): VOD / series / catch-up grant tokens — AND the HLS
// segment tokens minted from their manifests — used the 300s finite-asset TTL.
// On-demand playback re-presents the token on every range GET / seek / HLS
// segment fetch across the whole runtime, and the byte/segment handlers
// re-check `exp` each time, so any movie or episode past ~5 minutes 401'd and
// stalled/ejected mid-play (identical failure class to the already-fixed
// live-cable-froze-at-5min bug). On-demand tokens must outlast a sitting — the
// playback-duration TTL local media uses — while live remux segments stay short.
describe('on-demand grant token TTL (S0-3 regression)', () => {
  const app = new Hono().route('/api/iptv', iptv)

  // Read the ttlSecs the grant passed to the (mocked) signStreamToken for the
  // given kind — same technique as the live-TTL regression test above.
  async function grantTtl(path: string, kind: string): Promise<number> {
    const mock = vi.mocked(signStreamToken)
    mock.mockClear()
    const res = await app.request(path, { method: 'POST' })
    expect(res.status).toBe(200)
    const call = mock.mock.calls.find(([, o]) => (o as { kind: string }).kind === kind)
    expect(call, `grant should mint a ${kind} token`).toBeDefined()
    return (call![1] as { ttlSecs: number }).ttlSecs
  }

  it('VOD grant token uses the long on-demand TTL, not the 300s finite-asset TTL', async () => {
    const ttl = await grantTtl('/api/iptv/stream/vod/20/grant', 'vod')
    expect(ttl).toBe(env.IPTV_ONDEMAND_TOKEN_TTL_SECS)
    // The bug: this equalled IPTV_STREAM_TOKEN_TTL_SECS (300) → froze at 5min.
    expect(ttl).toBeGreaterThan(env.IPTV_STREAM_TOKEN_TTL_SECS)
  })

  it('series grant token uses the long on-demand TTL', async () => {
    const ttl = await grantTtl('/api/iptv/stream/series/ep-1/grant', 'series')
    expect(ttl).toBe(env.IPTV_ONDEMAND_TOKEN_TTL_SECS)
    expect(ttl).toBeGreaterThan(env.IPTV_STREAM_TOKEN_TTL_SECS)
  })

  it('catch-up grant token uses the long on-demand TTL', async () => {
    const startUtc = new Date(Date.now() - 60 * 60_000).toISOString()
    const ttl = await grantTtl(
      `/api/iptv/stream/catchup/10/grant?startUtc=${encodeURIComponent(startUtc)}&durationMin=30`,
      'catchup',
    )
    expect(ttl).toBe(env.IPTV_ONDEMAND_TOKEN_TTL_SECS)
    expect(ttl).toBeGreaterThan(env.IPTV_STREAM_TOKEN_TTL_SECS)
  })

  it('HLS segment tokens minted from a VOD manifest use the long on-demand TTL', async () => {
    const mock = vi.mocked(signStreamToken)
    mock.mockClear()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response([
      '#EXTM3U',
      '#EXTINF:6.0,',
      'seg-001.ts',
    ].join('\n'), { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } }))
    try {
      const res = await app.request(`/api/iptv/stream/vod/20/m3u8?t=${fakeToken('vod', '20')}`)
      expect(res.status).toBe(200)
      const seg = mock.mock.calls.find(([, o]) => (o as { kind: string }).kind === 'segment')
      expect(seg, 'manifest rewrite should mint a segment token').toBeDefined()
      const ttl = (seg![1] as { ttlSecs: number }).ttlSecs
      expect(ttl).toBe(env.IPTV_ONDEMAND_TOKEN_TTL_SECS)
      expect(ttl).toBeGreaterThan(env.IPTV_STREAM_TOKEN_TTL_SECS)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('HLS manifest egress deadline + body bound', () => {
  const app = new Hono().route('/api/iptv', iptv)
  const envRw = env as unknown as {
    IPTV_MANIFEST_FETCH_TIMEOUT_MS: number
    IPTV_MANIFEST_MAX_BYTES: number
  }

  it('aborts a hung manifest upstream within the configured deadline (504 upstream_timeout)', async () => {
    const prevTimeout = envRw.IPTV_MANIFEST_FETCH_TIMEOUT_MS
    envRw.IPTV_MANIFEST_FETCH_TIMEOUT_MS = 50
    // Never settles on its own; rejects only when the composed abort signal
    // (whole-transfer timeout / per-hop timeout / client disconnect) fires.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const s = init?.signal
          if (!s) return
          if (s.aborted) return reject(s.reason)
          s.addEventListener('abort', () => reject(s.reason), { once: true })
        }),
    )
    try {
      const res = await app.request(`/api/iptv/stream/vod/20/m3u8?t=${fakeToken('vod', '20')}`)
      expect(res.status).toBe(504)
      expect(((await res.json()) as { error: string }).error).toBe('upstream_timeout')
      // The fetch must have carried the composed abort signal.
      const init = fetchSpy.mock.calls[0][1] as RequestInit
      expect(init.signal).toBeInstanceOf(AbortSignal)
    } finally {
      envRw.IPTV_MANIFEST_FETCH_TIMEOUT_MS = prevTimeout
      fetchSpy.mockRestore()
    }
  })

  it('refuses a manifest body larger than the cap (502 manifest_too_large)', async () => {
    const prevMax = envRw.IPTV_MANIFEST_MAX_BYTES
    envRw.IPTV_MANIFEST_MAX_BYTES = 64
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('#EXTM3U\n' + 'X'.repeat(1024), { status: 200 }),
    )
    try {
      const res = await app.request(`/api/iptv/stream/vod/20/m3u8?t=${fakeToken('vod', '20')}`)
      expect(res.status).toBe(502)
      expect(((await res.json()) as { error: string }).error).toBe('manifest_too_large')
    } finally {
      envRw.IPTV_MANIFEST_MAX_BYTES = prevMax
      fetchSpy.mockRestore()
    }
  })
})

describe('series stream grant', () => {
  const app = new Hono().route('/api/iptv', iptv)

  it('issues a tokenized URL with detected episode ext', async () => {
    const res = await app.request('/api/iptv/stream/series/ep-1/grant', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string; delivery: string; mime: string }
    expect(body.url).toContain('/api/iptv/stream/series/ep-1/mkv?t=fake.series.ZXAtMQ')
    expect(body.delivery).toBe('progressive')
    expect(body.mime).toBe('video/x-matroska')
  })
})

// The whole IPTV catalog (VOD + Series) is surfaced under the client's Live
// tab, so the vod and series grants share the `live` section gate with the
// live/catchup grants: a member whose policy denies Live TV must not be able to
// mint a VOD or series token either, even with no rating cap set
// (capBlocksUnrated is a no-op when maxContentRating is null, so the section
// gate is the only thing that stops them). Mirrors the catchup section-policy
// tests above.
describe('vod + series section policy', () => {
  const app = new Hono().route('/api/iptv', iptv)
  let sectionPolicyDir: string
  let sectionPolicyPath: string
  beforeEach(async () => {
    sectionPolicyDir = await fsp.mkdtemp(join(tmpdir(), 'iptv-vodseries-policy-'))
    sectionPolicyPath = join(sectionPolicyDir, 'user-policies.json')
    _setUserPoliciesPathForTests(sectionPolicyPath)
  })
  afterEach(async () => {
    _setUserPoliciesPathForTests(env.userPoliciesPath)
    authState.session = { sub: 'plex:42', username: 'Test', role: 'admin' }
    await fsp.rm(sectionPolicyDir, { recursive: true, force: true })
  })

  const denyLive = async (sub: string) => {
    await fsp.writeFile(
      sectionPolicyPath,
      JSON.stringify({
        [sub]: {
          maxContentRating: null,
          allowedSections: { live: false, downloads: true, arr: true },
          kid: true,
        },
      }),
    )
    _setUserPoliciesPathForTests(sectionPolicyPath)
  }
  const allowLive = async (sub: string) => {
    await fsp.writeFile(
      sectionPolicyPath,
      JSON.stringify({
        [sub]: {
          maxContentRating: null,
          allowedSections: { live: true, downloads: false, arr: false },
          kid: false,
        },
      }),
    )
    _setUserPoliciesPathForTests(sectionPolicyPath)
  }

  it('403 section_blocked on vod grant for a non-admin whose policy denies live', async () => {
    authState.session = { sub: 'plex:99', username: 'Kid', role: 'user' }
    await denyLive('plex:99')
    const res = await app.request('/api/iptv/stream/vod/20/grant', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'section_blocked' })
  })

  it('403 section_blocked on series grant for a non-admin whose policy denies live', async () => {
    authState.session = { sub: 'plex:99', username: 'Kid', role: 'user' }
    await denyLive('plex:99')
    const res = await app.request('/api/iptv/stream/series/ep-1/grant', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'section_blocked' })
  })

  it('allows the vod grant for a non-admin whose policy permits live', async () => {
    authState.session = { sub: 'plex:99', username: 'Teen', role: 'user' }
    await allowLive('plex:99')
    const res = await app.request('/api/iptv/stream/vod/20/grant', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  it('allows the series grant for a non-admin whose policy permits live', async () => {
    authState.session = { sub: 'plex:99', username: 'Teen', role: 'user' }
    await allowLive('plex:99')
    const res = await app.request('/api/iptv/stream/series/ep-1/grant', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  it('admin is never blocked on vod/series even under a live:false policy', async () => {
    authState.session = { sub: 'plex:42', username: 'Test', role: 'admin' }
    await denyLive('plex:42')
    const vodRes = await app.request('/api/iptv/stream/vod/20/grant', { method: 'POST' })
    expect(vodRes.status).toBe(200)
    const seriesRes = await app.request('/api/iptv/stream/series/ep-1/grant', { method: 'POST' })
    expect(seriesRes.status).toBe(200)
  })
})

describe('sessionTitle() series branches', () => {
  beforeAll(() => {
    // Episode whose own title is null → resolved title should be just the
    // series name (no " — <title>" suffix).
    dbState.testDb!.stmts.upsertEpisode.run({
      episode_id: 'ep-null-title',
      series_id: 30,
      season: 1,
      episode_num: 2,
      title: null,
      container_extension: 'mkv',
      added_ts: null,
      plot: null,
      duration_secs: null,
    })
    // Episode whose series row is absent → falls back to the episode's own
    // title. The episodes→series FK blocks dangling inserts, so seed a throw-
    // away series, attach the episode, then delete the series with FKs off to
    // recreate the "cleaned catalog / deleted parent" state the branch guards.
    const raw = dbState.testDb!.raw
    raw.prepare(
      'INSERT INTO series (series_id, name, fetched_at) VALUES (?, ?, ?)',
    ).run(31, 'DoomedShow', '2026-05-24T00:00:00Z')
    dbState.testDb!.stmts.upsertEpisode.run({
      episode_id: 'ep-orphan',
      series_id: 31,
      season: 1,
      episode_num: 1,
      title: 'Orphan Ep',
      container_extension: 'mkv',
      added_ts: null,
      plot: null,
      duration_secs: null,
    })
    raw.pragma('foreign_keys = OFF')
    raw.prepare('DELETE FROM series WHERE series_id = ?').run(31)
    raw.pragma('foreign_keys = ON')
  })

  it('joins series name with episode title when both present', () => {
    expect(__test.sessionTitle('series', 'ep-1')).toBe('GoT — Pilot')
  })

  it('returns bare series name when the episode title is null', () => {
    expect(__test.sessionTitle('series', 'ep-null-title')).toBe('GoT')
  })

  it('falls back to episode title when the series row is missing', () => {
    expect(__test.sessionTitle('series', 'ep-orphan')).toBe('Orphan Ep')
  })

  it('returns null when the episode row does not exist', () => {
    expect(__test.sessionTitle('series', 'no-such-episode')).toBeNull()
  })
})

describe('segment proxy', () => {
  const app = new Hono().route('/api/iptv', iptv)

  it('passes through signed segments with Range', async () => {
    const upstreamUrl = 'https://cdn.example.com/foo/seg.ts'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('seg', {
      status: 206,
      headers: {
        'content-type': 'video/mp2t',
        'content-length': '3',
        'content-range': 'bytes 0-2/12',
        'accept-ranges': 'bytes',
      },
    }))

    const res = await app.request(`/api/iptv/stream/segment?u=${encodeURIComponent(fakeToken('segment', upstreamUrl))}`, {
      headers: { Range: 'bytes=0-2' },
    })

    expect(res.status).toBe(206)
    expect(res.headers.get('content-type')).toBe('video/mp2t')
    expect(res.headers.get('content-range')).toBe('bytes 0-2/12')
    expect(fetchSpy).toHaveBeenCalledWith(upstreamUrl, expect.objectContaining({
      headers: { Range: 'bytes=0-2' },
    }))
    fetchSpy.mockRestore()
  })

  it('refuses to proxy a segment pointed at an internal host (SSRF)', async () => {
    // A segment token whose rid resolves to cloud metadata / an internal
    // service must be rejected before any fetch, even though the token's HMAC
    // is valid (the rid comes from upstream-controlled manifest lines).
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    for (const evil of [
      'https://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'https://10.0.0.1/seg.ts',
      'https://recommender:8000/internal',
      'http://169.254.169.254/latest/meta-data/', // http to internal is STILL blocked
      'http://recommender:8000/internal', // scheme relaxation must not weaken address checks
      'file:///etc/passwd', // non-http(s) scheme rejected
    ]) {
      const res = await app.request(
        `/api/iptv/stream/segment?u=${encodeURIComponent(fakeToken('segment', evil))}`,
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe('bad_upstream')
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('recursively rewrites signed sub-playlists', async () => {
    const upstreamUrl = 'https://cdn.example.com/foo/level1.m3u8'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response([
      '#EXTM3U',
      '#EXTINF:6.0,',
      'seg.ts',
    ].join('\n'), { status: 200 }))

    const res = await app.request(`/api/iptv/stream/segment?u=${encodeURIComponent(fakeToken('segment', upstreamUrl))}`)
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledWith(upstreamUrl, expect.objectContaining({ redirect: 'manual' }))
    expect(text).toContain(`/api/iptv/stream/segment?u=${encodeURIComponent(fakeToken('segment', 'https://cdn.example.com/foo/seg.ts'))}`)
    fetchSpy.mockRestore()
  })

  it('refuses a segment whose public host RESOLVES to cloud metadata (DNS rebinding, finding 3-1/16-0)', async () => {
    // The host string passes isPublicHttpsUpstream, but DNS points at the
    // link-local cloud-metadata address — resolve-and-validate must reject
    // BEFORE any egress.
    __setSsrfLookupForTests(async () => [{ address: '169.254.169.254' }])
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const res = await app.request(
      `/api/iptv/stream/segment?u=${encodeURIComponent(fakeToken('segment', 'https://rebind.attacker.example/seg.ts'))}`,
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('bad_upstream')
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
    // Restore the file-wide deterministic public resolver for later tests.
    __setSsrfLookupForTests(async () => [{ address: '203.0.113.7' }])
  })

  it('refuses a segment whose upstream 302-redirects to an internal host (finding 8-0)', async () => {
    // First hop resolves public + returns a 302 Location at a private host;
    // the redirect target must be re-validated and refused, not followed.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('cdn.example.com')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://169.254.169.254/latest/meta-data/' },
        })
      }
      return new Response('internal-secret', { status: 200 })
    })
    const res = await app.request(
      `/api/iptv/stream/segment?u=${encodeURIComponent(fakeToken('segment', 'https://cdn.example.com/seg.ts'))}`,
    )
    expect(res.status).toBe(400)
    // The metadata URL must never have been fetched.
    expect(fetchSpy).not.toHaveBeenCalledWith(
      'https://169.254.169.254/latest/meta-data/',
      expect.anything(),
    )
    fetchSpy.mockRestore()
  })

  it('rejects a token whose kind is not "segment" (kind_mismatch → invalid_token 401)', async () => {
    // verifyStreamToken succeeds (valid HMAC) but the decoded kind is
    // "live", so the route throws kind_mismatch and returns 401 before any
    // replay/SSRF/fetch work. Covers the verify-try/catch branch (iptv.ts ~1142).
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const res = await app.request(
      `/api/iptv/stream/segment?u=${encodeURIComponent(fakeToken('live', 'https://cdn.example.com/seg.ts'))}`,
    )
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('invalid_token')
    expect(body.detail).toBe('kind_mismatch')
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('rejects a segment whose rid is not a parseable URL (bad_upstream 400)', async () => {
    // A valid segment token whose rid is a malformed URL string: new URL()
    // throws, so the route returns bad_upstream 400 before isPublicHttpsUpstream
    // or any fetch. Covers the URL-parse try/catch branch (iptv.ts ~1153).
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const res = await app.request(
      `/api/iptv/stream/segment?u=${encodeURIComponent(fakeToken('segment', 'not a valid url'))}`,
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('bad_upstream')
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('re-throws a non-SSRF guardedFetch failure (network error is NOT masked as bad_upstream)', async () => {
    // The host string + resolved IP pass the SSRF guard, but the underlying
    // platform fetch rejects with a plain network error. guardedFetch lets a
    // non-SsrfBlockedError propagate, so the route's catch hits `throw err`
    // (NOT the bad_upstream 400 branch). Covers iptv.ts ~1185-1186.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new TypeError('socket hang up'),
    )
    const res = await app.request(
      `/api/iptv/stream/segment?u=${encodeURIComponent(fakeToken('segment', 'https://cdn.example.com/net-fail.ts'))}`,
    )
    // The route re-threw (did NOT swallow as bad_upstream 400); Hono's error
    // boundary surfaces it as a 500, proving the non-SsrfBlockedError branch.
    expect(res.status).toBe(500)
    expect(res.status).not.toBe(400)
    expect(fetchSpy).toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('POST /api/iptv/admin/sync', () => {
  it('returns a job id and final stats', async () => {
    const app = new Hono().route('/api/iptv', iptv)
    const res = await app.request('/api/iptv/admin/sync', { method: 'POST' })
    expect(res.status).toBe(202)
    const body = await res.json() as { jobId: string }
    expect(typeof body.jobId).toBe('string')
  })

  it('GET /admin/sync/:id reports completed stats', async () => {
    const app = new Hono().route('/api/iptv', iptv)
    const start = await app.request('/api/iptv/admin/sync', { method: 'POST' })
    const { jobId } = await start.json() as { jobId: string }
    await new Promise(r => setTimeout(r, 30))
    const status = await app.request(`/api/iptv/admin/sync/${jobId}`)
    expect(status.status).toBe(200)
    const body = await status.json() as { state: string; result?: { channels: number } }
    expect(body.state).toBe('done')
    expect(body.result?.channels).toBe(10)
  })

  it('records sync errors in job state', async () => {
    const { syncOnce } = await import('../services/iptvSync.js')
    vi.mocked(syncOnce).mockRejectedValueOnce(new Error('sync_failed'))

    const app = new Hono().route('/api/iptv', iptv)
    const res = await app.request('/api/iptv/admin/sync', { method: 'POST' })
    expect(res.status).toBe(202)
    const { jobId } = await res.json() as { jobId: string }

    await new Promise(r => setTimeout(r, 30))
    const status = await app.request(`/api/iptv/admin/sync/${jobId}`)
    expect(status.status).toBe(200)
    const body = await status.json() as { state: string; error?: string }
    expect(body.state).toBe('error')
    expect(body.error).toBe('sync_failed')

    // Restore mock for subsequent tests
    vi.mocked(syncOnce).mockResolvedValue({
      busy: false, channels: 10, vod: 20, series: 5, episodes: 50, epg: 100, categories: 6,
      startedAt: '2026-05-24T00:00:00Z', finishedAt: '2026-05-24T00:00:30Z', durationMs: 30000,
    })
  })

  it('cleans up oldest job when map exceeds 20 entries', async () => {
    const app = new Hono().route('/api/iptv', iptv)
    const jobIds: string[] = []

    // Create 21 jobs (will trigger cleanup of the oldest)
    for (let i = 0; i < 21; i++) {
      const res = await app.request('/api/iptv/admin/sync', { method: 'POST' })
      expect(res.status).toBe(202)
      const { jobId } = await res.json() as { jobId: string }
      jobIds.push(jobId)
      // Let the mocked syncOnce settle so the job is finished (evictable)
      // before the next insert — only finished jobs may be evicted.
      await new Promise(r => setTimeout(r, 0))
    }

    await new Promise(r => setTimeout(r, 50))

    // Verify the oldest job (first one) is gone
    const oldestJobStatus = await app.request(`/api/iptv/admin/sync/${jobIds[0]}`)
    expect(oldestJobStatus.status).toBe(404)

    // Verify a newer job is still there
    const newerJobStatus = await app.request(`/api/iptv/admin/sync/${jobIds[20]}`)
    expect(newerJobStatus.status).toBe(200)
  })

  it('records a busy refusal as state "rejected", not "done"', async () => {
    const { syncOnce } = await import('../services/iptvSync.js')
    vi.mocked(syncOnce).mockResolvedValueOnce({ busy: true })

    const app = new Hono().route('/api/iptv', iptv)
    const res = await app.request('/api/iptv/admin/sync', { method: 'POST' })
    expect(res.status).toBe(202)
    const { jobId } = await res.json() as { jobId: string }

    await new Promise(r => setTimeout(r, 30))
    const status = await app.request(`/api/iptv/admin/sync/${jobId}`)
    expect(status.status).toBe(200)
    const body = await status.json() as { state: string }
    expect(body.state).toBe('rejected')
  })

  it('never evicts a still-RUNNING job when the cap is exceeded', async () => {
    const { syncOnce } = await import('../services/iptvSync.js')
    // First job never settles — stays 'running' for the whole test.
    vi.mocked(syncOnce).mockImplementationOnce(() => new Promise(() => {}))

    const app = new Hono().route('/api/iptv', iptv)
    const first = await app.request('/api/iptv/admin/sync', { method: 'POST' })
    const { jobId: runningId } = await first.json() as { jobId: string }

    // Flood past the 20-entry cap with jobs that finish normally.
    const finishedIds: string[] = []
    for (let i = 0; i < 21; i++) {
      const res = await app.request('/api/iptv/admin/sync', { method: 'POST' })
      const { jobId } = await res.json() as { jobId: string }
      finishedIds.push(jobId)
      await new Promise(r => setTimeout(r, 0))
    }

    // The running job is still queryable — eviction skipped over it…
    const runningStatus = await app.request(`/api/iptv/admin/sync/${runningId}`)
    expect(runningStatus.status).toBe(200)
    expect(((await runningStatus.json()) as { state: string }).state).toBe('running')

    // …and the oldest FINISHED job was evicted instead.
    const evicted = await app.request(`/api/iptv/admin/sync/${finishedIds[0]}`)
    expect(evicted.status).toBe(404)
  })
})

describe('catalog read routes', () => {
  const app = new Hono().route('/api/iptv', iptv)
  it('lists categories by kind', async () => {
    const res = await app.request('/api/iptv/categories?kind=live')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ name: string }>
    expect(body[0].name).toBe('News')
  })
  it('rejects unknown kind', async () => {
    const res = await app.request('/api/iptv/categories?kind=music')
    expect(res.status).toBe(400)
  })
  it('lists live channels with query params', async () => {
    const res = await app.request('/api/iptv/live?q=cnn&limit=10')
    const body = (await res.json()) as { total: number }
    expect(body.total).toBe(1)
  })
  it('returns vod detail or 404', async () => {
    const res = await app.request('/api/iptv/vod/20')
    expect(res.status).toBe(200)
  })
  it('returns series detail', async () => {
    const res = await app.request('/api/iptv/series/30')
    const body = (await res.json()) as { name: string }
    expect(body.name).toBe('GoT')
  })
})

describe('GET /api/iptv/export/recommender', () => {
  const app = new Hono().route('/api/iptv', iptv)
  const previousSecret = env.IPTV_RECOMMENDER_EXPORT_SECRET
  const setExportSecret = (value: string | null) => {
    (env as unknown as { IPTV_RECOMMENDER_EXPORT_SECRET: string | null }).IPTV_RECOMMENDER_EXPORT_SECRET = value
  }

  afterAll(() => {
    setExportSecret(previousSecret)
  })

  it('rejects missing, mismatched, or empty secrets', async () => {
    setExportSecret('shh')
    expect((await app.request('/api/iptv/export/recommender')).status).toBe(403)
    expect((await app.request('/api/iptv/export/recommender', {
      headers: { 'x-iptv-export-secret': 'wrong' },
    })).status).toBe(403)

    setExportSecret('')
    expect((await app.request('/api/iptv/export/recommender', {
      headers: { 'x-iptv-export-secret': 'shh' },
    })).status).toBe(403)
  })

  it('exports vod and series rows with the recommender shape', async () => {
    setExportSecret('shh')
    const res = await app.request('/api/iptv/export/recommender', {
      headers: { 'x-iptv-export-secret': 'shh' },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as {
      vod: Array<{ id: number; title: string; tmdb_id: number | null; cast: string | null }>
      series: Array<{ id: number; title: string }>
    }
    expect(body.vod).toContainEqual(expect.objectContaining({
      id: 20,
      title: 'Matrix',
      tmdb_id: 603,
      cast: 'Keanu Reeves, Carrie-Anne Moss',
    }))
    expect(body.series).toContainEqual(expect.objectContaining({
      id: 30,
      title: 'GoT',
    }))
  })
})

describe('favorites + history', () => {
  const app = new Hono().route('/api/iptv', iptv)

  it('adds a favorite and lists it', async () => {
    const add = await app.request('/api/iptv/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'live', itemId: '10' }),
    })

    expect(add.status).toBe(201)
    const after = await (await app.request('/api/iptv/favorites')).json() as Array<{ kind: string; item_id: string }>
    expect(after).toContainEqual(expect.objectContaining({ kind: 'live', item_id: '10' }))
    await app.request('/api/iptv/favorites/live/10', { method: 'DELETE' })
  })

  it('removes a favorite and excludes it from the list', async () => {
    await app.request('/api/iptv/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'live', itemId: '10' }),
    })

    const del = await app.request('/api/iptv/favorites/live/10', { method: 'DELETE' })
    expect(del.status).toBe(204)

    const empty = await (await app.request('/api/iptv/favorites')).json()
    expect(empty).toEqual([])
  })

  it.each(['live', 'vod', 'series'])('accepts %s as a valid favorite kind (KINDS set)', async (kind) => {
    const add = await app.request('/api/iptv/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, itemId: '99' }),
    })
    expect(add.status).toBe(201)
    await app.request(`/api/iptv/favorites/${kind}/99`, { method: 'DELETE' })
  })

  it('rejects an unknown kind on POST /favorites with 400 invalid_kind', async () => {
    // 'series_episode' is in HIST_KINDS but NOT in the favorites KINDS set — must be rejected.
    const res = await app.request('/api/iptv/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'series_episode', itemId: '10' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_kind' })
  })

  it('rejects an unknown kind on DELETE /favorites/:kind/:itemId with 400 invalid_kind', async () => {
    const res = await app.request('/api/iptv/favorites/series_episode/10', { method: 'DELETE' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_kind' })
  })

  it('records and reads history with the reported position', async () => {
    const put = await app.request('/api/iptv/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'vod', itemId: '20', positionSecs: 90, durationSecs: 7200, completed: false }),
    })

    expect(put.status).toBe(201)
    const hist = await (await app.request('/api/iptv/history?limit=10')).json() as Array<{
      kind: string
      item_id: string
      position_secs: number
      completed: number
    }>
    expect(hist[0]).toMatchObject({ kind: 'vod', item_id: '20', position_secs: 90, completed: 0 })
  })
})

describe('§9 source_unavailable propagation on grant endpoints', () => {
  const app = new Hono().route('/api/iptv', iptv)

  it('returns 503 source_unavailable on live grant when no source is reachable', async () => {
    const { resolveSourcePrecedence } = await import('../services/sourcePrecedence.js')
    vi.mocked(resolveSourcePrecedence).mockResolvedValueOnce({ resolved: null, alternatives: [] })

    const res = await app.request('/api/iptv/stream/live/10/grant', { method: 'POST' })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { ok: boolean; reason: string }
    expect(body.reason).toBe('source_unavailable')
  })

  it('returns 503 source_unavailable on catchup grant when no source is reachable', async () => {
    const { resolveSourcePrecedence } = await import('../services/sourcePrecedence.js')
    vi.mocked(resolveSourcePrecedence).mockResolvedValueOnce({ resolved: null, alternatives: [] })

    const startUtc = new Date(Date.now() - 60 * 60_000).toISOString()
    const res = await app.request(
      `/api/iptv/stream/catchup/10/grant?startUtc=${encodeURIComponent(startUtc)}&durationMin=30`,
      { method: 'POST' },
    )
    expect(res.status).toBe(503)
    const body = (await res.json()) as { reason: string }
    expect(body.reason).toBe('source_unavailable')
  })

  it('returns 503 source_unavailable on vod grant when no source is reachable', async () => {
    const { resolveSourcePrecedence } = await import('../services/sourcePrecedence.js')
    vi.mocked(resolveSourcePrecedence).mockResolvedValueOnce({ resolved: null, alternatives: [] })

    const res = await app.request('/api/iptv/stream/vod/20/grant', { method: 'POST' })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { reason: string }
    expect(body.reason).toBe('source_unavailable')
  })

  it('returns 503 source_unavailable on series grant when no source is reachable', async () => {
    const { resolveSourcePrecedence } = await import('../services/sourcePrecedence.js')
    vi.mocked(resolveSourcePrecedence).mockResolvedValueOnce({ resolved: null, alternatives: [] })

    const res = await app.request('/api/iptv/stream/series/ep-1/grant', { method: 'POST' })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { reason: string }
    expect(body.reason).toBe('source_unavailable')
  })
})

describe('remux live delivery (AVPlayer)', () => {
  const app = new Hono().route('/api/iptv', iptv)
  const manifestPath = '/tmp/remux/sess-1/index.m3u8'
  // ≥ START_SEGMENTS (4) so the handler's readiness gate is satisfied at once;
  // a thinner window makes a live player error on first load (see the route).
  const sampleManifest =
    '#EXTM3U\n#EXTINF:6,\nseg_00000.ts\n#EXTINF:6,\nseg_00001.ts\n' +
    '#EXTINF:6,\nseg_00002.ts\n#EXTINF:6,\nseg_00003.ts\n'

  beforeEach(() => {
    remuxState.activeSessions.clear()
    remuxState.files.clear()
    remuxState.startCalls.length = 0
    remuxState.deadFeeds.clear()
    // Clear the live-remux index AND the reconnect-throttle state so a prior
    // test's "recent dial / fast death" can't throttle this test's first tune.
    _resetLiveRemuxIndexForTests()
  })

  // ── index.m3u8 ──────────────────────────────────────────────────────────
  it('index.m3u8 rejects a non-numeric streamId with 400 invalid_id', async () => {
    const res = await app.request(
      '/api/iptv/stream/live/abc/remux/index.m3u8?t=' + fakeToken('remux', 'abc'),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_id')
  })

  it('index.m3u8 rejects a bad token with 401', async () => {
    const res = await app.request('/api/iptv/stream/live/10/remux/index.m3u8?t=bogus')
    expect(res.status).toBe(401)
  })

  it('index.m3u8 starts a session and returns a rewritten signed manifest', async () => {
    remuxState.files.set(manifestPath, sampleManifest)
    const res = await app.request(
      `/api/iptv/stream/live/10/remux/index.m3u8?t=${fakeToken('remux', '10')}`,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/vnd.apple.mpegurl')

    const text = await res.text()
    // bare segment lines are rewritten into signed seg URLs …
    expect(text).not.toMatch(/^seg_00000\.ts$/m)
    expect(text).not.toMatch(/^seg_00001\.ts$/m)
    expect(text).toContain('/api/iptv/stream/live/10/remux/seg?t=')
    // … while #EXTINF comment lines are preserved unchanged.
    expect(text).toContain('#EXTM3U')
    expect(text).toContain('#EXTINF:6,')

    expect(remuxState.startCalls.length).toBe(1)
    expect(remuxState.startCalls[0].streamId).toBe('10')
    // creds come from the mocked credsFromEnv (host https://panel.example.com, u/p)
    expect(remuxState.startCalls[0].upstreamUrl).toContain('/live/u/p/10.ts')
  })

  it('index.m3u8 returns 503 remux_warming + Retry-After when the manifest never appears', async () => {
    vi.useFakeTimers()
    try {
      // No file seeded -> existsSync stays false through the whole poll window.
      const p = app.request(
        `/api/iptv/stream/live/10/remux/index.m3u8?t=${fakeToken('remux', '10')}`,
      )
      // Drive the handler's 15s Date.now() deadline + 200ms sleep() loop.
      await vi.advanceTimersByTimeAsync(15200)
      const res = await p
      // 503 (not 504) so the client backs off and retries WITHOUT forcing a new
      // upstream dial — the reconnect throttle owns when a re-dial may happen.
      expect(res.status).toBe(503)
      expect(res.headers.get('Retry-After')).toBe('3')
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe('remux_warming')
    } finally {
      vi.useRealTimers()
    }
  })

  it('index.m3u8 returns terminal channel_offline_upstream (no Retry-After) for a dead feed', async () => {
    // Channel 10 (seeded in beforeAll, no live sibling) EOF'd cleanly as a
    // dead-channel placeholder, so iptvRemux tagged it dead. Every candidate
    // feed is now dead → the channel is offline upstream (terminal), which must
    // be distinguishable from the transient remux_warming a client would retry.
    remuxState.deadFeeds.add('10')
    const res = await app.request(
      `/api/iptv/stream/live/10/remux/index.m3u8?t=${fakeToken('remux', '10')}`,
    )
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBeNull()
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('channel_offline_upstream')
    // A known-dead feed is never re-dialed — no upstream connection is opened.
    expect(remuxState.startCalls.length).toBe(0)
  })

  // ── seg ─────────────────────────────────────────────────────────────────
  it('seg rejects a non-numeric streamId with 400 invalid_id', async () => {
    const res = await app.request(
      `/api/iptv/stream/live/x/remux/seg?t=${fakeToken('remux', 'sess-1/seg_00000.ts')}`,
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_id')
  })

  it('seg rejects a token of the wrong kind with 401 invalid_token', async () => {
    const res = await app.request(
      `/api/iptv/stream/live/10/remux/seg?t=${fakeToken('segment', 'sess-1/seg_00000.ts')}`,
    )
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invalid_token')
  })

  it('seg rejects a rid lacking the seg pattern with 400 bad_resource', async () => {
    const res = await app.request(
      `/api/iptv/stream/live/10/remux/seg?t=${fakeToken('remux', 'sess-1/notaseg.ts')}`,
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('bad_resource')
  })

  it('seg returns 410 session_gone when no live index entry exists', async () => {
    // activeSessions empty AND liveRemuxIndex has no entry (index.m3u8 never called).
    const res = await app.request(
      `/api/iptv/stream/live/10/remux/seg?t=${fakeToken('remux', 'sess-1/seg_00000.ts')}`,
    )
    expect(res.status).toBe(410)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('session_gone')
  })

  it('seg streams the segment with 200 video/mp2t on the happy path', async () => {
    // Establish the liveRemuxIndex entry + active session via index.m3u8 first.
    remuxState.files.set(manifestPath, sampleManifest)
    const idx = await app.request(
      `/api/iptv/stream/live/10/remux/index.m3u8?t=${fakeToken('remux', '10')}`,
    )
    expect(idx.status).toBe(200)

    // Seed the requested segment so existsSync(filePath) is true.
    remuxState.files.set('/tmp/remux/sess-1/seg_00000.ts', '')
    const res = await app.request(
      `/api/iptv/stream/live/10/remux/seg?t=${fakeToken('remux', 'sess-1/seg_00000.ts')}`,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp2t')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes.length).toBeGreaterThan(0)
  })

  it('seg returns 404 segment_gone when the segment file is missing', async () => {
    // Same setup as happy path (indexed + active) but do NOT seed the segment.
    remuxState.files.set(manifestPath, sampleManifest)
    const idx = await app.request(
      `/api/iptv/stream/live/10/remux/index.m3u8?t=${fakeToken('remux', '10')}`,
    )
    expect(idx.status).toBe(200)

    const res = await app.request(
      `/api/iptv/stream/live/10/remux/seg?t=${fakeToken('remux', 'sess-1/seg_00000.ts')}`,
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('segment_gone')
  })
})

describe('GET /api/iptv/epg/search — server-side programme search', () => {
  const app = new Hono().route('/api/iptv', iptv)
  // A fixed window so the test never depends on wall-clock. The endpoint's
  // default is now..now+4h; we pass explicit from/to to bound the seeded data.
  const from = '2026-07-06T00:00:00Z'
  const to = '2026-07-06T06:00:00Z'

  // Fresh token bucket per test so the per-caller limiter (capacity 10) never
  // starts pre-drained from a neighbouring case.
  beforeEach(() => {
    __resetRateLimitsForTests()
  })

  beforeAll(() => {
    const db = dbState.testDb!
    // Two channels the tvOS guide would NOT pre-fetch (high num, beyond the warm
    // cap) — the exact case the client-side scan could never reach.
    db.stmts.upsertChannel.run({
      stream_id: 700, num: 500, name: 'YES Network', stream_icon: null,
      epg_channel_id: 'yes.us', category_id: 5, is_adult: 0,
      tv_archive: 0, tv_archive_duration: null, added_ts: null, fetched_at: from,
    })
    db.stmts.upsertChannel.run({
      stream_id: 701, num: 501, name: 'Food Net', stream_icon: null,
      epg_channel_id: 'food.us', category_id: 6, is_adult: 0,
      tv_archive: 0, tv_archive_duration: null, added_ts: null, fetched_at: from,
    })
    // YES: one description-match then one title-match (programIndex 0, then 1).
    db.stmts.upsertEpg.run({
      channel_id: 'yes.us', start_utc: '2026-07-06T01:00:00Z', stop_utc: '2026-07-06T02:00:00Z',
      title: 'Pregame', description: 'Yankees preview',
    })
    db.stmts.upsertEpg.run({
      channel_id: 'yes.us', start_utc: '2026-07-06T02:00:00Z', stop_utc: '2026-07-06T04:00:00Z',
      title: 'Yankees vs Red Sox', description: 'MLB regular season',
    })
    // Food channel: no 'Yankees' anywhere — must never surface for that query.
    db.stmts.upsertEpg.run({
      channel_id: 'food.us', start_utc: '2026-07-06T01:00:00Z', stop_utc: '2026-07-06T02:00:00Z',
      title: 'Cooking Show', description: 'recipes',
    })
  })

  it('finds programmes on a channel absent from the warm grid, title + description', async () => {
    const res = await app.request(
      `/api/iptv/epg/search?q=Yankees&from=${from}&to=${to}`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      total: number
      hits: Array<{
        streamId: number; channelName: string; categoryId: number | null; programIndex: number
        programme: { channel_id: string; start_utc: string; stop_utc: string; title: string | null; description: string | null }
      }>
    }
    expect(body.total).toBe(2)
    expect(body.hits).toHaveLength(2)
    // Both hits are the non-warm YES channel; the Food channel never appears.
    expect(body.hits.every((h) => h.streamId === 700 && h.channelName === 'YES Network' && h.categoryId === 5)).toBe(true)
    // Ordered by programme start → description-match (idx 0) before title-match (idx 1).
    expect(body.hits.map((h) => h.programIndex)).toEqual([0, 1])
    expect(body.hits[1].programme.title).toBe('Yankees vs Red Sox')
    // Programme reuses the grid projection (snake_case) so it decodes into the
    // client's existing EpgProgram type.
    expect(body.hits[0].programme).toMatchObject({
      channel_id: 'yes.us',
      start_utc: '2026-07-06T01:00:00Z',
      stop_utc: '2026-07-06T02:00:00Z',
    })
  })

  it('missing q → 400 invalid_query', async () => {
    const res = await app.request(`/api/iptv/epg/search?from=${from}&to=${to}`)
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toEqual({ error: 'invalid_query' })
  })

  it('1-char q → 400 invalid_query (min length narrows the scan)', async () => {
    const res = await app.request(`/api/iptv/epg/search?q=e&from=${from}&to=${to}`)
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toEqual({ error: 'invalid_query' })
  })

  it('rate-limits a burst: the 11th request within 1s → 429', async () => {
    const url = `/api/iptv/epg/search?q=Yankees&from=${from}&to=${to}`
    for (let i = 0; i < 10; i++) {
      expect((await app.request(url)).status).toBe(200)
    }
    const res = await app.request(url)
    expect(res.status).toBe(429)
  })

  it('categoryIds filter excludes channels outside the set', async () => {
    // YES is category 5; filtering to category 6 (Food) yields no Yankees hit.
    const res = await app.request(
      `/api/iptv/epg/search?q=Yankees&from=${from}&to=${to}&categoryIds=6`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { total: number; hits: unknown[] }
    expect(body.total).toBe(0)
    expect(body.hits).toEqual([])
  })

  it('respects limit while total reports the full match count', async () => {
    const res = await app.request(
      `/api/iptv/epg/search?q=Yankees&from=${from}&to=${to}&limit=1`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { total: number; hits: unknown[] }
    expect(body.hits).toHaveLength(1)
    expect(body.total).toBe(2)
  })
})

// Finding 95: dead-feed sibling failover on the RAW .ts byte proxy (the path
// every Chrome/Firefox/Edge live viewer uses). The remux/HLS path already fails
// over to a live sibling and reports channel_offline_upstream when all feeds are
// dead; the .ts path dialed only the granted feed and returned a hard 502 that
// mpegts.js could never recover from — same channel worked on the TV, stayed
// permanently dead on the web. These drive the two mock upstreams + sibling the
// verifier specified.
describe('GET /api/iptv/stream/live/:id.ts — dead-feed sibling failover', () => {
  const app = new Hono().route('/api/iptv', iptv)
  const tsUrl = (sid: string) => `https://panel.example.com/live/u/p/${sid}.ts`

  beforeAll(() => {
    const db = dbState.testDb!
    // Two sibling feeds sharing an epg_channel_id — resolveSiblingFeeds('900')
    // yields ['900','901']. A unique epg/name so they never fold into CNN et al.
    db.stmts.upsertChannel.run({
      stream_id: 900, num: 900, name: 'Gate95 Sports', stream_icon: null,
      epg_channel_id: 'gate95.us', category_id: 9, is_adult: 0,
      tv_archive: 0, tv_archive_duration: null, added_ts: null, fetched_at: '2026-07-06T00:00:00Z',
    })
    db.stmts.upsertChannel.run({
      stream_id: 901, num: 901, name: 'Gate95 Sports', stream_icon: null,
      epg_channel_id: 'gate95.us', category_id: 9, is_adult: 0,
      tv_archive: 0, tv_archive_duration: null, added_ts: null, fetched_at: '2026-07-06T00:00:00Z',
    })
  })

  beforeEach(() => {
    remuxState.deadFeeds.clear()
    __setSsrfLookupForTests(async () => [{ address: '203.0.113.7' }])
  })

  it('fails over to a live sibling when the granted feed is hard-down (was a 502 upstream_*)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input)
      if (url.includes('/900.ts')) return new Response(null, { status: 404 })
      if (url.includes('/901.ts')) return new Response('sibling-bytes', { status: 200 })
      throw new Error(`unexpected fetch ${url}`)
    })

    const res = await app.request(`/api/iptv/stream/live/900.ts?t=${fakeToken('live', '900')}`)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp2t')
    expect(await res.text()).toBe('sibling-bytes')
    // Dialed the dead feed first, then the live sibling.
    expect(fetchSpy).toHaveBeenCalledWith(tsUrl('900'), expect.anything())
    expect(fetchSpy).toHaveBeenCalledWith(tsUrl('901'), expect.anything())
    fetchSpy.mockRestore()
  })

  it('returns 503 channel_offline_upstream when every candidate feed is down (not 502)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input)
      if (url.includes('/900.ts') || url.includes('/901.ts')) return new Response(null, { status: 404 })
      throw new Error(`unexpected fetch ${url}`)
    })

    const res = await app.request(`/api/iptv/stream/live/900.ts?t=${fakeToken('live', '900')}`)

    expect(res.status).toBe(503)
    expect((await res.json()) as { error: string }).toEqual({ error: 'channel_offline_upstream' })
    fetchSpy.mockRestore()
  })

  it('skips a feed already remembered as a dead placeholder and dials the live sibling directly', async () => {
    remuxState.deadFeeds.add('900')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input)
      if (url.includes('/901.ts')) return new Response('sibling-bytes', { status: 200 })
      throw new Error(`unexpected fetch ${url}`)
    })

    const res = await app.request(`/api/iptv/stream/live/900.ts?t=${fakeToken('live', '900')}`)

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('sibling-bytes')
    // The remembered-dead granted feed is never dialed.
    expect(fetchSpy).not.toHaveBeenCalledWith(tsUrl('900'), expect.anything())
    expect(fetchSpy).toHaveBeenCalledWith(tsUrl('901'), expect.anything())
    fetchSpy.mockRestore()
  })

  it('marks the dialed feed dead on a clean fast upstream EOF so the next reload fails over', async () => {
    // A dead-channel placeholder plays a short slate loop then EOFs cleanly.
    // Streaming it once must tag it dead (byte-proxy analogue of the remux
    // ffmpeg-exit-0-under-60s check).
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input)
      if (url.includes('/900.ts')) return new Response('slate', { status: 200 })
      throw new Error(`unexpected fetch ${url}`)
    })

    const res = await app.request(`/api/iptv/stream/live/900.ts?t=${fakeToken('live', '900')}`)
    expect(res.status).toBe(200)
    // Drain the body so the transform's flush() (clean-EOF hook) runs.
    await res.text()
    expect(remuxState.deadFeeds.has('900')).toBe(true)
    fetchSpy.mockRestore()
  })
})
