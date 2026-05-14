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
