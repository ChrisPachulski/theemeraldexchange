// DVR client (server/routes/dvr.ts). Mounted only when /api/limits reports
// dvrEnabled; scheduling and deleting are admin-only server-side.
import { apiUrl } from './base'
import { errorCode, errorStatus, throwApiError } from './errors'
import type { StreamGrant } from './iptv'

export type DvrRecording = {
  id: string
  channel_stream_id: number
  channel_name: string
  title: string
  start_utc: string
  stop_utc: string
  /** scheduled | recording | completed | failed | missed | cancelled */
  status: string
  file_path: string | null
  error: string | null
  created_at: string
  updated_at: string
}

/** POST /api/dvr/recordings body: snake_case, like the server's NewRecordingInput. */
export type DvrScheduleInput = Pick<DvrRecording, 'channel_stream_id' | 'channel_name' | 'title' | 'start_utc' | 'stop_utc'>

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(`/api/dvr${path}`), {
    method,
    credentials: 'include',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  if (!res.ok) await throwApiError(res, `DVR ${path}`)
  return res.json() as Promise<T>
}

export const dvrApi = {
  list: async () => (await call<{ recordings: DvrRecording[] }>('GET', '/recordings')).recordings,
  schedule: async (input: DvrScheduleInput) =>
    (await call<{ recording: DvrRecording }>('POST', '/recordings', input)).recording,
  remove: (id: string) => call<{ status: string }>('DELETE', `/recordings/${encodeURIComponent(id)}`),
  // The grant says progressive video/mp2t, but browsers can't play a raw .ts
  // natively, so it goes through the mpegts.js branch (finite, like catch-up).
  grant: async (id: string): Promise<StreamGrant> => {
    const g = await call<StreamGrant>('POST', `/recordings/${encodeURIComponent(id)}/grant`)
    return { ...g, url: g.url.startsWith('/') ? apiUrl(g.url) : g.url, delivery: 'mpegts' }
  },
}

export const isPlayable = (r: DvrRecording): boolean => r.status === 'completed' && !!r.file_path

export const statusLabel = (status: string): string => status.charAt(0).toUpperCase() + status.slice(1)

/** The same channel/start/stop is already on the recorder. A cancelled row
 *  doesn't count: the server lets that window be scheduled again. */
export function isAlreadyScheduled(recordings: readonly DvrRecording[], input: DvrScheduleInput): boolean {
  return recordings.some(
    (r) =>
      r.status !== 'cancelled' &&
      r.channel_stream_id === input.channel_stream_id &&
      r.start_utc === input.start_utc &&
      r.stop_utc === input.stop_utc,
  )
}

// Apple DvrStore.schedule / GuideScheduleActionState.message. The server
// reports an overlap as 400 channel_overlap; a 409 is the Apple contract's.
export function dvrScheduleError(err: unknown): string {
  const status = errorStatus(err)
  const code = errorCode(err)
  if (status === 409 || code === 'channel_overlap') return 'The recorder reported a scheduling conflict.'
  if (status === 401 || status === 403) return 'Only a household admin can schedule recordings.'
  if (status === 404) return 'DVR is not enabled on this server.'
  if (code === 'already_ended') return 'This programme has already ended.'
  return 'Couldn’t schedule the recording. Try again.'
}

export function dvrPlayError(err: unknown): string {
  if (errorCode(err) === 'rating_blocked') return 'Your profile’s rating limit blocks recorded live TV.'
  if (errorStatus(err) === 404) return 'This recording isn’t ready to play yet.'
  return 'Couldn’t start playback. Try again.'
}
