import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Role, Session } from '../session.js'

// Mock the serverDb dependency so ensureServerId is fully controllable —
// the module under test memoizes its result and latches its failure, so
// the test asserts call-count and the no-Bearer degrade path off this mock.
vi.mock('./serverDb.js', () => ({ ensureServerId: vi.fn() }))

/** Build a minimal Session fixture. recommenderCallerFromSession only
 *  reads `sub` and `role`; username is required by the type but unused. */
function makeSession(sub: string, role: Role = 'user'): Session {
  return { sub, username: 'u', role }
}

describe('recommenderCallerFromSession', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    // Module-level state (cachedServerId + serverIdFailed latch) leaks
    // across tests — reset both before every case.
    const { _resetServerIdForTests } = await import('./recommenderCaller.js')
    _resetServerIdForTests()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('builds a caller with serverId when ensureServerId succeeds', async () => {
    const { ensureServerId } = await import('./serverDb.js')
    vi.mocked(ensureServerId).mockReturnValue('server-uuid-1')

    const { recommenderCallerFromSession } = await import('./recommenderCaller.js')
    const result = recommenderCallerFromSession(makeSession('plex:12345'))

    expect(result).toEqual({
      sub: 'plex:12345',
      role: 'user',
      authMode: 'plex',
      serverId: 'server-uuid-1',
    })
  })

  it('memoizes serverId — ensureServerId is called once across multiple calls', async () => {
    const { ensureServerId } = await import('./serverDb.js')
    vi.mocked(ensureServerId).mockReturnValue('server-uuid-1')

    const { recommenderCallerFromSession } = await import('./recommenderCaller.js')
    const first = recommenderCallerFromSession(makeSession('plex:12345'))
    const second = recommenderCallerFromSession(makeSession('plex:67890'))

    expect(vi.mocked(ensureServerId)).toHaveBeenCalledTimes(1)
    expect(first?.serverId).toBe('server-uuid-1')
    expect(second?.serverId).toBe('server-uuid-1')
  })

  it("derives authMode 'local' for local: subs", async () => {
    const { ensureServerId } = await import('./serverDb.js')
    vi.mocked(ensureServerId).mockReturnValue('server-uuid-1')

    const { recommenderCallerFromSession } = await import('./recommenderCaller.js')
    const result = recommenderCallerFromSession(makeSession('local:01ABC'))

    expect(result?.authMode).toBe('local')
  })

  it("derives authMode 'apple' for apple: subs", async () => {
    const { ensureServerId } = await import('./serverDb.js')
    vi.mocked(ensureServerId).mockReturnValue('server-uuid-1')

    const { recommenderCallerFromSession } = await import('./recommenderCaller.js')
    const result = recommenderCallerFromSession(makeSession('apple:xyz'))

    expect(result?.authMode).toBe('apple')
  })

  it('returns undefined and warns when ensureServerId throws', async () => {
    const { ensureServerId } = await import('./serverDb.js')
    vi.mocked(ensureServerId).mockImplementation(() => {
      throw new Error('server.db unavailable')
    })

    const { recommenderCallerFromSession } = await import('./recommenderCaller.js')
    const result = recommenderCallerFromSession(makeSession('plex:12345'))

    expect(result).toBeUndefined()
    expect(console.warn).toHaveBeenCalled()
    const warnArgs = vi.mocked(console.warn).mock.calls[0]
    expect(warnArgs.join(' ')).toContain('[recommenderCaller]')
  })

  it('latches the failure — ensureServerId is NOT retried after a throw', async () => {
    const { ensureServerId } = await import('./serverDb.js')
    vi.mocked(ensureServerId).mockImplementation(() => {
      throw new Error('server.db unavailable')
    })

    const { recommenderCallerFromSession } = await import('./recommenderCaller.js')
    const first = recommenderCallerFromSession(makeSession('plex:12345'))
    const second = recommenderCallerFromSession(makeSession('plex:12345'))

    expect(first).toBeUndefined()
    expect(second).toBeUndefined()
    expect(vi.mocked(ensureServerId)).toHaveBeenCalledTimes(1)
  })

  it('_resetServerIdForTests clears both the cache and the failure latch', async () => {
    const { ensureServerId } = await import('./serverDb.js')
    vi.mocked(ensureServerId).mockImplementation(() => {
      throw new Error('server.db unavailable')
    })

    const { recommenderCallerFromSession, _resetServerIdForTests } = await import(
      './recommenderCaller.js'
    )
    const latched = recommenderCallerFromSession(makeSession('plex:12345'))
    expect(latched).toBeUndefined()

    // Clear the latch, then make ensureServerId succeed — the next call
    // must retry (proving serverIdFailed was reset, not just cachedServerId).
    _resetServerIdForTests()
    vi.mocked(ensureServerId).mockReset()
    vi.mocked(ensureServerId).mockReturnValue('server-uuid-2')

    const recovered = recommenderCallerFromSession(makeSession('plex:12345'))
    expect(recovered).toEqual({
      sub: 'plex:12345',
      role: 'user',
      authMode: 'plex',
      serverId: 'server-uuid-2',
    })
  })
})
