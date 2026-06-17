import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

// Point the server.db singleton at a throwaway temp file BEFORE env.ts loads
// (same pattern as webauthn.test.ts). serverDb() applies migrations 0002
// (device_tokens) + 0004 (webauthn_challenges).
const { tmpDbDir } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM init
  const nodeFs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM init
  const nodePath = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM init
  const nodeOs = require('node:os') as typeof import('node:os')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'tokensweep-test-'))
  process.env.SERVER_DB_PATH = nodePath.join(dir, 'server.db')
  return { tmpDbDir: dir }
})

import fs from 'node:fs'
import { serverDb, closeServerDb } from './serverDb.js'
import { sweepExpiredAuthRows } from './tokenSweepScheduler.js'

const NOW = '2026-06-17T12:00:00.000Z'
const PAST = '2026-06-17T11:00:00.000Z'
const FUTURE = '2026-06-17T13:00:00.000Z'

function insertDeviceToken(jti: string, expiresAt: string): void {
  serverDb()
    .raw.prepare(
      `INSERT INTO device_tokens
         (jti, sub, device_id, device_name, platform, server_id, issued_at, expires_at)
       VALUES (?, 'plex:1', ?, 'dev', 'ios', 'srv', '2026-01-01T00:00:00.000Z', ?)`,
    )
    .run(jti, `device-${jti}`, expiresAt)
}

function insertChallenge(id: string, expiresAt: string): void {
  serverDb()
    .raw.prepare(
      `INSERT INTO webauthn_challenges
         (challenge_id, challenge, ceremony, pending_sub, pending_handle, created_at, expires_at)
       VALUES (?, 'chal', 'login', NULL, NULL, '2026-01-01T00:00:00.000Z', ?)`,
    )
    .run(id, expiresAt)
}

describe('sweepExpiredAuthRows (LOW-9)', () => {
  beforeAll(() => {
    serverDb() // open + migrate
  })
  afterAll(() => {
    closeServerDb()
    fs.rmSync(tmpDbDir, { recursive: true, force: true })
  })
  beforeEach(() => {
    serverDb().raw.exec('DELETE FROM device_tokens; DELETE FROM webauthn_challenges;')
  })

  it('deletes only rows whose expires_at is before now', () => {
    insertDeviceToken('dead', PAST)
    insertDeviceToken('live', FUTURE)
    insertChallenge('dead-chal', PAST)
    insertChallenge('live-chal', FUTURE)

    const result = sweepExpiredAuthRows(NOW)
    expect(result).toEqual({ deviceTokens: 1, challenges: 1 })

    const dtJtis = serverDb()
      .raw.prepare('SELECT jti FROM device_tokens ORDER BY jti')
      .all()
      .map((r) => (r as { jti: string }).jti)
    expect(dtJtis).toEqual(['live'])

    const chalIds = serverDb()
      .raw.prepare('SELECT challenge_id FROM webauthn_challenges ORDER BY challenge_id')
      .all()
      .map((r) => (r as { challenge_id: string }).challenge_id)
    expect(chalIds).toEqual(['live-chal'])
  })

  it('is a no-op when nothing is expired', () => {
    insertDeviceToken('live', FUTURE)
    insertChallenge('live-chal', FUTURE)
    expect(sweepExpiredAuthRows(NOW)).toEqual({ deviceTokens: 0, challenges: 0 })
  })
})
