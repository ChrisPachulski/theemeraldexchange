import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { env } from '../env.js'

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

function sweepIdleSessions(): void {
  const now = Date.now()
  for (const s of sessions.values()) {
    if (now - s.lastSeen > IDLE_MS) stopRemuxSession(s.sessionId)
  }
}

const sweepHandle = setInterval(sweepIdleSessions, 5_000)
sweepHandle.unref?.()

export function startRemuxSession(opts: StartRemuxOpts): StartRemuxResult {
  const sessionId = `remux:${opts.streamId}:${safeIdPart(opts.sub)}:${Date.now()}`
  const dir = path.join(env.IPTV_REMUX_TMP_DIR, sessionId.replace(/[:/]/g, '_'))
  fs.mkdirSync(dir, { recursive: true })

  const manifestPath = path.join(dir, 'index.m3u8')
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-nostdin',
    '-fflags', '+discardcorrupt+genpts',
    '-i', opts.upstreamUrl,
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '8',
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_filename', 'seg_%05d.ts',
    manifestPath,
  ]
  const proc = spawn('ffmpeg', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })

  proc.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim()
    if (line) console.warn(`[iptv-remux ${sessionId}] ${line}`)
  })
  proc.on('error', (err) => {
    console.warn(`[iptv-remux ${sessionId}] ffmpeg error: ${err.message}`)
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
