import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eex-version-test-'))
const serverDbPath = path.join(tmpDir, 'server.db')
const iptvDbPath = path.join(tmpDir, 'iptv.db')
const exchangeDbPath = path.join(tmpDir, 'exchange.db')
const mediaDbPath = path.join(tmpDir, 'media.db')

process.env.SERVER_DB_PATH = serverDbPath
process.env.IPTV_DB_PATH = iptvDbPath
process.env.RECOMMENDER_DB_PATH = exchangeDbPath
process.env.MEDIA_DB_PATH = mediaDbPath
process.env.EEX_RELEASE = 'test-release'

const { version } = await import('./version.js')
const { closeServerDb } = await import('../services/serverDb.js')

const app = new Hono()
app.route('/api/version', version)

function removeDb(filePath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${filePath}${suffix}`, { force: true })
  }
}

function writeMigratedDb(filePath: string, versions: number[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const db = new Database(filePath)
  try {
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER NOT NULL PRIMARY KEY,
        applied_at TEXT,
        checksum TEXT NOT NULL
      )
    `)
    const insert = db.prepare(
      'INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)',
    )
    for (const version of versions) {
      insert.run(version, '2026-05-31T00:00:00.000Z', `checksum-${version}`)
    }
  } finally {
    db.close()
  }
}

function writeDbWithoutMigrations(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const db = new Database(filePath)
  try {
    db.exec('CREATE TABLE some_table (id INTEGER PRIMARY KEY)')
  } finally {
    db.close()
  }
}

async function getVersion(): Promise<Record<string, unknown>> {
  const res = await app.request('/api/version')
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, unknown>
}

beforeEach(() => {
  closeServerDb()
  removeDb(serverDbPath)
  removeDb(iptvDbPath)
  removeDb(exchangeDbPath)
  removeDb(mediaDbPath)
})

afterEach(() => {
  closeServerDb()
})

afterAll(() => {
  closeServerDb()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('GET /api/version', () => {
  it('reports current schema_migrations versions for iptv, exchange, and media DBs', async () => {
    writeMigratedDb(iptvDbPath, [1, 2, 6])
    writeMigratedDb(exchangeDbPath, [1, 5, 7])
    writeMigratedDb(mediaDbPath, [1, 3])

    const body = await getVersion()

    expect(body).toMatchObject({
      server_id: expect.any(String),
      release: 'test-release',
      auth_modes: ['plex'],
      accepting_device_pairs: true,
      schemas: {
        iptv: { current: 6 },
        exchange: { current: 7 },
        media: { current: 3 },
      },
    })
  })

  it('reports a missing media DB as not present without creating it', async () => {
    writeMigratedDb(iptvDbPath, [6])
    writeMigratedDb(exchangeDbPath, [7])

    const body = await getVersion()

    expect(body.schemas).toMatchObject({
      iptv: { current: 6 },
      exchange: { current: 7 },
      media: { present: false },
    })
    expect(fs.existsSync(mediaDbPath)).toBe(false)
  })

  it('does not crash when an existing DB lacks schema_migrations', async () => {
    writeDbWithoutMigrations(iptvDbPath)
    writeMigratedDb(exchangeDbPath, [7])
    writeMigratedDb(mediaDbPath, [3])

    const body = await getVersion()

    expect(body.schemas).toMatchObject({
      iptv: { current: null },
      exchange: { current: 7 },
      media: { current: 3 },
    })
  })
})
