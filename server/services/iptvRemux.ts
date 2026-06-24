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
  /** Re-encode video to H.264 instead of copying it. Set for channels whose
   *  upstream video isn't Apple-TS-playable (e.g. HEVC) — see `needsReencode`. */
  reencodeVideo?: boolean
}

export interface StartRemuxResult {
  sessionId: string
  dir: string
  manifestPath: string
}

// A live HLS player does NOT poll continuously. AVPlayer buffers a chunk of the
// sliding window (up to ~48s here: hls_list_size 24 × hls_time 2) and then goes
// SILENT while it drains that buffer — measured fetch gaps of ~17s on tvOS. The
// old 15s reap mistook that buffered silence for a closed app and SIGKILLed the
// ffmpeg of an actively-watched channel mid-stream: the player drains its buffer,
// comes back for the next segment, finds the session gone, and stalls forever
// (confirmed in prod: `stop reason=idle-sweep sinceSeenMs=16808` on a live view).
// The idle reap is only the backstop for an outright app-close that skipped the
// client's session DELETE; channel switches are freed eagerly by
// dropOtherLiveRemuxSessions. So the timeout must sit safely ABOVE the buffer-
// drain gap (well past the 48s window). A ghost lingering this long is fine;
// reaping a live viewer is not.
const IDLE_MS = 90_000
const sessions = new Map<string, RemuxSession>()

// Channels whose upstream video isn't H.264 and so can't be COPIED into a
// playable Apple HLS stream (Apple won't play HEVC — or MPEG-2/AV1/VP9 — from
// MPEG-TS segments). We learn this from the remux ffmpeg's own input stream info
// (the stderr handler below), then remember it with a TTL so later tunes skip
// the doomed copy attempt and go straight to re-encode. TTL'd because a channel
// can change codec over time.
const REENCODE_MEMORY_MS = 6 * 60 * 60_000
const needsReencode = new Map<string, number>() // streamId -> expiresAt (ms)

/** True if this channel was seen serving non-H.264 video recently and should be
 *  re-encoded rather than copied. Read by ensureLiveRemuxEntry when (re)starting. */
export function channelNeedsReencode(streamId: string): boolean {
  const exp = needsReencode.get(streamId)
  if (exp === undefined) return false
  if (exp <= Date.now()) {
    needsReencode.delete(streamId)
    return false
  }
  return true
}

function markChannelNeedsReencode(streamId: string): void {
  needsReencode.set(streamId, Date.now() + REENCODE_MEMORY_MS)
}

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

