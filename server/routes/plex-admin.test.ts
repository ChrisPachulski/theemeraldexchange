// /api/plex/remote-access — admin-only XML scrape of the local PMS's
// /:/prefs endpoint. We test:
//   1. unauthenticated → 401
//   2. user role → 403 admin_only, upstream not called
//   3. no plexAuthToken in session → 409 no_plex_token
//   4. happy path: XML is parsed into the documented summary keys
//   5. PMS returns non-OK → 502 prefs_failed with upstream status
//   6. fetch throws (DNS / refused) → 502 unreachable

import { describe, it, expect, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { plexAdmin } from './plex-admin.js'
import { createMemberSession as createSession } from '../test/authFixture.js'
import type { Env } from '../middleware/auth.js'

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', plexAdmin)
  return app
}

async function adminCookie(opts: { withPlexToken?: boolean } = {}) {
  const t = await createSession({
    sub: 'plex:1',
    username: 'admin-user',
    role: 'admin',
    plexAuthToken: opts.withPlexToken === false ? undefined : 'plex-admin-token',
  })
  return `eex.session=${t}`
}
async function userCookie() {
  const t = await createSession({
    sub: 'plex:2',
    username: 'guest',
    role: 'user',
    plexAuthToken: 'plex-user-token',
  })
  return `eex.session=${t}`
}

// A representative slice of /:/prefs XML — keys plex-admin.ts actually
// reads. Real responses include 100+ <Setting/> rows; we keep only the
// ones the parser is looking for.
const PREFS_XML_HAPPY = `<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer size="11">
  <Setting id="PublishServerOnPlexOnlineKey" value="1" />
  <Setting id="ManualPortMappingMode" value="1" />
  <Setting id="ManualPortMappingPort" value="32400" />
  <Setting id="secureConnections" value="2" />
  <Setting id="customConnections" value="https://example.lan:32400" />
  <Setting id="allowedNetworks" value="192.168.1.0/24" />
  <Setting id="lanNetworksBandwidth" value="0" />
  <Setting id="WanPerStreamMaxUploadRate" value="0" />
  <Setting id="certificateUUID" value="abc-123" />
  <Setting id="PublicPort" value="32400" />
  <Setting id="PublicAddress" value="203.0.113.10" />
</MediaContainer>`

afterEach(() => vi.unstubAllGlobals())

