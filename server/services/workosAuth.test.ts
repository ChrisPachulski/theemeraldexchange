// Unit tests for the WorkOS code exchange (workosAuth.ts). fetch is stubbed
// so api.workos.com is never touched. parseSub('workos:…') is mocked the
// same way googleAuth.test.ts mocks google: — the checked-in N-API addon
// may predate the workos: contract addition until it is rebuilt.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./sub.js', async (orig) => {
  const actual = (await orig()) as typeof import('./sub.js')
  return {
    ...actual,
    parseSub: (s: string) => {
      if (s.startsWith('workos:')) {
        const id = s.slice('workos:'.length)
        if (!/^user_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new Error('sub_invalid_format')
        return { provider: 'workos' as const, id, raw: s }
      }
      return actual.parseSub(s)
    },
  }
})

vi.mock('../env.js', () => ({
  env: {
    workosClientId: 'client_123',
    workosApiKey: 'sk_test_abc',
    workosRedirectUri: 'https://api.example.test/api/auth/workos/callback',
  },
}))

import { exchangeWorkosCode, workosAuthorizationUrl } from './workosAuth.js'

const USER_ID = 'user_01E4ZCR3C56J083X43JQXF3JK5'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('workosAuthorizationUrl', () => {
  it('carries client id, registered redirect, authkit provider and state', () => {
    const url = new URL(workosAuthorizationUrl('nonce-1'))
    expect(url.origin + url.pathname).toBe('https://api.workos.com/user_management/authorize')
    expect(url.searchParams.get('client_id')).toBe('client_123')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.example.test/api/auth/workos/callback',
    )
    expect(url.searchParams.get('provider')).toBe('authkit')
    expect(url.searchParams.get('state')).toBe('nonce-1')
    expect(url.searchParams.has('client_secret')).toBe(false)
  })
})

describe('exchangeWorkosCode', () => {
  const fetchMock = vi.fn()
  beforeEach(() => vi.stubGlobal('fetch', fetchMock))
  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it('returns the parseSub-validated workos: sub plus name/email on success', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        user: { id: USER_ID, email: 'a@b.test', first_name: 'Ada', last_name: 'L' },
      }),
    )
    const r = await exchangeWorkosCode('code-1')
    expect(r).toEqual({
      ok: true,
      sub: { provider: 'workos', id: USER_ID, raw: `workos:${USER_ID}` },
      email: 'a@b.test',
      name: 'Ada L',
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.workos.com/user_management/authenticate')
    expect(JSON.parse(String(init.body))).toMatchObject({
      client_id: 'client_123',
      client_secret: 'sk_test_abc',
      grant_type: 'authorization_code',
      code: 'code-1',
    })
  })

  it('maps a 4xx to code_invalid and a 5xx/network failure to provider_unavailable', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_grant' }))
    expect(await exchangeWorkosCode('bad')).toEqual({ ok: false, error: 'code_invalid' })
    fetchMock.mockResolvedValueOnce(jsonResponse(503, {}))
    expect(await exchangeWorkosCode('x')).toEqual({ ok: false, error: 'provider_unavailable' })
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'))
    expect(await exchangeWorkosCode('x')).toEqual({ ok: false, error: 'provider_unavailable' })
  })

  it('rejects a user id that does not match the workos: contract', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { user: { id: 'user_lowercase' } }))
    expect(await exchangeWorkosCode('x')).toEqual({ ok: false, error: 'bad_subject' })
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { user: {} }))
    expect(await exchangeWorkosCode('x')).toEqual({ ok: false, error: 'bad_subject' })
  })
})
