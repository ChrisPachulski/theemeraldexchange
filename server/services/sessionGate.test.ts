import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reconcileSession, roleFor, _resetSessionGateCacheForTests, _primeSessionGateCache } from './sessionGate.js'
import type { Session } from '../session.js'

// Mock env BEFORE importing reconcileSession's deps that read it. The
// test env's ADMINS is 'admin-user' (see vitest.config.ts); we also
// need a PLEX_SERVER_ID to enable the membership-check branch.
vi.mock('../env.js', async () => {
  const actual = (await vi.importActual('../env.js')) as { env: Record<string, unknown> }
  return {
    env: {
      ...actual.env,
      admins: ['admin-user'],
      plexServerId: 'home-machine-id',
    },
  }
})

// Mock the Plex probe so tests don't hit the network. We control the
// response per-test via the probeImpl mutable below.
const probeImpl: {
  fn: (token: string) => Promise<unknown>
} = {
  fn: async () => ({ kind: 'network_error' }),
}
vi.mock('../plex.js', () => ({
  probeResources: (token: string, _signal?: AbortSignal) => probeImpl.fn(token),
}))

const baseSession: Session = {
  sub: '42',
  username: 'someone',
  role: 'user',
  plexAuthToken: 'token-xyz',
  verifiedPlexServerId: 'home-machine-id',
}

beforeEach(() => {
  _resetSessionGateCacheForTests()
  probeImpl.fn = async () => ({ kind: 'network_error' })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('roleFor', () => {
  it('promotes a username that matches ADMINS (case-insensitive)', () => {
    expect(roleFor('admin-user')).toBe('admin')
    expect(roleFor('ADMIN-USER')).toBe('admin')
  })
  it('demotes any username not in ADMINS', () => {
    expect(roleFor('someone')).toBe('user')
    expect(roleFor('')).toBe('user')
  })
})

describe('reconcileSession — role recompute', () => {
  it('downgrades a cookie-claimed admin whose username is not in ADMINS', async () => {
    // The cookie can outlive an ADMINS edit; the reconcile must trust
    // env.admins over the stored role claim.
    _primeSessionGateCache(baseSession.sub, 'member', baseSession.plexAuthToken)
    const r = await reconcileSession({ ...baseSession, role: 'admin' })
    expect(r).not.toBeNull()
    expect(r!.role).toBe('user')
  })

  it('upgrades a cookie-claimed user whose username IS in ADMINS', async () => {
    _primeSessionGateCache(baseSession.sub, 'member', baseSession.plexAuthToken)
    const r = await reconcileSession({
      ...baseSession,
      username: 'admin-user',
      role: 'user',
    })
    expect(r).not.toBeNull()
    expect(r!.role).toBe('admin')
  })
})

describe('reconcileSession — membership revalidation', () => {
  it('signs out a user no longer in the configured Plex server', async () => {
    probeImpl.fn = async () => ({
      kind: 'ok',
      resources: [
        // A server, but NOT the one configured. User was removed.
        { name: 'OtherServer', clientIdentifier: 'other-machine-id', owned: true, home: false, provides: 'server' },
      ],
    })
    const r = await reconcileSession(baseSession)
    expect(r).toBeNull()
  })

  it('signs out a user whose plex.tv token was revoked (401)', async () => {
    // Token revocation = definitive sign-out. 401 from plex.tv means
    // the stored authToken no longer works for anything.
    probeImpl.fn = async () => ({ kind: 'http_error', status: 401 })
    const r = await reconcileSession(baseSession)
    expect(r).toBeNull()
  })

  it('does not cache a revoked token as user-wide non-membership', async () => {
    let calls = 0
    probeImpl.fn = async (token: string) => {
      calls++
      if (token === 'revoked-token') return { kind: 'http_error', status: 401 }
      return {
        kind: 'ok',
        resources: [
          {
            name: 'Home',
            clientIdentifier: 'home-machine-id',
            owned: true,
            home: false,
            provides: 'server',
          },
        ],
      }
    }

    expect(await reconcileSession({ ...baseSession, plexAuthToken: 'revoked-token' })).toBeNull()
    const valid = await reconcileSession({ ...baseSession, plexAuthToken: 'fresh-token' })

    expect(valid).not.toBeNull()
    expect(valid!.sub).toBe(baseSession.sub)
    expect(calls).toBe(2)
  })

  it('keeps the user signed in on a plex.tv 5xx (fail open)', async () => {
    probeImpl.fn = async () => ({ kind: 'http_error', status: 503 })
    const r = await reconcileSession(baseSession)
    expect(r).not.toBeNull()
    expect(r!.sub).toBe(baseSession.sub)
  })

  it('keeps the user signed in on a network error (fail open)', async () => {
    probeImpl.fn = async () => ({ kind: 'network_error' })
    const r = await reconcileSession(baseSession)
    expect(r).not.toBeNull()
  })

  it('does not re-hit Plex within the TTL window', async () => {
    let calls = 0
    probeImpl.fn = async () => {
      calls++
      return {
        kind: 'ok',
        resources: [
          {
            name: 'Home',
            clientIdentifier: 'home-machine-id',
            owned: true,
            home: false,
            provides: 'server',
          },
        ],
      }
    }
    await reconcileSession(baseSession)
    await reconcileSession(baseSession)
    await reconcileSession(baseSession)
    expect(calls).toBe(1)
  })

  it('does not authorize a different revoked token from a member cache hit', async () => {
    let calls = 0
    _primeSessionGateCache(baseSession.sub, 'member', 'valid-token')
    probeImpl.fn = async (token: string) => {
      calls++
      if (token === 'revoked-token') return { kind: 'http_error', status: 401 }
      return { kind: 'network_error' }
    }

    const r = await reconcileSession({ ...baseSession, plexAuthToken: 'revoked-token' })

    expect(r).toBeNull()
    expect(calls).toBe(1)
  })

  it('keeps a previously-known not_member status from the cache', async () => {
    // Once we have a definitive not_member answer, subsequent requests
    // within the TTL stay denied without re-hitting plex.tv.
    let calls = 0
    probeImpl.fn = async () => {
      calls++
      return { kind: 'ok', resources: [] } // no server = not_member
    }
    expect(await reconcileSession(baseSession)).toBeNull()
    expect(await reconcileSession(baseSession)).toBeNull()
    expect(calls).toBe(1)
  })

  it('forces re-auth on legacy sessions without plexAuthToken when the gate is configured', async () => {
    // A configured PLEX_SERVER_ID can ONLY be enforced against a
    // session that still carries the Plex token. Without it there is
    // no way to verify the user remains a member — trusting the cookie
    // alone would re-open the revocation window the gate exists to
    // close. Force a re-auth instead.
    let calls = 0
    probeImpl.fn = async () => {
      calls++
      return { kind: 'network_error' }
    }
    const r = await reconcileSession({ ...baseSession, plexAuthToken: undefined })
    expect(r).toBeNull()
    expect(calls).toBe(0)
  })
})
