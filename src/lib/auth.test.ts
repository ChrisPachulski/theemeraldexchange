import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authModeFromUser,
  createInvite,
  deniedMessage,
  listInvites,
  listMembers,
  revokeInvite,
  revokeMember,
} from './auth'
import { ApiError } from './api/errors'

// These cover the non-React surface of auth.tsx: the provider-inference
// and denied-copy helpers, plus the admin allowlist API functions (which
// are plain credentialed fetches). The React context (signIn/appleSignIn)
// is exercised indirectly via the component tests.

function mockFetch(impl: () => Partial<Response> & { json?: () => unknown }) {
  const fn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const r = impl()
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: r.statusText ?? 'OK',
      json: r.json ?? (async () => ({})),
    } as unknown as Response
  })
  vi.stubGlobal('fetch', fn)
  // apiUrl() reads window.location.origin when VITE_API_BASE_URL is empty.
  vi.stubGlobal('window', { location: { origin: 'https://x.test' } })
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('authModeFromUser', () => {
  it('prefers an explicit auth_mode', () => {
    expect(authModeFromUser({ sub: 'plex:1', auth_mode: 'apple' })).toBe('apple')
  })
  it('infers apple from the sub prefix when auth_mode is absent', () => {
    expect(authModeFromUser({ sub: 'apple:000000.deadbeef.0000' })).toBe('apple')
  })
  it('infers local from the sub prefix', () => {
    expect(authModeFromUser({ sub: 'local:dev' })).toBe('local')
  })
  it('defaults to plex for an unprefixed/plex sub', () => {
    expect(authModeFromUser({ sub: 'plex:42' })).toBe('plex')
  })
})

describe('deniedMessage', () => {
  it('maps no_invite to the invitation-only copy', () => {
    expect(deniedMessage('no_invite')).toMatch(/invitation-only/i)
  })
  it('maps not_authorized to the same invitation copy', () => {
    expect(deniedMessage('not_authorized')).toMatch(/invite code/i)
  })
  it('keeps the legacy plex-server-member copy', () => {
    expect(deniedMessage('not_a_server_member')).toMatch(/plex server/i)
  })
  it('falls back to a generic message for unknown reasons', () => {
    expect(deniedMessage(undefined)).toBe('Access denied.')
    expect(deniedMessage('something_else')).toBe('Access denied.')
  })
})

describe('admin invite API', () => {
  it('listInvites GETs and unwraps the invites array', async () => {
    const fetchFn = mockFetch(() => ({
      json: async () => ({ invites: [{ code_hash_prefix: 'abcd1234' }] }),
    }))
    const out = await listInvites()
    expect(out).toEqual([{ code_hash_prefix: 'abcd1234' }])
    expect(fetchFn).toHaveBeenCalledWith(
      'https://x.test/api/admin/invites',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('createInvite POSTs the body and returns the one-time code', async () => {
    const fetchFn = mockFetch(() => ({
      status: 201,
      json: async () => ({ code: 'PLAINTEXT-ONCE', code_hash_prefix: 'aa' }),
    }))
    const out = await createInvite({ label: 'Mom', expiresInDays: 14, maxUses: 1 })
    expect(out.code).toBe('PLAINTEXT-ONCE')
    const [, init] = fetchFn.mock.calls[0] as [unknown, RequestInit]
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      label: 'Mom',
      expiresInDays: 14,
      maxUses: 1,
    })
    // Content-Type is set when a body is present.
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    )
  })

  it('revokeInvite DELETEs the prefix-scoped path', async () => {
    const fetchFn = mockFetch(() => ({ json: async () => ({ ok: true }) }))
    await revokeInvite('abcd1234')
    expect(fetchFn).toHaveBeenCalledWith(
      'https://x.test/api/admin/invites/abcd1234',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('listMembers GETs and unwraps the members array', async () => {
    mockFetch(() => ({ json: async () => ({ members: [{ sub: 'apple:1' }] }) }))
    const out = await listMembers()
    expect(out).toEqual([{ sub: 'apple:1' }])
  })

  it('revokeMember url-encodes the namespaced sub', async () => {
    const fetchFn = mockFetch(() => ({ json: async () => ({ ok: true }) }))
    await revokeMember('apple:000000.dead.0000')
    expect(fetchFn).toHaveBeenCalledWith(
      'https://x.test/api/admin/members/apple%3A000000.dead.0000',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('throws an ApiError (admin_only) on a 403', async () => {
    mockFetch(() => ({
      ok: false,
      status: 403,
      json: async () => ({ error: 'forbidden', reason: 'admin_only' }),
    }))
    await expect(listInvites()).rejects.toBeInstanceOf(ApiError)
  })
})
