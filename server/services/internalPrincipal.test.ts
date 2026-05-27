import { describe, it, expect, beforeEach, afterEach } from 'vitest'

const ORIGINAL_SECRET = process.env.INTERNAL_PRINCIPAL_SECRET

beforeEach(() => {
  process.env.INTERNAL_PRINCIPAL_SECRET =
    'test-internal-principal-secret-which-is-definitely-32-bytes-long-yes-it-is'
})

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.INTERNAL_PRINCIPAL_SECRET
  } else {
    process.env.INTERNAL_PRINCIPAL_SECRET = ORIGINAL_SECRET
  }
})

describe('mintInternalPrincipal', () => {
  it('mints a 5-segment JWE compact-form string', async () => {
    const { mintInternalPrincipal, _resetInternalKeyForTests } = await import(
      './internalPrincipal.js'
    )
    _resetInternalKeyForTests()
    const token = mintInternalPrincipal({
      sub: 'plex:12345',
      role: 'user',
      authMode: 'plex',
      serverId: 'server-uuid-1',
    })
    // JWE compact serialization: header.encryptedKey.iv.ciphertext.tag
    expect(token.split('.').length).toBe(5)
  })

  it('mints distinct tokens on successive calls (jti differs)', async () => {
    const { mintInternalPrincipal, _resetInternalKeyForTests } = await import(
      './internalPrincipal.js'
    )
    _resetInternalKeyForTests()
    const a = mintInternalPrincipal({
      sub: 'plex:12345',
      role: 'user',
      authMode: 'plex',
      serverId: 'server-uuid-1',
    })
    const b = mintInternalPrincipal({
      sub: 'plex:12345',
      role: 'user',
      authMode: 'plex',
      serverId: 'server-uuid-1',
    })
    expect(a).not.toBe(b)
  })

  it('accepts an optional deviceId for Bearer-authed callers', async () => {
    const { mintInternalPrincipal, _resetInternalKeyForTests } = await import(
      './internalPrincipal.js'
    )
    _resetInternalKeyForTests()
    const token = mintInternalPrincipal({
      sub: 'plex:12345',
      role: 'user',
      authMode: 'plex',
      serverId: 'server-uuid-1',
      deviceId: '01HABCDEFGHJKMNPQRSTVWXYZ0',
    })
    expect(token.split('.').length).toBe(5)
  })
})
