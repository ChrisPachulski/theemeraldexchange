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
      adminSubs: ['apple:owner-sub'],
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

// Mock cascadeRevokeForSub so the cascade tests can assert calls without
// touching server.db. Default impl is a no-op returning 0 so the other
// reconcileSession tests are unaffected.
const cascadeSpy = vi.fn((_sub: string, _reason: string) => 0)
vi.mock('./reconcileDeviceToken.js', () => ({
  cascadeRevokeForSub: (sub: string, reason: string) => cascadeSpy(sub, reason),
  reconcileDeviceToken: () => null,
  roleFor: () => 'user',
}))

// Mock the members allowlist (sibling-owned module). reconcileSession's
// authZ now consults memberStatus FIRST and treats it as authoritative;
// the per-test memberStatusImpl controls the verdict. Default 'allowed'
// so the legacy Plex-probe tests below stay focused on the probe
// behavior (now demoted to advisory token-liveness).
const memberStatusImpl: { fn: (sub: string) => 'allowed' | 'revoked' | 'not_member' } = {
  fn: () => 'allowed',
}
vi.mock('./membership.js', () => ({
  memberStatus: (sub: string) => memberStatusImpl.fn(sub),
}))

// DB-backed admin (plan 006 Phase 1): reconcileSession honors an active
// members row with role='admin' (the first-owner claim mints one). Default
// null = no row, so every legacy test keeps its roleFor-driven role.
const isMemberImpl: { fn: (sub: string) => { role: 'admin' | 'user' } | null } = {
  fn: () => null,
}
vi.mock('./members.js', () => ({
  isMember: (sub: string) => isMemberImpl.fn(sub),
}))

const baseSession: Session = {
  sub: 'plex:42',
  username: 'someone',
  role: 'user',
  plexAuthToken: 'token-xyz',
  verifiedPlexServerId: 'home-machine-id',
}

