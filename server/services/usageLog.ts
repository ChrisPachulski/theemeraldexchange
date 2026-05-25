// Per-Claude-call usage log. One JSONL line per Anthropic API call
// (success or error) with token counts and estimated cost, keyed by
// the user who initiated the call. Drives the per-user usage view
// shown in the API key settings card and the admin's usage dashboard.
//
// Same pattern as grabLog.ts: append-only JSONL with a single
// in-flight write queue, file rotation at 5 MB, and a 64 KB chunked
// tail-reader for newest-first reads. No new dependency.

import { promises as fs } from 'fs'
import { dirname } from 'path'
import { env } from '../env.js'

export type UsageEventType = 'claude_call' | 'claude_error'

export type UsageEvent = {
  ts: string
  sub: string
  username: string
  type: UsageEventType
  model: string
  kind: 'movie' | 'tv'
  inputTokens?: number
  outputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  costCents?: number
  error?: string
}

const ROTATE_AT_BYTES = 5 * 1024 * 1024
const CHUNK_SIZE = 64 * 1024

let logPath = env.usageLogPath

export function _setUsageLogPathForTests(p: string): void {
  logPath = p
}

let writeQueue: Promise<void> = Promise.resolve()

export function appendUsageEvent(e: Omit<UsageEvent, 'ts'>): Promise<void> {
  const event: UsageEvent = { ts: new Date().toISOString(), ...e }
  const line = JSON.stringify(event) + '\n'
  const op = writeQueue.then(() => writeLine(line))
  writeQueue = op.catch((err) => {
    console.error('[usageLog] append failed:', err)
  })
  return op
}

async function writeLine(line: string): Promise<void> {
  await fs.mkdir(dirname(logPath), { recursive: true })
  let size = 0
  try {
    size = (await fs.stat(logPath)).size
  } catch {
    // new file
  }
  if (size > ROTATE_AT_BYTES) {
    await fs.rename(logPath, logPath + '.1').catch(() => {})
  }
  await fs.appendFile(logPath, line, { encoding: 'utf8' })
}

async function readTail(path: string, limit: number): Promise<string[]> {
  let fd
  try {
    fd = await fs.open(path, 'r')
  } catch {
    return []
  }
  try {
    const stat = await fd.stat()
    let pos = stat.size
    let leftover = ''
    const lines: string[] = []
    while (pos > 0 && lines.length < limit) {
      const readSize = Math.min(CHUNK_SIZE, pos)
      pos -= readSize
      const buf = Buffer.alloc(readSize)
      await fd.read(buf, 0, readSize, pos)
      const combined = buf.toString('utf8') + leftover
      const pieces = combined.split('\n')
      leftover = pieces[0]
      for (let i = pieces.length - 1; i >= 1 && lines.length < limit; i--) {
        const piece = pieces[i]
        if (piece.length > 0) lines.push(piece)
      }
    }
    if (pos === 0 && leftover.length > 0 && lines.length < limit) {
      lines.push(leftover)
    }
    return lines.slice(0, limit)
  } finally {
    await fd.close()
  }
}

function parseEvents(lines: string[]): UsageEvent[] {
  const out: UsageEvent[] = []
  for (const l of lines) {
    try {
      out.push(JSON.parse(l) as UsageEvent)
    } catch {
      // malformed line — drop silently
    }
  }
  return out
}

// Read JSONL events from the tail of `path`, parsing newest-first, and
// stop as soon as we see an event with ts < cutoffMs. The hard cap
// bounds memory in case something has corrupted the time order. Used
// by summarizeUsage to get exact accounting inside a time window
// without an arbitrary line-count cap.
async function readTailUntilCutoff(
  path: string,
  cutoffMs: number,
  hardLimit: number,
): Promise<UsageEvent[]> {
  let fd
  try {
    fd = await fs.open(path, 'r')
  } catch {
    return []
  }
  try {
    const stat = await fd.stat()
    let pos = stat.size
    let leftover = ''
    const events: UsageEvent[] = []
    let stop = false
    while (pos > 0 && events.length < hardLimit && !stop) {
      const readSize = Math.min(CHUNK_SIZE, pos)
      pos -= readSize
      const buf = Buffer.alloc(readSize)
      await fd.read(buf, 0, readSize, pos)
      const combined = buf.toString('utf8') + leftover
      const pieces = combined.split('\n')
      leftover = pieces[0]
      // Iterate from newest line in this chunk to oldest. As soon as
      // any line is older than the cutoff, set stop — every subsequent
      // line (and every line in older chunks) is also older.
      for (let i = pieces.length - 1; i >= 1; i--) {
        const piece = pieces[i]
        if (!piece) continue
        try {
          const ev = JSON.parse(piece) as UsageEvent
          if (new Date(ev.ts).getTime() < cutoffMs) {
            stop = true
            break
          }
          events.push(ev)
          if (events.length >= hardLimit) break
        } catch {
          // malformed line — skip silently
        }
      }
    }
    // Final leftover at pos === 0 is the very first line of the file.
    if (!stop && pos === 0 && leftover && events.length < hardLimit) {
      try {
        const ev = JSON.parse(leftover) as UsageEvent
        if (new Date(ev.ts).getTime() >= cutoffMs) events.push(ev)
      } catch {
        // skip
      }
    }
    return events
  } finally {
    await fd.close()
  }
}

