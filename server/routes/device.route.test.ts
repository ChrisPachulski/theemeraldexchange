import { describe, it, expect, vi, beforeEach } from 'vitest'

// Route-level coverage for the Apple device-pair HTTP handler (POST /poll).
// Mock every upstream dep with vi.hoisted + vi.mock so the tests
// exercise ROUTE ORCHESTRATION only — body-limit parsing, the five field
// validations, the body-too-large guard, and the pending/denied/authorized
// branches. Most important is the security-critical authZ gate: a denied
// member must NEVER reach mintDeviceToken (the regression device.ts documents).
//
// Lives in a SEPARATE file from device.test.ts so the session-unit suite keeps
// using the REAL session.js import — these mock factories would otherwise
// collide with that suite's module graph.

// vi.mock is hoisted above imports and top-level consts, so the factory may not
// close over ordinary module-scope variables. vi.hoisted runs WITH the hoist,
// so these handles are initialized before the mocks reference them.
const plex = vi.hoisted(() => ({
  buildAuthUrl: vi.fn(),
  checkPin: vi.fn(),
  createPin: vi.fn(),
  getUser: vi.fn(),
}))
vi.mock('../plex.js', () => plex)

const { authorizeOrRedeem, enforceAuthRateLimit } = vi.hoisted(() => ({
  authorizeOrRedeem: vi.fn(),
  // Default: never rate-limited (returns null). Individual tests can override.
  enforceAuthRateLimit: vi.fn(() => null),
}))
vi.mock('../auth.js', () => ({ authorizeOrRedeem, enforceAuthRateLimit }))

const { roleFor } = vi.hoisted(() => ({ roleFor: vi.fn() }))
vi.mock('../services/sessionGate.js', () => ({ roleFor }))

// AuthMode/Role are TYPES — erased at runtime, so a value-only factory is fine;
// do not export them from the mock.
const session = vi.hoisted(() => ({ mintDeviceToken: vi.fn(), ensureServerId: vi.fn() }))
vi.mock('../session.js', () => session)

import { device } from './device.js'

function post(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return device.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

// Full body that PASSES every /poll validation — reuse for branch tests.
const validPoll = {
  pinId: 7,
  device_id: 'dev-1',
  device_name: 'Living Room',
  device_platform: 'tvos',
}

beforeEach(() => {
  vi.clearAllMocks()
})

// NOTE: POST /start was intentionally removed (commit b1fa1d3) — a server-side
// createPin made plex.tv attribute the request to the NAS's public IP, leaking
// the host's home location. PIN creation now happens on the device. Its former
// test lived here and is deleted along with the route.

describe('device POST /poll — validation', () => {
  it('400 missing_pinId when pinId absent', async () => {
    const res = await post('/poll', { device_id: 'd', device_name: 'n', device_platform: 'p' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'missing_pinId' })
    expect(plex.checkPin).not.toHaveBeenCalled()
  })

  it('400 bad_pinId when pinId is non-integer', async () => {
    const res = await post('/poll', { ...validPoll, pinId: 'abc' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad_pinId' })
    expect(plex.checkPin).not.toHaveBeenCalled()
  })

  it('400 missing_device_id when device_id absent', async () => {
    const res = await post('/poll', { pinId: 7, device_name: 'n', device_platform: 'p' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'missing_device_id' })
    expect(plex.checkPin).not.toHaveBeenCalled()
  })

  it('400 missing_device_name when device_name absent', async () => {
    const res = await post('/poll', { pinId: 7, device_id: 'd', device_platform: 'p' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'missing_device_name' })
    expect(plex.checkPin).not.toHaveBeenCalled()
  })

  it('400 missing_device_platform when device_platform absent', async () => {
    const res = await post('/poll', { pinId: 7, device_id: 'd', device_name: 'n' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'missing_device_platform' })
    expect(plex.checkPin).not.toHaveBeenCalled()
  })
})

describe('device POST /poll — body size guard', () => {
  it('413 body_too_large when content-length exceeds the cap', async () => {
    const res = await post(
      '/poll',
      { pinId: 1, x: 'a'.repeat(3000) },
      { 'content-length': '99999' },
    )
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'body_too_large' })
    expect(plex.checkPin).not.toHaveBeenCalled()
  })
})

describe('device POST /poll — pin lifecycle', () => {
  it('200 pending when the pin has no authToken yet', async () => {
    plex.checkPin.mockResolvedValue({ authToken: null })
    const res = await post('/poll', validPoll)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'pending' })
    expect(plex.getUser).not.toHaveBeenCalled()
  })

  it('403 denied — authZ gate blocks an uninvited member and mints NO token', async () => {
    plex.checkPin.mockResolvedValue({ authToken: 'tok' })
    plex.getUser.mockResolvedValue({ id: 777, username: 'mallory' })
    authorizeOrRedeem.mockReturnValue({ allowed: false })

    const res = await post('/poll', validPoll)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ status: 'denied', reason: 'no_invite' })
    // The regression device.ts documents: an unauthorized member must never
    // get a device token minted.
    expect(session.mintDeviceToken).not.toHaveBeenCalled()
  })

  it('200 authorized — happy path mints token and returns identity', async () => {
    plex.checkPin.mockResolvedValue({ authToken: 'tok' })
    plex.getUser.mockResolvedValue({ id: 12345, username: 'chris' })
    authorizeOrRedeem.mockReturnValue({ allowed: true })
    roleFor.mockReturnValue('user')
    session.ensureServerId.mockReturnValue('SRV-ID-1')
    session.mintDeviceToken.mockResolvedValue('jwe.token.value')

    const res = await post('/poll', {
      pinId: 7,
      device_id: 'dev-1',
      device_name: 'Living Room',
      device_platform: 'tvos',
      invite_code: 'INV1',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      status: string
      token: string
      server_id: string
      user: { sub: string; username: string; role: string }
    }
    expect(body.status).toBe('authorized')
    expect(body.token).toBe('jwe.token.value')
    expect(body.server_id).toBe('SRV-ID-1')
    expect(body.user.sub).toBe('plex:12345')
    expect(body.user.username).toBe('chris')
    expect(body.user.role).toBe('user')

    expect(authorizeOrRedeem).toHaveBeenCalledWith('plex:12345', 'INV1', 'chris', 'plex')
    expect(session.mintDeviceToken).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'plex:12345', device_id: 'dev-1' }),
    )
  })
})