beforeEach(() => {
  _resetSessionGateCacheForTests()
  probeImpl.fn = async () => ({ kind: 'network_error' })
  memberStatusImpl.fn = () => 'allowed'
  isMemberImpl.fn = () => null
  cascadeSpy.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DB-backed admin role (plan 006 Phase 1 first-owner claim)', () => {
  it('a local: session with a members-row admin KEEPS admin across reconcile', async () => {
    // The claimed owner: local: sub, not in ADMIN_SUBS/ADMINS, but their
    // claim minted a members row with role='admin'. Without the DB-role
    // check, reconcileSession would demote them to 'user' on their very
    // first protected request.
    isMemberImpl.fn = () => ({ role: 'admin' })
    const s = await reconcileSession({
      sub: 'local:01ARZ3NDEKTSV4RRFFQ69G5FAV',
      username: 'Owner',
      role: 'admin',
      auth_mode: 'local',
    } as Session)
    expect(s).not.toBeNull()
    expect(s?.role).toBe('admin')
  })

  it('a members-row user role does NOT escalate (row must say admin)', async () => {
    isMemberImpl.fn = () => ({ role: 'user' })
    const s = await reconcileSession({
      sub: 'local:01ARZ3NDEKTSV4RRFFQ69G5FAV',
      username: 'admin-user', // ADMINS collision — must still be blocked for local:
      role: 'user',
      auth_mode: 'local',
    } as Session)
    expect(s?.role).toBe('user')
  })

  it('demoting the members row demotes the session on its next request', async () => {
    isMemberImpl.fn = () => null // row deleted/demoted
    const s = await reconcileSession({
      sub: 'local:01ARZ3NDEKTSV4RRFFQ69G5FAV',
      username: 'Owner',
      role: 'admin', // stale cookie claim
      auth_mode: 'local',
    } as Session)
    expect(s?.role).toBe('user')
  })
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
  it('refuses to promote an apple/local identity whose displayName matches ADMINS', () => {
    // Cross-provider escalation guard: Apple displayName is the attacker-chosen
    // email local-part and a passkey handle is self-chosen — neither may match
    // the Plex-username ADMINS list, or any invited apple:/local: user could
    // pick a colliding name and become admin.
    expect(roleFor('admin-user', 'apple:001')).toBe('user')
    expect(roleFor('admin-user', 'local:01HZXABCDEF')).toBe('user')
  })
  it('still promotes a plex (and legacy bare-numeric) identity matching ADMINS', () => {
    expect(roleFor('admin-user', 'plex:42')).toBe('admin')
    expect(roleFor('admin-user', '42')).toBe('admin')
  })
  it('promotes any provider sub listed in ADMIN_SUBS, regardless of username', () => {
    // Owner bootstrap / explicit admin-by-stable-sub works cross-provider and
    // never depends on a guessable username.
    expect(roleFor('not-an-admin-name', 'apple:owner-sub')).toBe('admin')
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

describe('reconcileSession — allowlist authZ (authoritative)', () => {
  it('denies a sub that is not a member regardless of Plex state', async () => {
    memberStatusImpl.fn = () => 'not_member'
    // Even a perfectly-valid Plex membership probe cannot override the
    // allowlist — the members table is the single authZ gate now.
    probeImpl.fn = async () => ({
      kind: 'ok',
      resources: [
        { name: 'Home', clientIdentifier: 'home-machine-id', owned: true, home: false, provides: 'server' },
      ],
    })
    const r = await reconcileSession(baseSession)
    expect(r).toBeNull()
  })

  it('denies a revoked member', async () => {
    memberStatusImpl.fn = () => 'revoked'
    const r = await reconcileSession(baseSession)
    expect(r).toBeNull()
  })

  it('allows an apple member without ever probing plex.tv', async () => {
    memberStatusImpl.fn = () => 'allowed'
    let calls = 0
    probeImpl.fn = async () => {
      calls++
      return { kind: 'network_error' }
    }
    const appleSession: Session = {
      sub: 'apple:000000.0123456789abcdef0123456789abcdef.0000',
      username: 'mom',
      role: 'user',
    }
    const r = await reconcileSession(appleSession)
    expect(r).not.toBeNull()
    expect(r!.sub).toBe(appleSession.sub)
    expect(calls).toBe(0)
  })

  it('allows a plex member; probe demoted to advisory', async () => {
    memberStatusImpl.fn = () => 'allowed'
    probeImpl.fn = async () => ({
      kind: 'ok',
      resources: [
        { name: 'Home', clientIdentifier: 'home-machine-id', owned: true, home: false, provides: 'server' },
      ],
    })
    const r = await reconcileSession(baseSession)
    expect(r).not.toBeNull()
    expect(r!.sub).toBe(baseSession.sub)
  })

  it('keeps a row-backed plex member signed in even when the probe says not_member (advisory)', async () => {
    // A plex.tv not_member no longer overrides the allowlist — only an
    // explicit member revoke or an ADMIN action removes access.
    memberStatusImpl.fn = () => 'allowed'
    probeImpl.fn = async () => ({ kind: 'ok', resources: [] })
    const r = await reconcileSession(baseSession)
    expect(r).not.toBeNull()
    expect(cascadeSpy).not.toHaveBeenCalled()
  })

  it('signs out a plex member whose plex.tv token was revoked (401, token-liveness)', async () => {
    // auth_revoked = the user signed out of plex.tv. The probe is kept
    // as a defense-in-depth token-liveness signal that ALSO drops the
    // session even though the allowlist still lists them.
    memberStatusImpl.fn = () => 'allowed'
    probeImpl.fn = async () => ({ kind: 'http_error', status: 401 })
    const r = await reconcileSession(baseSession)
    expect(r).toBeNull()
  })

  it('keeps a plex member signed in on a plex.tv 5xx (fail open on probe)', async () => {
    memberStatusImpl.fn = () => 'allowed'
    probeImpl.fn = async () => ({ kind: 'http_error', status: 503 })
    const r = await reconcileSession(baseSession)
    expect(r).not.toBeNull()
    expect(r!.sub).toBe(baseSession.sub)
  })

  it('allows a plex member with no plexAuthToken (owner-added, never logged in via Plex)', async () => {
    // No token to probe — the allowlist decision stands. apple: subs and
    // owner-added plex: members hit this path.
    memberStatusImpl.fn = () => 'allowed'
    let calls = 0
    probeImpl.fn = async () => {
      calls++
      return { kind: 'network_error' }
    }
    const r = await reconcileSession({ ...baseSession, plexAuthToken: undefined })
    expect(r).not.toBeNull()
    expect(calls).toBe(0)
  })

  it('does not re-hit Plex within the TTL window for an allowed member', async () => {
    memberStatusImpl.fn = () => 'allowed'
    let calls = 0
    probeImpl.fn = async () => {
      calls++
      return {
        kind: 'ok',
        resources: [
          { name: 'Home', clientIdentifier: 'home-machine-id', owned: true, home: false, provides: 'server' },
        ],
      }
    }
    await reconcileSession(baseSession)
    await reconcileSession(baseSession)
    await reconcileSession(baseSession)
    expect(calls).toBe(1)
  })
})

describe('reconcileSession — cascade device revocation', () => {
  // When the allowlist denies the cookie user (revoked / not a member),
  // every paired Apple device for the same sub must also be revoked so
  // the M2 Bearer path is locked out on its next request. Idempotent.

  it('cascades with not_member reason on a non-member sub', async () => {
    memberStatusImpl.fn = () => 'not_member'
    const r = await reconcileSession(baseSession)
    expect(r).toBeNull()
    expect(cascadeSpy).toHaveBeenCalledTimes(1)
    expect(cascadeSpy).toHaveBeenCalledWith(baseSession.sub, 'not_member')
  })

  it('cascades with member_revoked reason on a revoked member', async () => {
    memberStatusImpl.fn = () => 'revoked'
    const r = await reconcileSession(baseSession)
    expect(r).toBeNull()
    expect(cascadeSpy).toHaveBeenCalledTimes(1)
    expect(cascadeSpy).toHaveBeenCalledWith(baseSession.sub, 'member_revoked')
  })

  it('cascades on a plex.tv auth_revoked (token-liveness) for an allowed member', async () => {
    memberStatusImpl.fn = () => 'allowed'
    probeImpl.fn = async () => ({ kind: 'http_error', status: 401 })
    const r = await reconcileSession(baseSession)
    expect(r).toBeNull()
    expect(cascadeSpy).toHaveBeenCalledTimes(1)
    expect(cascadeSpy).toHaveBeenCalledWith(baseSession.sub, 'plex_auth_revoked')
  })

  it('does NOT cascade on a transient network error for an allowed member', async () => {
    memberStatusImpl.fn = () => 'allowed'
    probeImpl.fn = async () => ({ kind: 'network_error' })
    const r = await reconcileSession(baseSession)
    expect(r).not.toBeNull()
    expect(cascadeSpy).not.toHaveBeenCalled()
  })

  it('does NOT cascade for an allowed apple member (no probe at all)', async () => {
    memberStatusImpl.fn = () => 'allowed'
    const r = await reconcileSession({
      sub: 'apple:000000.0123456789abcdef0123456789abcdef.0000',
      username: 'mom',
      role: 'user',
    })
    expect(r).not.toBeNull()
    expect(cascadeSpy).not.toHaveBeenCalled()
  })

  it('does NOT cascade on a successful plex member verdict', async () => {
    memberStatusImpl.fn = () => 'allowed'
    probeImpl.fn = async () => ({
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
    })
    const r = await reconcileSession(baseSession)
    expect(r).not.toBeNull()
    expect(cascadeSpy).not.toHaveBeenCalled()
  })
})