export function stopRemuxSession(sessionId: string, reason = 'manual'): void {
  const s = sessions.get(sessionId)
  if (!s) return
  sessions.delete(sessionId)
  // Diagnostic: record WHY a live session was torn down and how long it ran /
  // how long since it was last polled. A mid-watch stop (small sinceSeenMs while
  // a viewer is active) is the signature of the "plays then stalls" report.
  const now = Date.now()
  console.log(
    `[iptv-remux ${sessionId}] stop reason=${reason} ageMs=${now - s.startedAt} sinceSeenMs=${now - s.lastSeen}`,
  )
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
  // Do NOT removeDir here. ffmpeg is still alive for a beat after SIGTERM and
  // keeps writing its current segment + renaming index.m3u8.tmp; deleting the
  // dir out from under it makes that write fail ("No such file or directory")
  // and ffmpeg aborts with code 255 — truncating the stream mid-segment, which
  // a viewer sees as a hard stall. The proc 'exit' handler removes the dir once
  // ffmpeg has actually exited, so cleanup still happens, just without the race.
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
  for (const id of ids) stopRemuxSession(id, 'drain')
  const deadline = Date.now() + graceMs
  while (sessions.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
}

function sweepIdleSessions(): void {
  const now = Date.now()
  for (const s of sessions.values()) {
    if (now - s.lastSeen > IDLE_MS) stopRemuxSession(s.sessionId, 'idle-sweep')
  }
}

const sweepHandle = setInterval(sweepIdleSessions, 5_000)
sweepHandle.unref?.()

export function startRemuxSession(opts: StartRemuxOpts): StartRemuxResult {
  // Defense in depth: refuse non-http(s) inputs before any side effects
  // (temp dir creation, ffmpeg spawn).
  assertHttpUpstream(opts.upstreamUrl)

  // HARD SAFETY: never hold more than IPTV_MAX_UPSTREAM_CONNECTIONS live upstream
  // connections to the provider at once. This is the single choke point where an
  // upstream connection is opened, so the cap cannot be bypassed by any caller
  // (grant, a direct manifest poll, a test probe, or a future bug). The provider
  // trips an abuse block on too many simultaneous connections and then feeds
  // CORRUPT, undecodable video to everyone until it cools down — so we bound the
  // count here rather than trust every caller to behave. At the cap, evict the
  // least-recently-seen session (a channel-switch ghost or an abandoned viewer)
  // to free a slot, so a fresh tune always succeeds while the connection count
  // stays bounded no matter how many requests pile in.
  const cap = env.IPTV_MAX_UPSTREAM_CONNECTIONS
  while (cap > 0 && sessions.size >= cap) {
    let lru: RemuxSession | undefined
    for (const s of sessions.values()) {
      if (!lru || s.lastSeen < lru.lastSeen) lru = s
    }
    if (!lru) break
    console.warn(
      `[iptv-remux] upstream cap ${cap} reached — evicting LRU ${lru.sessionId} ` +
        `(idle ${Date.now() - lru.lastSeen}ms) to free a provider connection`,
    )
    stopRemuxSession(lru.sessionId, 'upstream-cap')
  }

  const sessionId = `remux:${opts.streamId}:${safeIdPart(opts.sub)}:${Date.now()}`
  const dir = path.join(env.IPTV_REMUX_TMP_DIR, sessionId.replace(/[:/]/g, '_'))
  fs.mkdirSync(dir, { recursive: true })

  const manifestPath = path.join(dir, 'index.m3u8')
  // Video path: copy (free, the H.264 majority) OR re-encode to H.264 for a
  // non-Apple-TS-playable upstream (HEVC etc.). Re-encode is capped (preset +
  // threads + max height) and only the rare non-H.264 channels reach it, so the
  // encode load on the Plex-sharing box stays bounded by the upstream-conn cap.
  const videoArgs = opts.reencodeVideo
    ? [
        '-c:v', 'libx264',
        '-preset', env.IPTV_REENCODE_PRESET,
        '-pix_fmt', 'yuv420p',
        '-g', '48',
        '-force_key_frames', 'expr:gte(t,n_forced*2)',
        '-threads', String(env.IPTV_REENCODE_THREADS),
        // Downscale only if taller than the cap (never upscale); -2 keeps an even
        // width at the source aspect. Comma escaped so the filtergraph parser
        // doesn't read min(a,b) as two filters.
        '-vf', `scale=-2:min(${env.IPTV_REENCODE_MAX_HEIGHT}\\,ih)`,
      ]
    : ['-c:v', 'copy']
  const args = [
    '-hide_banner',
    // info (+ -nostats) so ffmpeg prints the input stream's codec, which the
    // stderr handler reads to decide copy-vs-re-encode. -nostats keeps the
    // per-second progress line out of the logs.
    '-loglevel', 'info', '-nostats',
    '-nostdin',
    // Constrain ffmpeg to the protocols a real upstream stream needs so
    // neither the '-i' input nor a nested manifest can reach
    // file:/concat:/etc. Pairs with assertHttpUpstream() above.
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
    '-fflags', '+discardcorrupt+genpts',
    // Some channels (e.g. 24/7 HEVC feeds) declare their video parameters
    // (VPS/SPS/PPS + resolution) later in the stream than the H.264 channels do.
    // ffmpeg's default probe window can expire first, leaving "Could not find
    // codec parameters ... unspecified size" — the HLS muxer then can't start, so
    // ffmpeg exits 255 and the channel never loads. A larger probe ceiling fixes
    // that. These are ceilings, not fixed waits: ffmpeg stops as soon as it has
    // the parameters, so the H.264 channels that declare quickly are unaffected.
    '-probesize', '10M', '-analyzeduration', '10M',
    '-i', opts.upstreamUrl,
    // Video is copied losslessly. Audio is RE-ENCODED to AAC-LC even though the
    // provider already sends AAC: the provider's profile is HE-AAC (AAC+SBR),
    // whose SBR decoder delay AVPlayer doesn't compensate, so on iOS/tvOS the
    // audio lands a hair behind the video (lip-sync). The container PTS are
    // otherwise aligned (measured ~0.6 ms A/V), so transcoding to plain AAC-LC
    // stereo — not retiming — removes the offset. One stereo AAC-LC encode is a
    // few % of a core, so it doesn't threaten the Plex box; video stays a copy.
    ...videoArgs,
    '-c:a', 'aac', '-ac', '2', '-b:a', '160k',
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

  let sawOutput = false
  let codecDecided = false
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = scrubXtreamCreds(chunk.toString())
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      // The Output dump also has a "Video:" line; only the INPUT codec matters.
      if (line.startsWith('Output #')) sawOutput = true
      // Decide copy-vs-re-encode from the INPUT video codec ffmpeg reports for
      // the connection it actually opened (robust to channels that flip codec
      // per connection). If a COPY session's input isn't H.264, it can't produce
      // playable Apple HLS: remember the channel and kill this session so the
      // next manifest poll respawns it as a re-encode. (A re-encode session's
      // input is expected to be HEVC, so don't act on it.)
      if (!codecDecided && !sawOutput && !opts.reencodeVideo) {
        const m = line.match(/Stream #\d+:\d+.*: Video: (\w+)/)
        if (m) {
          codecDecided = true
          const codec = m[1].toLowerCase()
          if (codec !== 'h264' && codec !== 'avc') {
            markChannelNeedsReencode(opts.streamId)
            console.warn(`[iptv-remux ${sessionId}] input video is ${codec}, not H.264 — re-encoding`)
            proc.kill('SIGKILL')
            return
          }
        }
      }
      console.warn(`[iptv-remux ${sessionId}] ${line}`)
    }
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
