import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'

const { tmpDbDir } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- hoisted before ESM imports
  const nodeFs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- hoisted before ESM imports
  const nodePath = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- hoisted before ESM imports
  const nodeOs = require('node:os') as typeof import('node:os')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'passkey-atomic-'))
  process.env.SERVER_DB_PATH = nodePath.join(dir, 'server.db')
  process.env.ADMIN_SUBS = 'plex:42'
  return { tmpDbDir: dir }
})

const ceremony = vi.hoisted(() => ({
  verifyRegistration: vi.fn(),
  persistCredential: vi.fn(),
}))
vi.mock('../services/webauthn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/webauthn.js')>()
  return {
    ...actual,
    verifyRegistration: ceremony.verifyRegistration,
    persistCredential: ceremony.persistCredential,
  }
})

const session = vi.hoisted(() => ({ setSessionCookie: vi.fn() }))
vi.mock('../session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session.js')>()
  return { ...actual, setSessionCookie: session.setSessionCookie }
})

const device = vi.hoisted(() => ({ maybeMintDeviceToken: vi.fn() }))
vi.mock('../services/devicePair.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/devicePair.js')>()
  return { ...actual, maybeMintDeviceToken: device.maybeMintDeviceToken }
})

import { passkey } from './passkey.js'
import { issueInvite } from '../services/invites.js'
import { closeServerDb, serverDb } from '../services/serverDb.js'

const ADMIN = 'plex:42'
const SUB = 'local:01ARZ3NDEKTSV4RRFFQ69G5FAV'
const CREDENTIAL = {
  id: 'atomic-credential',
  publicKey: new Uint8Array([1, 2, 3]),
  counter: 0,
  transports: ['internal'],
  backedUp: true,
}

function post(inviteCode: string) {
  return passkey.request('/register/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: 'atomic-challenge',
      response: { id: CREDENTIAL.id },
      inviteCode,
      device_id: 'native-device',
      device_name: 'Phone',
      device_platform: 'ios',
    }),
  })
}

function persistIntoRealDb(
  sub: string,
  credential: typeof CREDENTIAL,
  deviceLabel: string | null,
): void {
  serverDb()
    .raw.prepare(
      `INSERT INTO webauthn_credentials
         (credential_id, sub, public_key, counter, transports, device_label, backed_up, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      credential.id,
      sub,
      Buffer.from(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports),
      deviceLabel,
      credential.backedUp ? 1 : 0,
      new Date().toISOString(),
    )
}

describe('invited passkey registration transaction', () => {
  beforeAll(() => {
    serverDb()
  })

  afterAll(() => {
    closeServerDb()
    fs.rmSync(tmpDbDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    serverDb().raw.exec(
      `DELETE FROM webauthn_credentials;
       DELETE FROM members;
       DELETE FROM invites;
       DELETE FROM server_state WHERE key IN ('setup_token_hash', 'setup_claimed_by');`,
    )
    vi.clearAllMocks()
    ceremony.verifyRegistration.mockResolvedValue({
      sub: SUB,
      handle: 'Atomic user',
      credential: CREDENTIAL,
    })
    ceremony.persistCredential.mockImplementation(persistIntoRealDb)
    session.setSessionCookie.mockResolvedValue(undefined)
    device.maybeMintDeviceToken.mockResolvedValue(null)
  })

  it('rolls back invite redemption when credential persistence fails', async () => {
    const { code } = issueInvite(ADMIN)
    ceremony.persistCredential.mockImplementation(() => {
      throw new Error('injected credential write failure')
    })

    const response = await post(code)
    expect(response.status).toBe(500)
    expect(
      serverDb().raw.prepare(`SELECT 1 FROM members WHERE sub = ?`).get(SUB),
    ).toBeUndefined()
    expect(
      serverDb().raw.prepare(`SELECT used_count FROM invites`).get(),
    ).toEqual({ used_count: 0 })
    expect(
      serverDb().raw.prepare(`SELECT 1 FROM webauthn_credentials`).get(),
    ).toBeUndefined()
    expect(session.setSessionCookie).not.toHaveBeenCalled()
    expect(device.maybeMintDeviceToken).not.toHaveBeenCalled()
  })

  it('commits the member, invite use, and credential before session/device minting', async () => {
    const { code } = issueInvite(ADMIN)

    const response = await post(code)
    expect(response.status).toBe(200)
    expect(serverDb().raw.prepare(`SELECT role FROM members WHERE sub = ?`).get(SUB)).toEqual({
      role: 'user',
    })
    expect(serverDb().raw.prepare(`SELECT used_count FROM invites`).get()).toEqual({
      used_count: 1,
    })
    expect(
      serverDb().raw
        .prepare(`SELECT sub FROM webauthn_credentials WHERE credential_id = ?`)
        .get(CREDENTIAL.id),
    ).toEqual({ sub: SUB })
    expect(device.maybeMintDeviceToken).toHaveBeenCalledTimes(1)
    expect(session.setSessionCookie).toHaveBeenCalledTimes(1)
  })
})
