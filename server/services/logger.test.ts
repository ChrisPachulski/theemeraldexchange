import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createLogger, _setLogLevelForTests } from './logger.js'

describe('structured logger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    _setLogLevelForTests('info')
  })

  afterEach(() => {
    logSpy.mockRestore()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
    _setLogLevelForTests(null)
  })

  it('emits "[tag] message" with JSON context appended', () => {
    const log = createLogger('test-tag')
    log.info('something happened', { itemId: 7, sizeGb: 4.2 })
    expect(logSpy).toHaveBeenCalledWith('[test-tag] something happened {"itemId":7,"sizeGb":4.2}')
  })

  it('omits the JSON blob when no context is given', () => {
    createLogger('bare').info('plain line')
    expect(logSpy).toHaveBeenCalledWith('[bare] plain line')
  })

  it('routes warn/error to their console channels', () => {
    const log = createLogger('chan')
    log.warn('careful')
    log.error('broken')
    expect(warnSpy).toHaveBeenCalledWith('[chan] careful')
    expect(errorSpy).toHaveBeenCalledWith('[chan] broken')
  })

  it('filters below the active level (debug suppressed at info)', () => {
    const log = createLogger('lvl')
    log.debug('noise')
    expect(logSpy).not.toHaveBeenCalled()
    _setLogLevelForTests('debug')
    log.debug('now visible')
    expect(logSpy).toHaveBeenCalledWith('[lvl] now visible')
  })

  it('at LOG_LEVEL=error only error lines pass', () => {
    _setLogLevelForTests('error')
    const log = createLogger('quiet')
    log.info('dropped')
    log.warn('dropped too')
    log.error('kept')
    expect(logSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith('[quiet] kept')
  })

  it('serializes Error values in context instead of {}', () => {
    createLogger('err').error('upstream blew up', { error: new Error('boom') })
    expect(errorSpy).toHaveBeenCalledWith(
      '[err] upstream blew up {"error":{"name":"Error","message":"boom"}}',
    )
  })

  it('never throws on circular context', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => createLogger('circ').info('round and round', circular)).not.toThrow()
    expect(logSpy).toHaveBeenCalledWith(
      '[circ] round and round {"logger_error":"unserializable_context"}',
    )
  })
})
