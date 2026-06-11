import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createReservationLedger, createGrabEventRecorder } from './arrGrab.js'
import { env } from '../env.js'
import { readRecentGrabEvents, _setGrabLogPathForTests } from './grabLog.js'
import * as grabLog from './grabLog.js'

const GB = 1024 ** 3

describe('createReservationLedger', () => {
  const folder = { path: '/data/movies', freeSpace: env.minFreeBytes + 10 * GB }

  it('reserve reduces availability; release restores it', () => {
    const ledger = createReservationLedger()
    expect(ledger.availableBytes(folder)).toBe(folder.freeSpace)
    expect(ledger.reserve(folder, 4 * GB)).toBe(true)
    expect(ledger.availableBytes(folder)).toBe(folder.freeSpace - 4 * GB)
    expect(ledger.pendingBytes(folder)).toBe(4 * GB)
    ledger.release(folder, 4 * GB)
    expect(ledger.availableBytes(folder)).toBe(folder.freeSpace)
    expect(ledger.pendingBytes(folder)).toBe(0)
  })

  it('refuses a reservation that would dip below env.minFreeBytes', () => {
    const ledger = createReservationLedger()
    expect(ledger.reserve(folder, 11 * GB)).toBe(false)
    expect(ledger.pendingBytes(folder)).toBe(0)
  })

  it('second reservation is gated against the reduced availability', () => {
    const ledger = createReservationLedger()
    expect(ledger.reserve(folder, 6 * GB)).toBe(true)
    // 4 GB headroom left above the reserve — a second 6 GB must refuse.
    expect(ledger.reserve(folder, 6 * GB)).toBe(false)
    expect(ledger.pendingBytes(folder)).toBe(6 * GB)
  })

  it('reserve refuses non-finite and non-positive amounts', () => {
    const ledger = createReservationLedger()
    expect(ledger.reserve(folder, NaN)).toBe(false)
    expect(ledger.reserve(folder, Infinity)).toBe(false)
    expect(ledger.reserve(folder, 0)).toBe(false)
    expect(ledger.reserve(folder, -1 * GB)).toBe(false)
    expect(ledger.pendingBytes(folder)).toBe(0)
  })

  it('release guards non-finite and non-positive amounts (the unified divergence fix)', () => {
    // Regression: sonarr's private copy lacked this guard, so a NaN
    // release poisoned the ledger (Math.max(0, reserved - NaN) === NaN)
    // and every later reserve() against the path failed until restart.
    const ledger = createReservationLedger()
    expect(ledger.reserve(folder, 4 * GB)).toBe(true)
    ledger.release(folder, NaN)
    ledger.release(folder, -1 * GB)
    ledger.release(folder, 0)
    expect(ledger.pendingBytes(folder)).toBe(4 * GB)
    // The ledger still arithmetics correctly after the junk releases.
    expect(ledger.reserve(folder, 2 * GB)).toBe(true)
    expect(ledger.pendingBytes(folder)).toBe(6 * GB)
  })

  it('over-release floors at zero instead of going negative', () => {
    const ledger = createReservationLedger()
    expect(ledger.reserve(folder, 2 * GB)).toBe(true)
    ledger.release(folder, 5 * GB)
    expect(ledger.pendingBytes(folder)).toBe(0)
    expect(ledger.availableBytes(folder)).toBe(folder.freeSpace)
  })

  it('a reservation whose release never fires self-heals after the TTL', () => {
    // The 3-day incident: a fully-successful grab skipped its release, so the
    // reservation wedged the free-space gate until the process restarted and
    // 409'd EVERY later add to the folder. With the TTL, a leaked reservation
    // ages out on its own — the gate can no longer be stuck for more than the
    // TTL window. Drive wall-clock with fake timers so the test is instant.
    vi.useFakeTimers()
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const ledger = createReservationLedger('sonarr')
      expect(ledger.reserve(folder, 5 * GB)).toBe(true)
      expect(ledger.pendingBytes(folder)).toBe(5 * GB)

      // Just before the TTL: still held (a live grab is never expired early).
      vi.advanceTimersByTime(14 * 60 * 1000)
      expect(ledger.pendingBytes(folder)).toBe(5 * GB)

      // Past the TTL with no release: the gate self-heals to zero and a new
      // add is admitted again — and the leak is logged loud, not silent.
      vi.advanceTimersByTime(2 * 60 * 1000)
      expect(ledger.pendingBytes(folder)).toBe(0)
      expect(ledger.availableBytes(folder)).toBe(folder.freeSpace)
      expect(ledger.reserve(folder, 5 * GB)).toBe(true)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('stale disk reservation'))
      warn.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ledgers are independent per instance (radarr vs sonarr maps stay separate)', () => {
    const a = createReservationLedger()
    const b = createReservationLedger()
    expect(a.reserve(folder, 4 * GB)).toBe(true)
    expect(b.pendingBytes(folder)).toBe(0)
    expect(b.availableBytes(folder)).toBe(folder.freeSpace)
  })
})

describe('createGrabEventRecorder', () => {
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(join(tmpdir(), 'arr-grab-'))
    _setGrabLogPathForTests(join(tmpRoot, 'grabs.jsonl'))
  })

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('injects the app and persists the event', async () => {
    const record = createGrabEventRecorder('radarr')
    await record({ itemId: 7, type: 'grab_started', sub: 'plex:42' })
    const events = await readRecentGrabEvents(5)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ app: 'radarr', itemId: 7, type: 'grab_started', sub: 'plex:42' })
  })

  it('swallows append failures instead of failing the grab pipeline', async () => {
    vi.spyOn(grabLog, 'appendGrabEvent').mockRejectedValue(new Error('disk full'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const record = createGrabEventRecorder('sonarr')
    await expect(record({ itemId: 1, type: 'grab_failed' })).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledWith('[sonarr] grab log write failed:', expect.any(Error))
  })
})
