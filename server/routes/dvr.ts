// DVR API (M6 — DVR bucket, phase 1).
//
// Schedule / list / cancel recordings of IPTV live channels. The recorder
// engine that actually spawns ffmpeg and serves completed files is phase 2;
// this router is mounted only when env.DVR_ENABLED is set, so a half-feature
// (a scheduler that records nothing yet) is never exposed by default.

import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { Hono, type Context, type Next } from 'hono'
import { requireAuth, requireAdmin, type Env } from '../middleware/auth.js'
import { env } from '../env.js'
import { iptvDb } from '../services/iptvDbSingleton.js'
import { signStreamToken, verifyStreamToken, type StreamKind } from '../services/iptvStreamToken.js'
import {
  validateNewRecording,
  scheduleRecording,
  listRecordings,
  getRecording,
  cancelRecording,
  type NewRecordingInput,
} from '../services/dvrRecordings.js'

export const dvr = new Hono<Env>()

// The DVR play token's kind. `'recording'` is the M6-reserved StreamKind that
// verifiers already accept cross-language (see iptvStreamToken.ts §5.3) — this
// is the first path to actually MINT it. Bound to a single recording id + sub
// like the VOD idiom in routes/iptv.ts.
const RECORDING_KIND: StreamKind = 'recording'

// The stream token's `rid` for a recording — the bare recording id, mirroring
// the VOD grant which binds to the bare streamId. Kind (`recording`) already
// disambiguates it from any other token class, and rid pins it to this one file.
function recordingResourceId(id: string): string {
  return id
}

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

// Mint a playback grant for a completed recording (S7). Cookie/bearer authed —
// the caller must already be a logged-in member. Returns a `recording`-kind
// stream token bound to this recording id + the caller's sub, on the cookieless
// `?t=` play URL a device-token (tvOS/iOS) client can load. Mirrors the VOD
// grant idiom in routes/iptv.ts: a finite-asset TTL (the on-demand TTL, ~6h —
// NOT the 300s live TTL), so re-presenting the token on every range GET across
// the whole recording never expires mid-playback.
dvr.post('/recordings/:id/grant', requireAuth, (c) => {
  const id = c.req.param('id')
  const rec = getRecording(iptvDb().raw, id)
  if (!rec) return c.json({ error: 'not_found' }, 404)
  // Only a completed recording with a materialized file is playable — don't
  // hand out a token that can only 404, mirroring the play route's own gate.
  if (rec.status !== 'completed' || !rec.file_path) {
    return c.json({ error: 'not_ready' }, 404)
  }
  const { sub } = c.get('session')
  const token = signStreamToken(env.streamTokenSecret, {
    kind: RECORDING_KIND,
    resourceId: recordingResourceId(id),
    sub,
    ttlSecs: env.IPTV_ONDEMAND_TOKEN_TTL_SECS,
  })
  return c.json({
    url: `/api/dvr/recordings/${id}/play?t=${token}`,
    delivery: 'progressive',
    mime: 'video/mp2t',
  })
})

// Auth gate for the play route: accept a `?t=` recording stream token (bound to
// this exact recording id) so a cookieless device-token client can play; any
// tokenless request falls back to the session cookie/bearer. Mirrors the
// `mediaAuth` seam in routes/media.ts (which does the same for /stream/*).
async function dvrPlayAuth(c: Context<Env>, next: Next) {
  const token = c.req.query('t')
  if (token) {
    const id = c.req.param('id')
    let claims: ReturnType<typeof verifyStreamToken>
    try {
      claims = verifyStreamToken(env.streamTokenSecret, token)
    } catch (err) {
      return c.json({ error: 'invalid_token', detail: err instanceof Error ? err.message : String(err) }, 401)
    }
    // Kind + rid must both match: a token for another kind or another recording
    // must not unlock this file (no replay tracking — a recording token is
    // re-presented on every range GET, exactly like the VOD path).
    if (claims.k !== RECORDING_KIND || claims.rid !== recordingResourceId(id)) {
      return c.json({ error: 'token_mismatch' }, 401)
    }
    c.set('session', { sub: claims.sub, username: '', role: 'user' })
    return next()
  }
  return requireAuth(c, next)
}

// Play back a completed recording (range-serve the local .ts). Accepts either a
// session cookie/bearer OR a cookieless `?t=` recording stream token (S7), so a
// device-token tvOS/iOS client — which never holds a cookie — can play.
dvr.get('/recordings/:id/play', dvrPlayAuth, (c) => {
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
