import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  appendUsageEvent,
  readRecentUsageEvents,
  readUsageForUser,
  summarizeUsage,
  computeCostCents,
  _setUsageLogPathForTests,
} from './usageLog.js'

let tmpRoot: string
let path: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'usagelog-'))
  path = join(tmpRoot, 'usage.jsonl')
  _setUsageLogPathForTests(path)
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('usageLog append + tail', () => {
  it('writes and reads newest-first', async () => {
    await appendUsageEvent({
      sub: 'alice', username: 'alice', type: 'claude_call',
      model: 'claude-haiku-4-5', kind: 'movie',
    })
    await appendUsageEvent({
      sub: 'bob', username: 'bob', type: 'claude_call',
      model: 'claude-haiku-4-5', kind: 'tv',
    })
    const events = await readRecentUsageEvents(10)
    expect(events).toHaveLength(2)
    expect(events[0].sub).toBe('bob')
    expect(events[1].sub).toBe('alice')
  })

  it('filters by user', async () => {
    await appendUsageEvent({ sub: 'alice', username: 'alice', type: 'claude_call', model: 'm', kind: 'movie' })
    await appendUsageEvent({ sub: 'bob', username: 'bob', type: 'claude_call', model: 'm', kind: 'movie' })
    await appendUsageEvent({ sub: 'alice', username: 'alice', type: 'claude_call', model: 'm', kind: 'tv' })
    const aliceEvents = await readUsageForUser('alice', 10)
    expect(aliceEvents).toHaveLength(2)
    expect(aliceEvents.every((e) => e.sub === 'alice')).toBe(true)
  })

  it('returns [] when log missing', async () => {
    expect(await readRecentUsageEvents(10)).toEqual([])
  })

  it('skips malformed lines silently', async () => {
    await appendUsageEvent({ sub: 'a', username: 'a', type: 'claude_call', model: 'm', kind: 'movie' })
    await fs.appendFile(path, 'not json\n')
    await appendUsageEvent({ sub: 'b', username: 'b', type: 'claude_call', model: 'm', kind: 'tv' })
    const events = await readRecentUsageEvents(10)
    expect(events).toHaveLength(2)
  })

  it('rejects append failures without poisoning later appends', async () => {
    const notDirectory = join(tmpRoot, 'not-a-directory')
    await fs.writeFile(notDirectory, 'x')
    _setUsageLogPathForTests(join(notDirectory, 'usage.jsonl'))

    await expect(
      appendUsageEvent({
        sub: 'alice',
        username: 'alice',
        type: 'claude_call',
        model: 'm',
        kind: 'movie',
      }),
    ).rejects.toThrow()

    _setUsageLogPathForTests(path)
    await appendUsageEvent({
      sub: 'bob',
      username: 'bob',
      type: 'claude_call',
      model: 'm',
      kind: 'tv',
    })
    expect((await readRecentUsageEvents(10)).map((e) => e.sub)).toEqual(['bob'])
  })
})

