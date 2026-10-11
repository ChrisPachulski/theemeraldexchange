// createFatalHlsErrorHandler's live hand-off (onLost): a live owner that can
// mint a fresh grant gets the terminal network states instead of an in-player
// dead end. Without onLost the handler keeps its original messages (covered in
// IptvPlayer.test.tsx).
import { describe, expect, it, vi } from 'vitest'
import { createFatalHlsErrorHandler, MAX_NET_RETRIES, type RecoverableHls } from './IptvPlayer'

function harness(withOwner = true) {
  const hls: RecoverableHls = {
    startLoad: vi.fn(),
    recoverMediaError: vi.fn(),
    swapAudioCodec: vi.fn(),
    destroy: vi.fn(),
  }
  const setError = vi.fn()
  const onLost = vi.fn()
  const scheduled: Array<() => void> = []
  const { onFatalError } = createFatalHlsErrorHandler({
    hls,
    isCancelled: () => false,
    setError,
    onLost: withOwner ? onLost : undefined,
    schedule: (fn) => scheduled.push(fn),
  })
  return { hls, setError, onLost, scheduled, onFatalError }
}

describe('createFatalHlsErrorHandler onLost', () => {
  it('hands an off-air channel to the owner, not an in-player message', () => {
    const h = harness()
    h.onFatalError('network', { code: 503, text: '{"error":"channel_offline_upstream"}' })
    expect(h.onLost).toHaveBeenCalledWith('offline')
    expect(h.setError).not.toHaveBeenCalled()
    expect(h.hls.destroy).toHaveBeenCalledTimes(1)
  })

  it('hands a swept session (410) to the owner at once instead of retrying the dead grant', () => {
    const h = harness()
    h.onFatalError('network', { code: 410, text: 'Gone' })
    expect(h.onLost).toHaveBeenCalledWith('gone')
    expect(h.scheduled).toHaveLength(0)
  })

  it('hands a spent retry budget to the owner', () => {
    const h = harness()
    for (let i = 0; i < MAX_NET_RETRIES; i += 1) h.onFatalError('network')
    expect(h.onLost).not.toHaveBeenCalled()
    h.onFatalError('network')
    expect(h.onLost).toHaveBeenCalledWith('exhausted')
    expect(h.setError).not.toHaveBeenCalled()
  })

  it('without an owner a 410 still retries and media errors are untouched', () => {
    const h = harness(false)
    h.onFatalError('network', { code: 410, text: 'Gone' })
    expect(h.scheduled).toHaveLength(1)
    h.onFatalError('media')
    expect(h.hls.recoverMediaError).toHaveBeenCalledTimes(1)
  })
})