export async function readRecentUsageEvents(limit: number): Promise<UsageEvent[]> {
  await writeQueue
  const primary = parseEvents(await readTail(logPath, limit))
  if (primary.length >= limit) return primary
  const rotated = parseEvents(await readTail(logPath + '.1', limit - primary.length))
  return [...primary, ...rotated]
}

export async function readUsageForUser(sub: string, limit: number): Promise<UsageEvent[]> {
  await writeQueue
  const SCAN_WINDOW = Math.max(500, limit * 50)
  const primary = parseEvents(await readTail(logPath, SCAN_WINDOW))
  const remaining = Math.max(0, SCAN_WINDOW - primary.length)
  const rotated = remaining > 0 ? parseEvents(await readTail(logPath + '.1', remaining)) : []
  return [...primary, ...rotated].filter((e) => e.sub === sub).slice(0, limit)
}

// Convenience aggregator — total cost/calls in the last N days for
// every user that's made a call. Used by /api/usage/me and
// /api/usage/admin.
export type UsageSummary = {
  sub: string
  username: string
  calls: number
  errors: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  costCents: number
}

// Defensive memory bound for summary scans. At ~300 B/event this is
// ~30 MB resident — plenty of headroom for household-scale 30-day
// windows. Caps how many in-window events we'll ever hold in memory
// in case something pathological (e.g. a clock-jumped log) makes the
// cutoff unreachable.
const SUMMARY_HARD_CAP = 100_000

export async function summarizeUsage(sinceMs: number): Promise<UsageSummary[]> {
  await writeQueue
  // Scan-until-cutoff: read newest-first, stop when we encounter an
  // event with ts < sinceMs (and everything older is by definition
  // also out of window). The previous 10k-line cap silently
  // undercounted at higher volume; this gives exact accounting up to
  // SUMMARY_HARD_CAP events, then degrades to "as many as fit."
  // Spans the rotated log too if the in-window range crosses a
  // rotation boundary.
  const primary = await readTailUntilCutoff(logPath, sinceMs, SUMMARY_HARD_CAP)
  const remaining = Math.max(0, SUMMARY_HARD_CAP - primary.length)
  const rotated =
    remaining > 0
      ? await readTailUntilCutoff(logPath + '.1', sinceMs, remaining)
      : []
  const events = [...primary, ...rotated]
  const byUser = new Map<string, UsageSummary>()
  for (const e of events) {
    if (new Date(e.ts).getTime() < sinceMs) continue
    let row = byUser.get(e.sub)
    if (!row) {
      row = {
        sub: e.sub,
        username: e.username,
        calls: 0,
        errors: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        costCents: 0,
      }
      byUser.set(e.sub, row)
    }
    if (e.type === 'claude_call') row.calls += 1
    if (e.type === 'claude_error') row.errors += 1
    row.inputTokens += e.inputTokens ?? 0
    row.outputTokens += e.outputTokens ?? 0
    row.cacheReadInputTokens += e.cacheReadInputTokens ?? 0
    row.costCents += e.costCents ?? 0
  }
  return [...byUser.values()].sort((a, b) => b.costCents - a.costCents)
}

// Haiku 4.5 pricing (per million tokens): input $1.00, output $5.00,
// cache write ~$1.25, cache read $0.10. Returns cents (rounded to 4
// decimals via 0.01-cent precision). Caller is responsible for
// passing the right numbers from response.usage.
export function computeCostCents(usage: {
  inputTokens?: number
  outputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}): number {
  const inp = usage.inputTokens ?? 0
  const out = usage.outputTokens ?? 0
  const cw = usage.cacheCreationInputTokens ?? 0
  const cr = usage.cacheReadInputTokens ?? 0
  // $ per token = $/M ÷ 1,000,000. Cents per token = $/M / 10,000.
  // (1 dollar = 100 cents; 1M tokens at $1/M = 100 cents = 0.0001¢/token)
  const cents =
    inp * (100 / 1_000_000) +
    out * (500 / 1_000_000) +
    cw * (125 / 1_000_000) +
    cr * (10 / 1_000_000)
  return Math.round(cents * 10000) / 10000
}
