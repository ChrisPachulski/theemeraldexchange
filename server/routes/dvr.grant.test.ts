import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Mutable auth posture so a single file can exercise BOTH the grant path (a
// logged-in member mints a token) and the cookieless device-token play path
// (requireAuth would reject — only the `?t=` recording token unlocks the file).
type MockCtx = {
  set: (k: string, v: unknown) => void
  json: (b: unknown, s?: number) => unknown
}
const authState = vi.hoisted(() => ({ reject: false, sub: 'plex:42' }))
vi.mock('../middleware/auth.js', () => {
  const gate = (role: 'user' | 'admin') => (c: MockCtx, next: () => unknown) => {
    if (authState.reject) return c.json({ error: 'unauthorized' }, 401)
    c.set('session', { sub: authState.sub, username: 'u', role })
    return next()
  }
  return { requireAuth: gate('user'), requireAdmin: gate('admin') }
})

const dbHolder = vi.hoisted(() => ({ raw: null as unknown }))
vi.mock('../services/iptvDbSingleton.js', () => ({ iptvDb: () => dbHolder }))

import { env } from '../env.js'
import { openIptvDb, type IptvDb } from '../services/iptvDb.js'
import { scheduleRecording, markStatus } from '../services/dvrRecordings.js'
import { signStreamToken, verifyStreamToken, type StreamKind } from '../services/iptvStreamToken.js'
import { dvr } from './dvr.js'

const validBody = {
  channel_stream_id: 42,
  channel_name: 'BBC One',
  title: 'News',
  start_utc: '2099-01-01T10:00:00.000Z',
  stop_utc: '2099-01-01T11:00:00.000Z',
}

// Mint a stream token directly (as the grant endpoint would) so the play-path
// tests don't depend on the grant endpoint's own auth posture.
function mintToken(kind: StreamKind, rid: string, ttlSecs = 60): string {
  return signStreamToken(env.streamTokenSecret, { kind, resourceId: rid, sub: 'plex:42', ttlSecs })
}

describe('dvr recording playback grant (S7)', () => {
  let tmpDir: string
  let db: IptvDb
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-grant-'))
    db = openIptvDb(path.join(tmpDir, 'iptv.db'))
    dbHolder.raw = db.raw
    authState.reject = false
    authState.sub = 'plex:42'
  })
  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // Schedule → mark completed against a real on-disk file.
  function completedRecording(bytes = 1000): { id: string; file: string } {
    const file = path.join(tmpDir, 'rec.ts')
    fs.writeFileSync(file, Buffer.alloc(bytes, 1))
    const r = scheduleRecording(db.raw, validBody)
    markStatus(db.raw, r.id, 'completed', { file_path: file })
    return { id: r.id, file }
  }

  it('grant mints a recording-kind token bound to the id + caller sub', async () => {
    const { id } = completedRecording()
    const res = await dvr.request(`/recordings/${id}/grant`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { url: string; delivery: string; mime: string }
    expect(body.delivery).toBe('progressive')
    expect(body.mime).toBe('video/mp2t')
    expect(body.url).toMatch(new RegExp(`^/api/dvr/recordings/${id}/play\\?t=.+`))

    const token = new URL(`http://x${body.url}`).searchParams.get('t')!
    const claims = verifyStreamToken(env.streamTokenSecret, token)
    expect(claims.k).toBe('recording')
    expect(claims.rid).toBe(id)
    expect(claims.sub).toBe('plex:42')
    // Finite-asset TTL (on-demand ~6h), NOT the 300s live TTL.
    expect(claims.exp - claims.iat).toBe(env.IPTV_ONDEMAND_TOKEN_TTL_SECS)
    expect(claims.exp - claims.iat).toBeGreaterThan(300)
  })

  it('grant 404s a missing or not-yet-completed recording', async () => {
    const missing = await dvr.request('/recordings/nope/grant', { method: 'POST' })
    expect(missing.status).toBe(404)

    const r = scheduleRecording(db.raw, validBody) // still 'scheduled'
    const notReady = await dvr.request(`/recordings/${r.id}/grant`, { method: 'POST' })
    expect(notReady.status).toBe(404)
    expect(((await notReady.json()) as { error: string }).error).toBe('not_ready')
  })

  it('play accepts a cookieless recording token and range-serves (401 without one)', async () => {
    const { id } = completedRecording(1000)
    // Simulate a device-token client that holds NO session cookie.
    authState.reject = true

    // Tokenless → the cookie/bearer fallback rejects (the pre-S7 behavior).
    const noTok = await dvr.request(`/recordings/${id}/play`)
    expect(noTok.status).toBe(401)

    // A valid recording token unlocks the file with no cookie.
    const token = mintToken('recording', id)
    const full = await dvr.request(`/recordings/${id}/play?t=${token}`)
    expect(full.status).toBe(200)
    expect(full.headers.get('content-length')).toBe('1000')
    expect(full.headers.get('accept-ranges')).toBe('bytes')

    const ranged = await dvr.request(`/recordings/${id}/play?t=${token}`, {
      headers: { range: 'bytes=0-99' },
    })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe('bytes 0-99/1000')
    expect(ranged.headers.get('content-length')).toBe('100')
  })

  it('play rejects a token minted for a different recording or a different kind', async () => {
    const { id } = completedRecording()
    authState.reject = true

    const otherId = await dvr.request(
      `/recordings/${id}/play?t=${mintToken('recording', 'some-other-id')}`,
    )
    expect(otherId.status).toBe(401)
    expect(((await otherId.json()) as { error: string }).error).toBe('token_mismatch')

    // A VOD-kind token bound to the same rid must not unlock a recording.
    const wrongKind = await dvr.request(`/recordings/${id}/play?t=${mintToken('vod', id)}`)
    expect(wrongKind.status).toBe(401)
    expect(((await wrongKind.json()) as { error: string }).error).toBe('token_mismatch')
  })

  it('play rejects a malformed token', async () => {
    const { id } = completedRecording()
    authState.reject = true
    const res = await dvr.request(`/recordings/${id}/play?t=not-a-real-token`)
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_token')
  })
})
