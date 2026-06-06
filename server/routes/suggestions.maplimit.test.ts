import { describe, it, expect } from 'vitest'
import { mapLimit } from './suggestions.js'

describe('mapLimit', () => {
  it('preserves input order even when later items resolve first', async () => {
    // Item 0 resolves slowest, item 3 fastest — completion order is the
    // reverse of input order. Results must still be indexed by input position.
    const delays = [40, 30, 20, 10]
    const out = await mapLimit(delays, 2, (ms, i) =>
      new Promise<number>((res) => setTimeout(() => res(i), ms)),
    )
    expect(out).toEqual([0, 1, 2, 3])
  })

  it('never exceeds the concurrency limit (peak in-flight <= limit)', async () => {
    const limit = 3
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 20 }, (_, i) => i)
    await mapLimit(items, limit, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((res) => setTimeout(res, 5))
      inFlight--
      return null
    })
    expect(peak).toBe(limit)
    expect(inFlight).toBe(0)
  })

  it('spawns at most items.length workers when limit exceeds item count', async () => {
    const limit = 100
    let peak = 0
    let inFlight = 0
    const items = [1, 2, 3]
    await mapLimit(items, limit, async (n) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((res) => setTimeout(res, 5))
      inFlight--
      return n * 2
    })
    // Math.min(limit, items.length) caps the worker pool at 3, not 100.
    expect(peak).toBe(items.length)
  })

  it('returns mapped results and passes the correct index to fn', async () => {
    const seen: Array<[string, number]> = []
    const out = await mapLimit(['a', 'b', 'c'], 2, async (v, i) => {
      seen.push([v, i])
      return `${v}${i}`
    })
    expect(out).toEqual(['a0', 'b1', 'c2'])
    expect(seen.sort()).toEqual([['a', 0], ['b', 1], ['c', 2]])
  })

  it('returns an empty array for empty input and never invokes fn', async () => {
    let called = 0
    const out = await mapLimit([], 8, async () => {
      called++
      return 1
    })
    expect(out).toEqual([])
    expect(called).toBe(0)
  })
})
