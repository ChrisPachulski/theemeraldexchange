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

// SIGTERMed-but-not-yet-exited children. stopRemuxSession only SIGTERMs and
// deletes the Map entry immediately, but the ffmpeg child keeps its upstream
// provider connection open for a beat afterwards (see the comment at the bottom
// of stopRemuxSession). Until that child actually exits it still counts against
// the hard upstream-connection cap even though it is gone from `sessions`. Track
// those draining children so the cap sees the TRUE live-connection count and
// never spawns a fresh ffmpeg while an evicted one is still dialing the provider
// — the transient cap+1 burst the provider punishes with corrupt video. Each
// entry is cleared on the child's own exit/error.
const draining = new Set<ChildProcess>()

/** Live upstream connections right now: active sessions PLUS SIGTERMed children
 *  that have not yet released their provider socket. This — not `sessions.size`
 *  — is what the connection cap must bound. */
function liveUpstreamCount(): number {
  return sessions.size + draining.size
}

/** Test seam: drop draining-child tracking so cap accounting doesn't leak across
 *  tests whose fake children never emit an 'exit'. */
export function _clearDrainingForTests(): void {
  draining.clear()
}

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

// Dead-channel-placeholder detection (Fox Soccer Plus incident, 2026-07-06).
// A live remux whose ffmpeg EOFs CLEANLY (exit code 0) sooner than this never
// carried a real live event: the upstream fed a dead-channel STUB (typically a
// ~30s placeholder loop) and closed. A genuine live feed never ends on its own
// — it is torn down by us (SIGTERM/SIGKILL, code null) or dies corrupt (255).
// So `code === 0 && lifetime < DEAD_FEED_MAX_LIFETIME_MS` is the dead-feed
// signature. We remember it so ensureLiveRemuxEntry skips this variant and fails
// over to a sibling feed on the immediate retry, then re-probes once the memory
// expires (a channel can come back on air). TTL'd like needsReencode above.
//
// The memory MUST outlast one full sibling walk. isChannelOfflineUpstream only
// reports a channel offline when EVERY candidate feed is remembered dead at the
// SAME instant. A dead placeholder lives up to DEAD_FEED_MAX_LIFETIME_MS before
// its clean EOF tags it, so walking N siblings takes up to N × that ceiling. If
// the memory expired sooner (the old 60s == the ceiling), the first sibling's
// tag would lapse before the 3rd sibling died, isChannelOfflineUpstream could
// never fire for a 3+-sibling channel, and pickLiveFeed would re-dial the
// expired sibling #1 forever — an infinite ~30s-slate carousel that churns
// provider connections (the exact Fox Soccer Plus failure). 10 min comfortably
// spans a walk of up to ~10 siblings at the 60s ceiling; a genuinely-recovered
// dead channel is simply re-probed 10 min later instead of 60s later, which is
// harmless (a live sibling keeps its session alive regardless of dead-TTLs).
const DEAD_FEED_MAX_LIFETIME_MS = 60_000
const DEAD_FEED_MEMORY_MS = 10 * 60_000
const deadFeed = new Map<string, number>() // streamId -> expiresAt (ms)

/** True if this channel's feed was seen EOFing cleanly-and-fast (a dead-channel
 *  placeholder) recently, so ensureLiveRemuxEntry should skip it and fail over
 *  to a sibling. Self-expiring so a recovered channel is re-probed. */
export function channelIsDeadFeed(streamId: string): boolean {
  const exp = deadFeed.get(streamId)
  if (exp === undefined) return false
  if (exp <= Date.now()) {
    deadFeed.delete(streamId)
    return false
  }
  return true
}

function markChannelDeadFeed(streamId: string): void {
  deadFeed.set(streamId, Date.now() + DEAD_FEED_MEMORY_MS)
}

