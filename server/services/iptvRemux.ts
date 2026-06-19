import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { env } from '../env.js'

export function scrubXtreamCreds(line: string): string {
  let result = line
  const u = env.XTREAM_USERNAME
  const p = env.XTREAM_PASSWORD
  // Redact the literal creds AND their URL-encoded form. ffmpeg echoes
  // upstream URLs both raw and percent-encoded depending on the path, so
  // a literal-only replace can miss the encoded copy (e.g. a password
  // containing reserved characters).
  const redactLiteral = (value: string | undefined): void => {
    if (!value) return
    result = result.replaceAll(value, 'REDACTED')
    const encoded = encodeURIComponent(value)
    if (encoded !== value) result = result.replaceAll(encoded, 'REDACTED')
  }
  redactLiteral(u)
  redactLiteral(p)
  result = result.replace(
    /(https?:\/\/[^/\s]+\/[^/\s]+\/)([^/\s]+)\/([^/\s]+)\//g,
    '$1REDACTED/REDACTED/',
  )
  result = result.replace(/([?&])username=[^&\s]*/g, '$1username=REDACTED')
  result = result.replace(/([?&])password=[^&\s]*/g, '$1password=REDACTED')
  return result
}

interface RemuxSession {
  sessionId: string
  streamId: string
  sub: string
  dir: string
  manifestPath: string
  proc: ChildProcess
  startedAt: number
  lastSeen: number
}

export interface StartRemuxOpts {
  streamId: string
  sub: string
  upstreamUrl: string
}

export interface StartRemuxResult {
  sessionId: string
  dir: string
  manifestPath: string
}

const IDLE_MS = 30_000
const sessions = new Map<string, RemuxSession>()

// Only http(s) upstreams are valid IPTV inputs. Reject anything else
// (file:, concat:, pipe:, data:, …) before it reaches ffmpeg's '-i'.
// The URL is server-constructed from env creds today (low risk), but a
// future caller passing an upstream-influenced URL (a provider-redirected
// manifest) could otherwise steer ffmpeg's broad default protocol set.
// Pairs with the '-protocol_whitelist' arg so confinement is enforced at
// both our layer and ffmpeg's.
function assertHttpUpstream(upstreamUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(upstreamUrl)
  } catch {
    throw new Error('remux upstream URL is not a valid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`remux upstream protocol not allowed: ${parsed.protocol}`)
  }
}

function safeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_')
}

function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup; stale remux temp files are swept by session stop/exit paths.
  }
}

export function listRemuxSessions(): Array<{
  sessionId: string
  streamId: string
  sub: string
  dir: string
  manifestPath: string
  startedAt: number
  lastSeen: number
}> {
  return [...sessions.values()].map((s) => ({
    sessionId: s.sessionId,
    streamId: s.streamId,
    sub: s.sub,
    dir: s.dir,
    manifestPath: s.manifestPath,
    startedAt: s.startedAt,
    lastSeen: s.lastSeen,
  }))
}

export function heartbeatRemuxSession(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (s) s.lastSeen = Date.now()
}

export function stopRemuxSession(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  sessions.delete(sessionId)
  try {
    s.proc.kill('SIGTERM')
  } catch {
    // Process may already have exited.
  }
  const killTimer = setTimeout(() => {
    try {
      s.proc.kill('SIGKILL')
    } catch {
      // Process may already have exited.
    }
  }, 5_000)
  killTimer.unref?.()
  removeDir(s.dir)
}

/**
 * Drain every live remux session for graceful shutdown (finding 14-2).
 *
 * On a deploy/SIGTERM the prior code never stopped these ffmpeg children, so
 * they could be orphaned. This SIGTERMs each, then waits (bounded by
 * `graceMs`) for the child to actually exit — the 'exit' handler removes the
 * session from the Map — before resolving, so the caller can proceed to close
 * the DBs without racing an ffmpeg still writing into the temp dir. A child
 * that ignores SIGTERM is SIGKILLed by the timer inside stopRemuxSession.
 */
export async function drainRemuxSessions(graceMs = 5_000): Promise<void> {
  const ids = [...sessions.keys()]
  if (ids.length === 0) return
  for (const id of ids) stopRemuxSession(id)
  const deadline = Date.now() + graceMs
  while (sessions.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
}

function sweepIdleSessions(): void {
  const now = Date.now()
  for (const s of sessions.values()) {
    if (now - s.lastSeen > IDLE_MS) stopRemuxSession(s.sessionId)
  }
}

const sweepHandle = setInterval(sweepIdleSessions, 5_000)
sweepHandle.unref?.()

export function startRemuxSession(opts: StartRemuxOpts): StartRemuxResult {
  // Defense in depth: refuse non-http(s) inputs before any side effects
  // (temp dir creation, ffmpeg spawn).
  assertHttpUpstream(opts.upstreamUrl)

  const sessionId = `remux:${opts.streamId}:${safeIdPart(opts.sub)}:${Date.now()}`
  const dir = path.join(env.IPTV_REMUX_TMP_DIR, sessionId.replace(/[:/]/g, '_'))
  fs.mkdirSync(dir, { recursive: true })

  const manifestPath = path.join(dir, 'index.m3u8')
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-nostdin',
    // Constrain ffmpeg to the protocols a real upstream stream needs so
    // neither the '-i' input nor a nested manifest can reach
    // file:/concat:/etc. Pairs with assertHttpUpstream() above.
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
    '-fflags', '+discardcorrupt+genpts',
    '-i', opts.upstreamUrl,
    '-c', 'copy',
    '-f', 'hls',
    // 2 s segments (matching the VOD transcode path): a player buffers ~3
    // segments before showing a frame, so 4 s segments meant ~12 s of "stuck
    // buffering" at startup and AVPlayer began ~12 s behind the live edge. At
    // 2 s that startup/edge latency roughly halves — the dominant live-buffering
    // symptom on Apple TV. Smaller segments also let a player recover at finer
    // granularity after a hiccup.
    '-hls_time', '2',
    // 24 segments ≈ a ~48 s sliding window. A player that briefly falls behind
    // (tunnel jitter, provider hiccup) must still find its next segment present
    // before delete_segments reaps it; 48 s keeps that recovery margin at the
    // smaller segment size. Disk cost ≈ 24 × ~2.4 MB per live session.
    '-hls_list_size', '24',
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_filename', 'seg_%05d.ts',
    manifestPath,
  ]
  const proc = spawn('ffmpeg', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })

  proc.stderr?.on('data', (chunk: Buffer) => {
    const line = scrubXtreamCreds(chunk.toString().trim())
    if (line) console.warn(`[iptv-remux ${sessionId}] ${line}`)
  })
  proc.on('error', (err) => {
    console.warn(`[iptv-remux ${sessionId}] ffmpeg error: ${scrubXtreamCreds(err.message)}`)
    sessions.delete(sessionId)
    removeDir(dir)
  })
  proc.on('exit', (code, signal) => {
    console.log(`[iptv-remux ${sessionId}] ffmpeg exited code=${code} signal=${signal ?? ''}`)
    sessions.delete(sessionId)
    removeDir(dir)
  })

  const now = Date.now()
  sessions.set(sessionId, {
    sessionId,
    streamId: opts.streamId,
    sub: opts.sub,
    dir,
    manifestPath,
    proc,
    startedAt: now,
    lastSeen: now,
  })
  return { sessionId, dir, manifestPath }
}
