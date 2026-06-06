import { describe, it, expect } from 'vitest'
import { watchQualified, crossedWatchThreshold, WATCH_QUALIFY_FRACTION } from './watchSignal.js'

describe('watchQualified', () => {
  it('completed=1 always qualifies, regardless of position/duration', () => {
    expect(watchQualified({ position_secs: 0, duration_secs: 7200, completed: 1 })).toBe(true)
    expect(watchQualified({ position_secs: 0, duration_secs: null, completed: 1 })).toBe(true)
  })

  it('qualifies at or above 40% watched', () => {
    expect(watchQualified({ position_secs: 2880, duration_secs: 7200, completed: 0 })).toBe(true) // exactly 40%
    expect(watchQualified({ position_secs: 6000, duration_secs: 7200, completed: 0 })).toBe(true) // ~83%
  })

  it('does NOT qualify below 40% watched', () => {
    expect(watchQualified({ position_secs: 2879, duration_secs: 7200, completed: 0 })).toBe(false) // just under 40%
    expect(watchQualified({ position_secs: 60, duration_secs: 7200, completed: 0 })).toBe(false) // brief sample
  })

  it('without a usable duration, only completion qualifies (no divide-by-zero)', () => {
    expect(watchQualified({ position_secs: 5000, duration_secs: null, completed: 0 })).toBe(false)
    expect(watchQualified({ position_secs: 5000, duration_secs: 0, completed: 0 })).toBe(false)
  })

  it('the threshold constant is the agreed 40%', () => {
    expect(WATCH_QUALIFY_FRACTION).toBe(0.4)
  })
})

describe('crossedWatchThreshold (fire exactly once on the transition)', () => {
  const QUALIFIED = { position_secs: 3000, duration_secs: 7200, completed: 0 } // ~42%
  const UNDER = { position_secs: 600, duration_secs: 7200, completed: 0 } // ~8%

  it('fires on first qualifying report when there is no prior row', () => {
    expect(crossedWatchThreshold(undefined, QUALIFIED)).toBe(true)
  })

  it('does not fire when the current report is below threshold', () => {
    expect(crossedWatchThreshold(undefined, UNDER)).toBe(false)
    expect(crossedWatchThreshold(UNDER, UNDER)).toBe(false)
  })

  it('fires on the transition under->qualified', () => {
    expect(crossedWatchThreshold(UNDER, QUALIFIED)).toBe(true)
  })

  it('does NOT re-fire once already qualified (every-5s-tick dedup)', () => {
    expect(crossedWatchThreshold(QUALIFIED, QUALIFIED)).toBe(false)
    expect(crossedWatchThreshold(QUALIFIED, { position_secs: 7100, duration_secs: 7200, completed: 1 })).toBe(false)
  })

  it('a re-watch that resets the row to under-threshold can fire again later', () => {
    // prior was a completed watch; row reset to a fresh low position (re-watch)
    const completedPrior = { position_secs: 7100, duration_secs: 7200, completed: 1 }
    expect(crossedWatchThreshold(completedPrior, UNDER)).toBe(false) // reset tick, under
    expect(crossedWatchThreshold(UNDER, QUALIFIED)).toBe(true) // crosses again
  })
})
