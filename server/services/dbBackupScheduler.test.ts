import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import cron from 'node-cron'

vi.mock('./dbBackup.js', () => ({ runScheduledBackup: vi.fn() }))
vi.mock('./serverTelemetry.js', () => ({ reportServerEvent: vi.fn(async () => {}) }))

import { runScheduledBackup } from './dbBackup.js'
import { reportServerEvent } from './serverTelemetry.js'
import { registerDbBackupSchedule } from './dbBackupScheduler.js'

const mockRunScheduledBackup = vi.mocked(runScheduledBackup) as unknown as Mock
const mockReportServerEvent = vi.mocked(reportServerEvent) as unknown as Mock

const DEFAULT_DB_BACKUP_CRON = '30 3 * * *'

/**
 * Spy on cron.schedule, recording the first arg (the expression) and capturing
 * the registered callback so tests can invoke the backup body directly. Mirrors
 * the `as typeof cron.schedule` cast idiom from iptvScheduler.test.ts so the
 * node-cron v4 `func` signature does not reject our zero-arg test callback.
 */
function spyOnSchedule(): {
  calls: string[]
  getCallback: () => (() => void) | undefined
  stopSpy: Mock
} {
  const calls: string[] = []
  let callback: (() => void) | undefined
  const stopSpy = vi.fn()
  vi.spyOn(cron, 'schedule').mockImplementation(((expr: string, fn: unknown) => {
    calls.push(expr)
    if (typeof fn === 'function') {
      callback = fn as () => void
    }
    return { stop: stopSpy, start: () => undefined } as unknown as ReturnType<typeof cron.schedule>
  }) as typeof cron.schedule)
  return { calls, getCallback: () => callback, stopSpy }
}

describe('registerDbBackupSchedule', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // restoreAllMocks restores spies but does not clear the call history of the
    // vi.mock()-created module mocks; reset them so per-test assertions on call
    // count start from zero.
    mockRunScheduledBackup.mockReset()
    mockReportServerEvent.mockReset()
    mockReportServerEvent.mockImplementation(async () => {})
    mockRunScheduledBackup.mockReturnValue({
      files: ['/tmp/server-x.db', '/tmp/iptv-x.db'],
      dir: '/tmp/backups',
      stampedAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('schedules at the configured cron when it is valid', () => {
    vi.spyOn(cron, 'validate').mockReturnValue(true)
    const { calls } = spyOnSchedule()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    registerDbBackupSchedule('15 2 * * *')

    expect(calls[0]).toBe('15 2 * * *')
    // No invalid-cron warning when the expression is accepted.
    expect(errSpy).not.toHaveBeenCalled()
  })

  it("falls back to DEFAULT_DB_BACKUP_CRON ('30 3 * * *') when the expression is invalid", () => {
    vi.spyOn(cron, 'validate').mockReturnValue(false)
    const { calls } = spyOnSchedule()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    registerDbBackupSchedule('not-a-cron')

    expect(calls[0]).toBe(DEFAULT_DB_BACKUP_CRON)
    expect(errSpy).toHaveBeenCalledTimes(1)
    const logged = String(errSpy.mock.calls[0]?.[0] ?? '')
    expect(logged).toContain('not-a-cron')
    expect(logged).toContain(DEFAULT_DB_BACKUP_CRON)
  })

  it('returns the scheduled task so shutdown can stop it (finding 14-2)', () => {
    vi.spyOn(cron, 'validate').mockReturnValue(true)
    const { stopSpy } = spyOnSchedule()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const task = registerDbBackupSchedule('15 2 * * *')

    expect(typeof task.stop).toBe('function')
    expect(() => task.stop()).not.toThrow()
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  it('logs a snapshot-ok line on a successful backup run', () => {
    vi.spyOn(cron, 'validate').mockReturnValue(true)
    const { getCallback } = spyOnSchedule()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    registerDbBackupSchedule('15 2 * * *')
    const callback = getCallback()
    expect(callback).toBeDefined()
    callback!()

    expect(mockRunScheduledBackup).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalledTimes(1)
    const logged = String(logSpy.mock.calls[0]?.[0] ?? '')
    expect(logged).toContain('snapshot ok')
    expect(logged).toContain('2 file(s)')
    expect(logged).toContain('/tmp/backups')
  })

  it('relays a §15 telemetry error event when the backup throws', () => {
    vi.spyOn(cron, 'validate').mockReturnValue(true)
    const { getCallback } = spyOnSchedule()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockRunScheduledBackup.mockImplementation(() => {
      throw new Error('disk full')
    })

    registerDbBackupSchedule('15 2 * * *')
    const callback = getCallback()
    expect(callback).toBeDefined()

    // try/catch in the scheduler must absorb the throw.
    expect(() => callback!()).not.toThrow()
    expect(errSpy).toHaveBeenCalled()
    expect(mockReportServerEvent).toHaveBeenCalledTimes(1)
    expect(mockReportServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        message: 'scheduled DB backup failed',
        context: { error: 'disk full' },
      }),
    )
  })

  it('stringifies non-Error throwables in the telemetry context', () => {
    vi.spyOn(cron, 'validate').mockReturnValue(true)
    const { getCallback } = spyOnSchedule()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockRunScheduledBackup.mockImplementation(() => {
      throw 'boom'
    })

    registerDbBackupSchedule('15 2 * * *')
    const callback = getCallback()
    expect(callback).toBeDefined()
    callback!()

    expect(mockReportServerEvent).toHaveBeenCalledTimes(1)
    const arg = mockReportServerEvent.mock.calls[0]?.[0] as { context: { error: unknown } }
    expect(arg.context.error).toBe('boom')
  })
})
