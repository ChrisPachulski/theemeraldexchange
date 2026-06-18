import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { openIptvDb, type IptvDb } from './iptvDb.js'
import {
  validateNewRecording,
  planTransitions,
  scheduleRecording,
  listRecordings,
  getRecording,
  cancelRecording,
  markStatus,
  type DvrRecording,
  type NewRecordingInput,
} from './dvrRecordings.js'

const NOW = '2026-06-17T12:00:00.000Z'
const validInput: NewRecordingInput = {
  channel_stream_id: 42,
  channel_name: 'BBC One',
  title: 'The News at Ten',
  start_utc: '2026-06-17T13:00:00.000Z',
  stop_utc: '2026-06-17T13:30:00.000Z',
}

describe('validateNewRecording', () => {
  it('accepts a well-formed future recording', () => {
    expect(validateNewRecording(validInput, NOW)).toBeNull()
  })
  it('rejects a non-positive / non-integer channel stream id', () => {
    expect(validateNewRecording({ ...validInput, channel_stream_id: 0 }, NOW)).toBe('invalid_channel')
    expect(validateNewRecording({ ...validInput, channel_stream_id: 1.5 }, NOW)).toBe('invalid_channel')
  })
  it('rejects missing channel name / title', () => {
    expect(validateNewRecording({ ...validInput, channel_name: '  ' }, NOW)).toBe('missing_channel_name')
    expect(validateNewRecording({ ...validInput, title: '' }, NOW)).toBe('missing_title')
  })
  it('rejects unparseable / inverted / past windows', () => {
    expect(validateNewRecording({ ...validInput, start_utc: 'nope' }, NOW)).toBe('invalid_time')
    expect(
      validateNewRecording({ ...validInput, start_utc: validInput.stop_utc, stop_utc: validInput.start_utc }, NOW),
    ).toBe('stop_before_start')
    expect(
      validateNewRecording(
        { ...validInput, start_utc: '2026-06-17T10:00:00.000Z', stop_utc: '2026-06-17T11:00:00.000Z' },
        NOW,
      ),
    ).toBe('already_ended')
  })
})

describe('planTransitions', () => {
  const row = (over: Partial<DvrRecording>): DvrRecording => ({
    id: 'r',
    channel_stream_id: 42,
    channel_name: 'c',
    title: 't',
    start_utc: '2026-06-17T11:00:00.000Z',
    stop_utc: '2026-06-17T13:00:00.000Z',
    status: 'scheduled',
    file_path: null,
    error: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  })

  it('starts a scheduled row whose window is open now', () => {
    const plan = planTransitions(NOW, [row({ id: 'a', status: 'scheduled' })]) // 11:00<=12:00<13:00
    expect(plan.toStart.map((r) => r.id)).toEqual(['a'])
    expect(plan.toStop).toHaveLength(0)
    expect(plan.toMiss).toHaveLength(0)
  })
  it('does not start a scheduled row whose window is still in the future', () => {
    const plan = planTransitions(NOW, [
      row({ id: 'b', start_utc: '2026-06-17T14:00:00.000Z', stop_utc: '2026-06-17T15:00:00.000Z' }),
    ])
    expect(plan.toStart).toHaveLength(0)
    expect(plan.toMiss).toHaveLength(0)
  })
  it('stops a recording row whose window has closed', () => {
    const plan = planTransitions(NOW, [
      row({ id: 'c', status: 'recording', start_utc: '2026-06-17T10:00:00.000Z', stop_utc: '2026-06-17T11:30:00.000Z' }),
    ])
    expect(plan.toStop.map((r) => r.id)).toEqual(['c'])
  })
  it('marks a scheduled row missed when its window fully elapsed unstarted', () => {
    const plan = planTransitions(NOW, [
      row({ id: 'd', start_utc: '2026-06-17T09:00:00.000Z', stop_utc: '2026-06-17T10:00:00.000Z' }),
    ])
    expect(plan.toMiss.map((r) => r.id)).toEqual(['d'])
    expect(plan.toStart).toHaveLength(0)
  })
  it('ignores terminal rows', () => {
    const plan = planTransitions(NOW, [
      row({ id: 'e', status: 'completed' }),
      row({ id: 'f', status: 'cancelled' }),
    ])
    expect(plan.toStart).toHaveLength(0)
    expect(plan.toStop).toHaveLength(0)
    expect(plan.toMiss).toHaveLength(0)
  })
})

describe('dvr CRUD (temp iptv DB)', () => {
  let tmpDir: string
  let db: IptvDb
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-'))
    db = openIptvDb(path.join(tmpDir, 'iptv.db')) // openIptvDb migrates at construction
  })
  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('schedules, lists, fetches, and round-trips a recording', () => {
    const rec = scheduleRecording(db.raw, validInput, NOW)
    expect(rec.status).toBe('scheduled')
    expect(rec.channel_stream_id).toBe(42)
    expect(rec.file_path).toBeNull()

    expect(listRecordings(db.raw).map((r) => r.id)).toEqual([rec.id])
    expect(getRecording(db.raw, rec.id)?.title).toBe('The News at Ten')
    expect(getRecording(db.raw, 'missing')).toBeNull()
  })

  it('cancels a scheduled recording, deletes a terminal one, 404s unknown', () => {
    const rec = scheduleRecording(db.raw, validInput, NOW)
    expect(cancelRecording(db.raw, rec.id, NOW)).toBe('cancelled')
    expect(getRecording(db.raw, rec.id)?.status).toBe('cancelled')

    const done = scheduleRecording(db.raw, validInput, NOW)
    markStatus(db.raw, done.id, 'completed', { file_path: '/rec/x.ts' }, NOW)
    expect(getRecording(db.raw, done.id)?.file_path).toBe('/rec/x.ts')
    expect(cancelRecording(db.raw, done.id, NOW)).toBe('deleted')
    expect(getRecording(db.raw, done.id)).toBeNull()

    expect(cancelRecording(db.raw, 'nope', NOW)).toBeNull()
  })
})
