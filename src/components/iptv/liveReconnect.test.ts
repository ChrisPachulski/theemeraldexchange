import { describe, expect, it } from 'vitest'
import { RECONNECT_ATTEMPTS, SLOT_RELEASE_GRACE_MS, reconnectWaitMs } from './liveReconnect'

// Ported from the Apple app's LiveReconnectPolicyTests.
describe('reconnectWaitMs', () => {
  it('waits the backoff plus the slot-release grace for each attempt', () => {
    expect(reconnectWaitMs(0)).toBe(SLOT_RELEASE_GRACE_MS)
    expect(reconnectWaitMs(1)).toBe(3_000 + SLOT_RELEASE_GRACE_MS)
    expect(reconnectWaitMs(RECONNECT_ATTEMPTS - 1)).toBe(24_000 + SLOT_RELEASE_GRACE_MS)
  })

  it('is null once the budget is spent (or for a bad index)', () => {
    expect(reconnectWaitMs(RECONNECT_ATTEMPTS)).toBeNull()
    expect(reconnectWaitMs(-1)).toBeNull()
  })
})