describe('plex-admin /remote-access — gates', () => {
  it('rejects unauthenticated with 401', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const r = await appUnderTest().request('/remote-access')
    expect(r.status).toBe(401)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('rejects user role with 403 admin_only and does NOT hit PMS', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const r = await appUnderTest().request('/remote-access', {
      headers: { Cookie: await userCookie() },
    })
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ error: 'forbidden', reason: 'admin_only' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('admin without plexAuthToken → 409 no_plex_token', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const r = await appUnderTest().request('/remote-access', {
      headers: { Cookie: await adminCookie({ withPlexToken: false }) },
    })
    expect(r.status).toBe(409)
    expect(await r.json()).toEqual({ error: 'no_plex_token' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('plex-admin /remote-access — happy path', () => {
  it('parses XML into the documented summary + interpretation shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(PREFS_XML_HAPPY, {
            status: 200,
            headers: { 'Content-Type': 'application/xml' },
          }),
      ),
    )
    const r = await appUnderTest().request('/remote-access', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      summary: {
        remoteAccessEnabled: boolean
        manualPortMappingEnabled: boolean
        manualPort: string | null
        publicAddressDetected: boolean
        detectedPublicPort: string | null
        hasCustomConnections: boolean
        secureConnectionsMode: string | null
        hasCertificate: boolean
        wanUploadCapBytes: string | null
        allowedNetworks: string | null
        lanNetworksBandwidth: string | null
      }
      interpretation: { remoteAccess: string; portMapping: string; publicReachability: string }
    }
    expect(body.summary.remoteAccessEnabled).toBe(true)
    expect(body.summary.manualPortMappingEnabled).toBe(true)
    expect(body.summary.manualPort).toBe('32400')
    // The raw public IP and raw customConnections (both hold the operator's
    // home/LAN address) must NEVER reach the client — only presence booleans.
    expect(body.summary).not.toHaveProperty('detectedPublicAddress')
    expect(body.summary).not.toHaveProperty('customConnections')
    expect(body.summary.publicAddressDetected).toBe(true)
    expect(body.summary.hasCustomConnections).toBe(true)
    expect(body.summary.detectedPublicPort).toBe('32400')
    expect(body.summary.secureConnectionsMode).toBe('2')
    expect(body.summary.hasCertificate).toBe(true)
    expect(body.summary.allowedNetworks).toBe('192.168.1.0/24')
    expect(body.interpretation.remoteAccess).toContain('advertising')
    expect(body.interpretation.portMapping).toContain('32400')
    // No raw IP, internal hostname, or customConnections value anywhere in body.
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('203.0.113.10')
    expect(serialized).not.toContain('example.lan')
    expect(serialized).not.toContain('theemeraldexchange.local')
  })

  it('threads the session plex token into the header', async () => {
    const spy = vi.fn(
      async () =>
        new Response(PREFS_XML_HAPPY, {
          status: 200,
          headers: { 'Content-Type': 'application/xml' },
        }),
    )
    vi.stubGlobal('fetch', spy)
    await appUnderTest().request('/remote-access', {
      headers: { Cookie: await adminCookie() },
    })
    expect(spy).toHaveBeenCalledOnce()
    const firstCall = (spy.mock.calls as unknown as unknown[][])[0] ?? []
    const calledUrl = String(firstCall[0])
    const calledInit = firstCall[1] as { headers?: Record<string, string> } | undefined
    expect(calledUrl).toContain('/:/prefs')
    expect(calledUrl).not.toContain('X-Plex-Token')
    expect(calledInit?.headers?.['X-Plex-Token']).toBe('plex-admin-token')
  })

  it('missing PublishServerOnPlexOnlineKey → remoteAccessEnabled=false and the off-message interpretation', async () => {
    const xml = `<?xml version="1.0"?>
<MediaContainer>
  <Setting id="ManualPortMappingMode" value="0" />
</MediaContainer>`
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(xml, { status: 200, headers: { 'Content-Type': 'application/xml' } }),
      ),
    )
    const r = await appUnderTest().request('/remote-access', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      summary: { remoteAccessEnabled: boolean; manualPortMappingEnabled: boolean }
      interpretation: { remoteAccess: string; portMapping: string; publicReachability: string }
    }
    expect(body.summary.remoteAccessEnabled).toBe(false)
    expect(body.summary.manualPortMappingEnabled).toBe(false)
    expect(body.interpretation.remoteAccess).toContain('NOT advertising')
    expect(body.interpretation.portMapping).toContain('UPnP')
    expect(body.interpretation.publicReachability).toContain('not detected a public address')
  })
})

describe('plex-admin /remote-access — upstream failures', () => {
  it('PMS returns 500 → 502 prefs_failed with upstream status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    )
    const r = await appUnderTest().request('/remote-access', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(502)
    const body = (await r.json()) as { error: string; status: number; body: string }
    expect(body.error).toBe('prefs_failed')
    expect(body.status).toBe(500)
    expect(body.body).toContain('boom')
  })

  it('fetch throws → 502 with the synthesized upstream error surfaced', async () => {
    // After the shared timeout wrapper rolled in, a thrown fetch no
    // longer reaches the route layer as an exception — fetchWithTimeout
    // catches the network error and returns a synthesized 504 Response.
    // The route's existing non-ok branch maps that to its standard
    // prefs_failed shape (still 502 to the SPA), with the synthesized
    // status visible in the body so the operator can distinguish a
    // genuine PMS 500 from a network-unreachable.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED 32400')
      }),
    )
    const r = await appUnderTest().request('/remote-access', {
      headers: { Cookie: await adminCookie() },
    })
    expect(r.status).toBe(502)
    const body = (await r.json()) as { error: string; status: number; body?: string }
    expect(body.error).toBe('prefs_failed')
    expect(body.status).toBe(504)
  })
})
