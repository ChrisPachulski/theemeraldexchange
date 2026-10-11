import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './errors'
import { dvrApi, dvrPlayError, dvrScheduleError, isAlreadyScheduled, isPlayable, type DvrRecording } from './dvr'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } })
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function rec(over: Partial<DvrRecording> = {}): DvrRecording {
  return {
    id: 'r1',
    channel_stream_id: 7,
    channel_name: 'US ABC',
    title: 'News',
    start_utc: '2026-10-10T20:00:00Z',
    stop_utc: '2026-10-10T21:00:00Z',
    status: 'scheduled',
    file_path: null,
    error: null,
    created_at: '2026-10-10T00:00:00Z',
    updated_at: '2026-10-10T00:00:00Z',
    ...over,
  }
}

const input = { channel_stream_id: 7, channel_name: 'US ABC', title: 'News', start_utc: '2026-10-10T20:00:00Z', stop_utc: '2026-10-10T21:00:00Z' }

describe('isAlreadyScheduled', () => {
  it('matches the same channel/start/stop, ignoring cancelled rows', () => {
    expect(isAlreadyScheduled([rec()], input)).toBe(true)
    expect(isAlreadyScheduled([rec({ status: 'cancelled' })], input)).toBe(false)
    expect(isAlreadyScheduled([rec({ channel_stream_id: 8 })], input)).toBe(false)
    expect(isAlreadyScheduled([rec({ stop_utc: '2026-10-10T21:30:00Z' })], input)).toBe(false)
  })
})

describe('isPlayable', () => {
  it('needs a completed row with a file', () => {
    expect(isPlayable(rec({ status: 'completed', file_path: '/dvr/r1.ts' }))).toBe(true)
    expect(isPlayable(rec({ status: 'completed' }))).toBe(false)
    expect(isPlayable(rec({ status: 'recording', file_path: '/dvr/r1.ts' }))).toBe(false)
  })
})

describe('DVR error messages', () => {
  it('maps schedule failures like the Apple DvrStore', () => {
    expect(dvrScheduleError(new ApiError(400, 'x', 'channel_overlap'))).toMatch(/conflict/)
    expect(dvrScheduleError(new ApiError(409, 'x'))).toMatch(/conflict/)
    expect(dvrScheduleError(new ApiError(403, 'x', 'forbidden'))).toMatch(/admin/)
    expect(dvrScheduleError(new ApiError(404, 'x'))).toMatch(/not enabled/)
    expect(dvrScheduleError(new ApiError(400, 'x', 'already_ended'))).toMatch(/already ended/)
    expect(dvrScheduleError(new Error('net'))).toMatch(/Couldn’t schedule/)
  })

  it('maps play failures', () => {
    expect(dvrPlayError(new ApiError(404, 'x', 'not_ready'))).toMatch(/isn’t ready/)
    expect(dvrPlayError(new ApiError(403, 'x', 'rating_blocked'))).toMatch(/rating limit/)
    expect(dvrPlayError(new Error('net'))).toMatch(/Couldn’t start/)
  })
})

describe('dvrApi', () => {
  it('schedules with the snake_case body the server expects', async () => {
    fetchMock.mockResolvedValueOnce(json({ recording: rec() }, 201))
    await expect(dvrApi.schedule(input)).resolves.toMatchObject({ id: 'r1' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://localhost/api/dvr/recordings')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual(input)
  })

  it('routes a recording grant through mpegts.js with an absolute URL', async () => {
    fetchMock.mockResolvedValueOnce(json({ url: '/api/dvr/recordings/r1/play?t=tok', delivery: 'progressive', mime: 'video/mp2t' }))
    const grant = await dvrApi.grant('r1')
    expect(grant).toMatchObject({ url: 'http://localhost/api/dvr/recordings/r1/play?t=tok', delivery: 'mpegts' })
  })

  it('surfaces the server error code', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'channel_overlap' }, 400))
    await expect(dvrApi.schedule(input)).rejects.toMatchObject({ status: 400, code: 'channel_overlap' })
  })
})