describe('summarizeUsage', () => {
  it('aggregates per user with cost totals', async () => {
    await appendUsageEvent({
      sub: 'alice', username: 'alice', type: 'claude_call',
      model: 'claude-haiku-4-5', kind: 'movie',
      inputTokens: 1000, outputTokens: 500, costCents: 0.35,
    })
    await appendUsageEvent({
      sub: 'alice', username: 'alice', type: 'claude_call',
      model: 'claude-haiku-4-5', kind: 'movie',
      inputTokens: 2000, outputTokens: 800, costCents: 0.60,
    })
    await appendUsageEvent({
      sub: 'bob', username: 'bob', type: 'claude_error',
      model: 'claude-haiku-4-5', kind: 'tv', error: '401',
    })

    const summary = await summarizeUsage(0) // since epoch
    const alice = summary.find((r) => r.sub === 'alice')
    const bob = summary.find((r) => r.sub === 'bob')
    expect(alice?.calls).toBe(2)
    expect(alice?.errors).toBe(0)
    expect(alice?.inputTokens).toBe(3000)
    expect(alice?.costCents).toBeCloseTo(0.95, 2)
    expect(bob?.calls).toBe(0)
    expect(bob?.errors).toBe(1)
  })

  it('respects the since cutoff', async () => {
    await appendUsageEvent({
      sub: 'alice', username: 'alice', type: 'claude_call',
      model: 'm', kind: 'movie',
    })
    const inOneHour = Date.now() + 60 * 60 * 1000
    expect(await summarizeUsage(inOneHour)).toEqual([])
  })

  it('stops scanning once it hits an event older than the cutoff', async () => {
    // Write three events: two inside the 1-hour window, one well outside.
    // The summary must include the two recent ones and the helper must
    // stop traversing past the old one (exposed indirectly: the old
    // event's claims are NOT in the output).
    const recentTs = new Date().toISOString()
    const oldTs = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    // Order in file (top = oldest, bottom = newest, JSONL append order):
    await fs.writeFile(
      path,
      [
        JSON.stringify({ ts: oldTs, sub: 'ghost', username: 'ghost', type: 'claude_call', model: 'm', kind: 'movie', costCents: 99 }),
        JSON.stringify({ ts: recentTs, sub: 'alice', username: 'alice', type: 'claude_call', model: 'm', kind: 'movie', costCents: 0.1 }),
        JSON.stringify({ ts: recentTs, sub: 'alice', username: 'alice', type: 'claude_call', model: 'm', kind: 'movie', costCents: 0.2 }),
        '',
      ].join('\n'),
    )

    const oneHourAgo = Date.now() - 60 * 60 * 1000
    const summary = await summarizeUsage(oneHourAgo)
    const alice = summary.find((r) => r.sub === 'alice')
    expect(alice?.calls).toBe(2)
    expect(alice?.costCents).toBeCloseTo(0.3, 2)
    expect(summary.find((r) => r.sub === 'ghost')).toBeUndefined()
  })

  it('handles >10k events in window without the old 10k truncation', async () => {
    // Simulates the higher-volume case the previous cap silently
    // undercounted. Writes 12k events, all inside the window. The
    // exact-accounting promise requires all 12k to show up in the
    // alice summary.
    const lines: string[] = []
    const now = Date.now()
    for (let i = 0; i < 12_000; i++) {
      lines.push(
        JSON.stringify({
          ts: new Date(now - i * 1000).toISOString(),
          sub: 'alice',
          username: 'alice',
          type: 'claude_call',
          model: 'm',
          kind: 'movie',
          costCents: 0.01,
        }),
      )
    }
    // Reverse so newest is at the bottom (matches append order).
    lines.reverse()
    await fs.writeFile(path, lines.join('\n') + '\n')

    const summary = await summarizeUsage(0)
    const alice = summary.find((r) => r.sub === 'alice')
    expect(alice?.calls).toBe(12_000)
    expect(alice?.costCents).toBeCloseTo(120, 1)
  })

  it('spans the rotated log so 30-day summaries don\'t undercount after rotation', async () => {
    // Simulate post-rotation state: primary holds the newer events,
    // .1 holds the older ones. Both are inside the summary window.
    // Before the fix, summarizeUsage read only the primary and would
    // miss the rotated calls entirely.
    const old = JSON.stringify({
      ts: new Date().toISOString(),
      sub: 'alice', username: 'alice', type: 'claude_call',
      model: 'm', kind: 'movie',
      inputTokens: 100, outputTokens: 50, costCents: 0.10,
    })
    await fs.writeFile(path + '.1', old + '\n')
    await appendUsageEvent({
      sub: 'alice', username: 'alice', type: 'claude_call',
      model: 'm', kind: 'movie',
      inputTokens: 200, outputTokens: 100, costCents: 0.20,
    })

    const summary = await summarizeUsage(0)
    const alice = summary.find((r) => r.sub === 'alice')
    expect(alice?.calls).toBe(2) // 1 primary + 1 rotated
    expect(alice?.inputTokens).toBe(300)
    expect(alice?.costCents).toBeCloseTo(0.30, 2)
  })
})

describe('computeCostCents', () => {
  it('matches Haiku 4.5 pricing for fresh input + output', () => {
    // 1M input tokens at $1/M = 100 cents
    expect(computeCostCents({ inputTokens: 1_000_000 })).toBeCloseTo(100, 2)
    // 1M output tokens at $5/M = 500 cents
    expect(computeCostCents({ outputTokens: 1_000_000 })).toBeCloseTo(500, 2)
    // 1M cache-read tokens at $0.10/M = 10 cents
    expect(computeCostCents({ cacheReadInputTokens: 1_000_000 })).toBeCloseTo(10, 2)
  })

  it('returns 0 with no token counts', () => {
    expect(computeCostCents({})).toBe(0)
  })
})