/** Test seam: drop all remembered dead feeds so cases don't cross-contaminate. */
export function _clearDeadFeedMemoryForTests(): void {
  deadFeed.clear()
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
  // The child keeps its provider connection open until it actually exits, so it
  // still counts against the upstream cap. Track it as draining and drop it on
  // exit/error so startRemuxSession won't dial a replacement while it lingers.
  draining.add(s.proc)
  const undrain = (): void => {
    draining.delete(s.proc)
  }
  s.proc.once('exit', undrain)
  s.proc.once('error', undrain)
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

export function startRemuxSession(opts: StartRemuxOpts): StartRemuxResult | null {
  // Defense in depth: refuse non-http(s) inputs before any side effects
  // (temp dir creation, ffmpeg spawn).
  assertHttpUpstream(opts.upstreamUrl)

  // HARD SAFETY: never hold more than IPTV_MAX_UPSTREAM_CONNECTIONS live upstream
  // connections to the provider at once. This is the single choke point where an
  // upstream connection is opened, so the cap cannot be bypassed by any caller
  // (grant, a direct manifest poll, a test probe, or a future bug). The provider
  // trips an abuse block on too many simultaneous connections and then feeds
  // CORRUPT, undecodable video to everyone until it cools down — so we bound the
  // count here rather than trust every caller to behave.
  //
  // At the cap, evict the least-recently-seen session (a channel-switch ghost or
  // an abandoned viewer) to free a slot — but do NOT spawn the replacement in the
  // same tick. stopRemuxSession only SIGTERMs; the evicted ffmpeg keeps its
  // provider socket open for a beat (it becomes `draining`), so dialing now would
  // momentarily hold cap+1 connections — the exact over-cap burst the provider
  // punishes. Instead start the eviction and return null: the caller serves a
  // transient remux_warming and the next manifest poll re-dials once the evicted
  // child has actually exited and a real slot has freed. Only evict when nothing
  // is already draining toward a free slot, so a stationary at-cap retry doesn't
  // cascade-evict live viewers one after another.
  const cap = env.IPTV_MAX_UPSTREAM_CONNECTIONS
  if (cap > 0 && liveUpstreamCount() >= cap) {
    if (draining.size === 0) {
      let lru: RemuxSession | undefined
      for (const s of sessions.values()) {
        if (!lru || s.lastSeen < lru.lastSeen) lru = s
      }
      if (lru) {
        console.warn(
          `[iptv-remux] upstream cap ${cap} reached — evicting LRU ${lru.sessionId} ` +
            `(idle ${Date.now() - lru.lastSeen}ms); deferring the new dial until it ` +
            `releases its provider connection`,
        )
        stopRemuxSession(lru.sessionId, 'upstream-cap')
      }
    }
    return null
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
    // +igndts is the load-bearing one: this provider's MPEG-TS carries badly
    // broken decode timestamps (observed dts ≫ pts, multi-billion-tick jumps
    // mid-stream). +genpts alone only fills in MISSING pts; it does nothing for
    // a present-but-wrong dts, so with -c:v copy the garbage propagated into the
    // segments and the player's timeline broke down over a long sitting. +igndts
    // discards the bogus input dts and lets the muxer regenerate sane ones.
    '-fflags', '+discardcorrupt+genpts+igndts',
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
    // Rebase the (now igndts-cleaned) output to a zero-based monotonic timeline
    // so each segment carries sane, continuous timestamps the player can stitch
    // without a flush. Paired with +igndts above this removed the periodic ~30 s
    // back-jumps and the every-few-seconds freeze that set in after ~10 min.
    '-avoid_negative_ts', 'make_zero',
    '-max_muxing_queue_size', '1024',
    '-f', 'hls',
    // 2 s segments (matching the VOD transcode path): a player buffers ~3
    // segments before showing a frame, so 4 s segments meant ~12 s of "stuck
    // buffering" at startup and AVPlayer began ~12 s behind the live edge. At
    // 2 s that startup/edge latency roughly halves — the dominant live-buffering
    // symptom on Apple TV. Smaller segments also let a player recover at finer
    // granularity after a hiccup.
    '-hls_time', '2',
    // 40 segments ≈ an ~80 s sliding window. This provider's keyframes are wildly
    // irregular (GOP deltas 0.03–2.5 s), so -c:v copy emits irregular segments
    // (0.5–3.7 s) that a shallow client buffer underruns on. The deep window lets
    // the player sit ~15 s back and tolerate up to ~60 s of latency (see the
    // hls.js liveSyncDuration/liveMaxLatencyDuration on the client) so jittery,
    // realtime-but-bursty production never starves it. Disk ≈ 40 × ~2.4 MB per
    // session on a 3.8 GB tmpfs, bounded by the upstream-connection cap.
    '-hls_list_size', '40',
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_filename', 'seg_%05d.ts',
    manifestPath,
  ]
  const spawnedAt = Date.now()
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
    const livedMs = Date.now() - spawnedAt
    // A clean, fast EOF (code 0, not signalled, under the placeholder ceiling)
    // is a dead-channel stub, not a real live feed — tag it so the next tune
    // fails over to a sibling and the manifest route can answer a terminal
    // channel_offline_upstream instead of an indistinguishable remux_warming.
    // A corrupt feed (non-zero, e.g. 255) or our own teardown (SIGTERM/SIGKILL,
    // code null) is NOT a dead feed and must not poison the failover path.
    if (code === 0 && signal == null && livedMs < DEAD_FEED_MAX_LIFETIME_MS) {
      markChannelDeadFeed(opts.streamId)
      console.warn(
        `[iptv-remux ${sessionId}] clean EOF after ${livedMs}ms — tagging stream ` +
          `${opts.streamId} as a dead feed (fail over to a sibling)`,
      )
    }
    console.log(
      `[iptv-remux ${sessionId}] ffmpeg exited code=${code} signal=${signal ?? ''} livedMs=${livedMs}`,
    )
    sessions.delete(sessionId)
    removeDir(dir)
  })

  sessions.set(sessionId, {
    sessionId,
    streamId: opts.streamId,
    sub: opts.sub,
    dir,
    manifestPath,
    proc,
    startedAt: spawnedAt,
    lastSeen: spawnedAt,
  })
  return { sessionId, dir, manifestPath }
}
