// DVR API (M6 — DVR bucket, phase 1).
//
// Schedule / list / cancel recordings of IPTV live channels. The recorder
// engine that actually spawns ffmpeg and serves completed files is phase 2;
// this router is mounted only when env.DVR_ENABLED is set, so a half-feature
// (a scheduler that records nothing yet) is never exposed by default.

import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { requireAuth, requireAdmin, type Env } from '../middleware/auth.js'
import { iptvDb } from '../services/iptvDbSingleton.js'
import {
  validateNewRecording,
  scheduleRecording,
  listRecordings,
  getRecording,
  cancelRecording,
  type NewRecordingInput,
} from '../services/dvrRecordings.js'

export const dvr = new Hono<Env>()

// Schedule a recording. Admin-gated (mutates the DVR queue + will consume disk).
dvr.post('/recordings', requireAdmin, async (c) => {
  let body: Partial<NewRecordingInput>
  try {
    body = (await c.req.json()) as Partial<NewRecordingInput>
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  const input: NewRecordingInput = {
    channel_stream_id: Number(body.channel_stream_id),
    channel_name: String(body.channel_name ?? ''),
    title: String(body.title ?? ''),
    start_utc: String(body.start_utc ?? ''),
    stop_utc: String(body.stop_utc ?? ''),
  }
  const err = validateNewRecording(input, new Date().toISOString())
  if (err) return c.json({ error: err }, 400)
  const recording = scheduleRecording(iptvDb().raw, input)
  return c.json({ recording }, 201)
})

// List all recordings (newest scheduled first).
dvr.get('/recordings', requireAuth, (c) => {
  return c.json({ recordings: listRecordings(iptvDb().raw) })
})

// One recording by id.
dvr.get('/recordings/:id', requireAuth, (c) => {
  const recording = getRecording(iptvDb().raw, c.req.param('id'))
  if (!recording) return c.json({ error: 'not_found' }, 404)
  return c.json({ recording })
})

// Cancel a scheduled/in-flight recording, or delete a terminal one.
dvr.delete('/recordings/:id', requireAdmin, (c) => {
  const outcome = cancelRecording(iptvDb().raw, c.req.param('id'))
  if (!outcome) return c.json({ error: 'not_found' }, 404)
  return c.json({ status: outcome })
})

// Play back a completed recording (range-serve the local .ts). requireAuth for
// now; a cookieless stream-token path (the reserved 'recording' StreamKind) is
// the follow-up when the DVR player UI lands.
dvr.get('/recordings/:id/play', requireAuth, (c) => {
  const rec = getRecording(iptvDb().raw, c.req.param('id'))
  if (!rec || rec.status !== 'completed' || !rec.file_path) {
    return c.json({ error: 'not_ready' }, 404)
  }
  let size: number
  try {
    size = statSync(rec.file_path).size
  } catch {
    return c.json({ error: 'file_missing' }, 404)
  }
  const base = { 'Content-Type': 'video/mp2t', 'Accept-Ranges': 'bytes' }
  const range = c.req.header('range')
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null
  if (m) {
    const start = m[1] ? parseInt(m[1], 10) : 0
    const end = m[2] ? parseInt(m[2], 10) : size - 1
    if (Number.isNaN(start) || start > end || end >= size) {
      return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } })
    }
    const body = Readable.toWeb(createReadStream(rec.file_path, { start, end })) as ReadableStream
    return new Response(body, {
      status: 206,
      headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
    })
  }
  const body = Readable.toWeb(createReadStream(rec.file_path)) as ReadableStream
  return new Response(body, { status: 200, headers: { ...base, 'Content-Length': String(size) } })
})
