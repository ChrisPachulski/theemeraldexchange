import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

// Stand up SERVER_DB_PATH BEFORE importing the route so serverDb.ts (which
// ensureServerId() reaches through) sees a fresh tmpdir-backed DB. Mirrors the
// device.test.ts setup pattern.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eex-version-test-'))
process.env.SERVER_DB_PATH = path.join(tmpDir, 'server.db')

const { version } = await import('./version.js')
const { closeServerDb } = await import('../services/serverDb.js')

type VersionBody = {
  server_id: string
  version: string
  apiVersion: string
  release: string
  auth_modes: string[]
  accepting_device_pairs: boolean
}

const SEMVER = /^\d+\.\d+\.\d+(?:[-+].*)?$/

describe('GET /api/version', () => {
  afterEach(() => {
    closeServerDb()
  })

  it('emits a plain-semver version field for the contract §12 gate', async () => {
    const app = new Hono().route('/api/version', version)
    const res = await app.request('/api/version')
    expect(res.status).toBe(200)
    const body = (await res.json()) as VersionBody

    // The min-server-version gate compares this with semver semantics, so it
    // MUST be a valid x.y.z core — never a git SHA or 'dev'.
    expect(typeof body.version).toBe('string')
    expect(body.version).toMatch(SEMVER)
  })

  it('exposes apiVersion as an alias of version', async () => {
    const app = new Hono().route('/api/version', version)
    const res = await app.request('/api/version')
    const body = (await res.json()) as VersionBody

    expect(body.apiVersion).toBe(body.version)
    expect(body.apiVersion).toMatch(SEMVER)
  })

  it('keeps the existing discovery fields intact (additive change)', async () => {
    const app = new Hono().route('/api/version', version)
    const res = await app.request('/api/version')
    const body = (await res.json()) as VersionBody

    expect(typeof body.server_id).toBe('string')
    expect(body.server_id.length).toBeGreaterThan(0)
    expect(typeof body.release).toBe('string')
    expect(body.auth_modes).toContain('plex')
    expect(typeof body.accepting_device_pairs).toBe('boolean')
  })

  it('release (build id) and version (semver) are distinct fields', async () => {
    const app = new Hono().route('/api/version', version)
    const res = await app.request('/api/version')
    const body = (await res.json()) as VersionBody

    // release may be a SHA/'dev'; version must be semver. They are surfaced
    // separately so the Apple client never tries to semver-compare a SHA.
    expect(body).toHaveProperty('release')
    expect(body).toHaveProperty('version')
  })
})
