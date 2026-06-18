import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Pass-through auth so handlers are exercised directly; inject a temp iptv DB.
vi.mock('../middleware/auth.js', () => ({
  requireAuth: async (_c: unknown, next: () => Promise<void>) => next(),
  requireAdmin: async (_c: unknown, next: () => Promise<void>) => next(),
}))
const dbHolder = vi.hoisted(() => ({ raw: null as unknown }))
vi.mock('../services/iptvDbSingleton.js', () => ({ iptvDb: () => dbHolder }))

import { openIptvDb, type IptvDb } from '../services/iptvDb.js'
import { scheduleRecording, markStatus } from '../services/dvrRecordings.js'
import { dvr } from './dvr.js'

const FUTURE_START = '2099-01-01T10:00:00.000Z'
const FUTURE_STOP = '2099-01-01T11:00:00.000Z'
const validBody = {
  channel_stream_id: 42,
  channel_name: 'BBC One',
  title: 'News',
  start_utc: FUTURE_START,
  stop_utc: FUTURE_STOP,
}

describe('dvr routes', () => {
  let tmpDir: string
  let db: IptvDb
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-route-'))
    db = openIptvDb(path.join(tmpDir, 'iptv.db'))
    dbHolder.raw = db.raw
  })
  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const post = (body: unknown) =>
    dvr.request('/recordings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })

  it('POST schedules a valid recording (201)', async () => {
    const res = await post(validBody)
    expect(res.status).toBe(201)
    const json = (await res.json()) as { recording: { status: string; title: string } }
    expect(json.recording.status).toBe('scheduled')
    expect(json.recording.title).toBe('News')
  })

  it('POST rejects an already-ended window (400)', async () => {
    const res = await post({ ...validBody, start_utc: '2000-01-01T00:00:00.000Z', stop_utc: '2000-01-01T01:00:00.000Z' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('already_ended')
  })

  it('POST rejects malformed JSON (400)', async () => {
    const res = await post('{not json')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_json')
  })

  it('GET lists recordings', async () => {
    await post(validBody)
    const res = await dvr.request('/recordings')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { recordings: unknown[] }
    expect(json.recordings).toHaveLength(1)
  })

  it('GET :id returns one or 404', async () => {
    const created = (await (await post(validBody)).json()) as { recording: { id: string } }
    const ok = await dvr.request(`/recordings/${created.recording.id}`)
    expect(ok.status).toBe(200)
    const missing = await dvr.request('/recordings/nope')
    expect(missing.status).toBe(404)
  })

  it('DELETE cancels a scheduled recording / 404s unknown', async () => {
    const created = (await (await post(validBody)).json()) as { recording: { id: string } }
    const del = await dvr.request(`/recordings/${created.recording.id}`, { method: 'DELETE' })
    expect(((await del.json()) as { status: string }).status).toBe('cancelled')
    const gone = await dvr.request('/recordings/nope', { method: 'DELETE' })
    expect(gone.status).toBe(404)
  })

  it('play 404s when not completed or the file is missing', async () => {
    const r = scheduleRecording(db.raw, validBody)
    // still scheduled → not_ready
    expect((await dvr.request(`/recordings/${r.id}/play`)).status).toBe(404)
    // completed but file_path points nowhere → file_missing
    markStatus(db.raw, r.id, 'completed', { file_path: path.join(tmpDir, 'gone.ts') })
    const res = await dvr.request(`/recordings/${r.id}/play`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('file_missing')
  })

  it('play serves the file (200 full, 206 range, 416 unsatisfiable)', async () => {
    const file = path.join(tmpDir, 'rec.ts')
    fs.writeFileSync(file, Buffer.alloc(1000, 1))
    const r = scheduleRecording(db.raw, validBody)
    markStatus(db.raw, r.id, 'completed', { file_path: file })

    const full = await dvr.request(`/recordings/${r.id}/play`)
    expect(full.status).toBe(200)
    expect(full.headers.get('content-length')).toBe('1000')
    expect(full.headers.get('accept-ranges')).toBe('bytes')

    const ranged = await dvr.request(`/recordings/${r.id}/play`, { headers: { range: 'bytes=0-99' } })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe('bytes 0-99/1000')
    expect(ranged.headers.get('content-length')).toBe('100')

    const bad = await dvr.request(`/recordings/${r.id}/play`, { headers: { range: 'bytes=5000-6000' } })
    expect(bad.status).toBe(416)
  })
})
