// DVR API (M6 — DVR bucket, phase 1).
//
// Schedule / list / cancel recordings of IPTV live channels. The recorder
// engine that actually spawns ffmpeg and serves completed files is phase 2;
// this router is mounted only when env.DVR_ENABLED is set, so a half-feature
// (a scheduler that records nothing yet) is never exposed by default.

import { createReadStream, statSync, rmSync } from 'node:fs'
import { Readable } from 'node:stream'
import { Hono, type Context, type Next } from 'hono'
import { requireAuth, requireAdmin, type Env } from '../middleware/auth.js'
import { requireSection } from '../services/userPolicies.js'
import { capBlocksUnrated } from '../services/parentalRating.js'
import { memberStatus } from '../services/membership.js'
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

// The DVR scheduler owns the single FfmpegRecorder (it lives in index.ts,
// created by startDvrScheduler). The DELETE route needs a handle to it to stop
// an in-flight ffmpeg on cancel — without this a cancelled recording keeps
// pulling a hard-capped provider connection and writing the .ts until its
// window ends. index.ts registers the recorder after starting the scheduler;
// null when DVR is disabled or in a unit test that doesn't register one.
type DvrStopper = { stop: (id: string) => void }
let dvrRecorder: DvrStopper | null = null
/** Register (or clear) the live recorder so DELETE can stop an in-flight ffmpeg. */
export function registerDvrRecorder(recorder: DvrStopper | null): void {
  dvrRecorder = recorder
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

// List all recordings (newest scheduled first). DVR content is recorded
// live-TV, so the whole surface belongs to the `live` section: a member whose
// policy denies Live TV must not even browse the recordings (admins exempt),
// matching requireSection semantics on the IPTV grants.
dvr.get('/recordings', requireAuth, requireSection('live'), (c) => {
  return c.json({ recordings: listRecordings(iptvDb().raw) })
})

// One recording by id.
dvr.get('/recordings/:id', requireAuth, requireSection('live'), (c) => {
  const recording = getRecording(iptvDb().raw, c.req.param('id'))
  if (!recording) return c.json({ error: 'not_found' }, 404)
  return c.json({ recording })
})

// Cancel a scheduled/in-flight recording, or delete a terminal one. Both must
// reclaim resources the DB row alone does not: an in-flight cancel has to stop
// ffmpeg (the recorder's exit handler then removes the junk partial), and a
// terminal delete has to remove the completed .ts (otherwise "deleting to free
// space" frees nothing and DVR_DIR grows unbounded).
dvr.delete('/recordings/:id', requireAdmin, (c) => {
  const id = c.req.param('id')
  const rec = getRecording(iptvDb().raw, id)
  if (!rec) return c.json({ error: 'not_found' }, 404)
  const wasRecording = rec.status === 'recording'
  const filePath = rec.file_path
  const outcome = cancelRecording(iptvDb().raw, id)
  if (!outcome) return c.json({ error: 'not_found' }, 404)
  if (wasRecording) {
    // Stop the live ffmpeg NOW (frees the provider connection + slot); its exit
    // handler removes the partial file once the descriptor is released.
    dvrRecorder?.stop(id)
  } else if (outcome === 'deleted' && filePath) {
    // Terminal row deleted → ffmpeg is long gone, so remove the file directly.
    try {
      rmSync(filePath, { force: true })
    } catch {
      // Best-effort: a stranded file is a leak, not a delete failure to report.
    }
  }
  return c.json({ status: outcome })
})

// Mint a playback grant for a completed recording (S7). Cookie/bearer authed —
// the caller must already be a logged-in member. Returns a `recording`-kind
// stream token bound to this recording id + the caller's sub, on the cookieless
// `?t=` play URL a device-token (tvOS/iOS) client can load. Mirrors the VOD
// grant idiom in routes/iptv.ts: a finite-asset TTL (the on-demand TTL, ~6h —
// NOT the 300s live TTL), so re-presenting the token on every range GET across
// the whole recording never expires mid-playback.
dvr.post('/recordings/:id/grant', requireAuth, requireSection('live'), async (c) => {
  // DVR captures UNRATED IPTV provider content (no certification), so a rating
  // cap forbids the grant wholesale — fail closed, exactly as the catchup / VOD
  // / series grants do (routes/iptv.ts). Without this a rating-capped kid
  // profile could mint a playable token for recorded live-TV it can't watch
  // live. Checked before touching the row so existence never leaks either.
  if (await capBlocksUnrated(c.get('session'))) {
    return c.json({ error: 'rating_blocked' }, 403)
  }
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
async function dvrPlayAuth(c: Context<Env, '/recordings/:id/play'>, next: Next) {
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
    // Revocation must take effect immediately: the cookieless ?t= path bypasses
    // requireAuth's membership reconciliation, so a token minted before the
    // holder was revoked would otherwise keep streaming for the full on-demand
    // TTL (~6h). Re-check membership here, matching media.ts / transcode.ts.
    if (memberStatus(claims.sub) !== 'allowed') {
      return c.json({ error: 'access_revoked' }, 401)
    }
    c.set('session', { sub: claims.sub, username: '', role: 'user' })
    return next()
  }
  // Tokenless → session cookie/bearer fallback. A session-authed caller never
  // passed the grant's parental gates, so re-apply them here: a rating-capped or
  // live-excluded profile must not stream a recorded live-TV asset via a plain
  // cookie any more than via the live / catchup / vod paths. (The ?t= path above
  // skips this — its token was already gated at grant time, so re-checking would
  // add a policy read per range GET.)
  const authDenied = await requireAuth(c, async () => {})
  if (authDenied) return authDenied
  let sectionOk = false
  const sectionDenied = await requireSection('live')(c, async () => {
    sectionOk = true
  })
  if (!sectionOk) return sectionDenied
  if (await capBlocksUnrated(c.get('session'))) {
    return c.json({ error: 'rating_blocked' }, 403)
  }
  return next()
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
