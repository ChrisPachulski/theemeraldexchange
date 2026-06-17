// Unit tests for the shared device-pair mint branch. mintDeviceToken +
// ensureServerId touch the device key + device_tokens DB, so they are mocked
// here — this file tests the BRANCHING (cookie vs device vs partial-400) and
// the wire shape, not the JWE crypto (covered by the device-token vectors).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const mintDeviceToken = vi.fn(async (_input: unknown) => 'minted.jwe.token')
const ensureServerId = vi.fn((): string => 'server-uuid-123')
vi.mock('../session.js', () => ({
  mintDeviceToken: (input: unknown) => mintDeviceToken(input),
  ensureServerId: () => ensureServerId(),
}))

import { maybeMintDeviceToken, type DevicePairIdentity } from './devicePair.js'

const IDENTITY: DevicePairIdentity = {
  sub: 'apple:000000.0123456789abcdef0123456789abcdef.0000',
  role: 'user',
  auth_mode: 'apple',
  username: 'mom',
}

/** Tiny harness: a route that runs the helper and, on cookie/browser mode
 *  (null), falls through to a sentinel so the test can tell the two apart. */
function appFor(body: unknown, identity: DevicePairIdentity = IDENTITY) {
  const a = new Hono()
  a.post('/t', async (c) => {
    const res = await maybeMintDeviceToken(c, body, identity)
    return res ?? c.json({ fell_through: true })
  })
  return a
}

beforeEach(() => {
  mintDeviceToken.mockClear()
  ensureServerId.mockClear()
})

const post = (body: unknown) =>
  appFor(body).request('/t', { method: 'POST' })

describe('maybeMintDeviceToken', () => {
  it('returns null (cookie/browser mode) when no device fields are present', async () => {
    const r = await post({ identityToken: 'x', inviteCode: 'y' })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ fell_through: true })
    expect(mintDeviceToken).not.toHaveBeenCalled()
  })

  it('400s a partial device triple (client bug, never a silent cookie)', async () => {
    const r = await post({ device_id: 'abc' }) // missing name + platform
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: 'incomplete_device_fields' })
    expect(mintDeviceToken).not.toHaveBeenCalled()
  })

  it('mints a device token and returns the device.ts wire shape on a full triple', async () => {
    const r = await post({
      device_id: 'DEV1',
      device_name: "Mom's iPhone",
      device_platform: 'ios',
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      status: 'authorized',
      token: 'minted.jwe.token',
      server_id: 'server-uuid-123',
      user: { sub: IDENTITY.sub, username: 'mom', role: 'user' },
    })
    expect(mintDeviceToken).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: IDENTITY.sub,
        role: 'user',
        auth_mode: 'apple',
        device_id: 'DEV1',
        device_name: "Mom's iPhone",
        device_platform: 'ios',
        username: 'mom',
        server_id: 'server-uuid-123',
      }),
    )
  })

  it('trims whitespace and rejects an all-whitespace field as absent', async () => {
    // device_name is whitespace-only → treated as absent → partial triple.
    const r = await post({ device_id: 'DEV1', device_name: '   ', device_platform: 'ios' })
    expect(r.status).toBe(400)
    expect(mintDeviceToken).not.toHaveBeenCalled()
  })
})
