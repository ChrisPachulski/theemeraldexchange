import { describe, expect, it } from 'vitest'
import { resolveSeekTarget } from './MediaControls'

describe('resolveSeekTarget', () => {
  // The scrubber spans the whole title; the session only has media from its
  // -ss offset onward. Below the offset = re-grant; at/after = element seek.
  it('maps an in-session target to an element seek in session coordinates', () => {
    expect(resolveSeekTarget({ targetSecs: 700, offsetSecs: 600 })).toEqual({
      kind: 'element',
      sessionSecs: 100,
    })
  })

  it('treats the exact session start as an element seek to 0', () => {
    expect(resolveSeekTarget({ targetSecs: 600, offsetSecs: 600 })).toEqual({
      kind: 'element',
      sessionSecs: 0,
    })
  })

  it('hands a below-floor target back for a re-grant, floored to whole seconds', () => {
    expect(resolveSeekTarget({ targetSecs: 300.7, offsetSecs: 600 })).toEqual({
      kind: 'regrant',
      targetSecs: 300,
    })
  })

  it('clamps negative targets to zero (no negative re-grant offsets)', () => {
    expect(resolveSeekTarget({ targetSecs: -3, offsetSecs: 600 })).toEqual({
      kind: 'regrant',
      targetSecs: 0,
    })
  })

  it('never re-grants when there is no offset (fresh start / progressive)', () => {
    expect(resolveSeekTarget({ targetSecs: 0, offsetSecs: 0 })).toEqual({
      kind: 'element',
      sessionSecs: 0,
    })
    expect(resolveSeekTarget({ targetSecs: 4200, offsetSecs: 0 })).toEqual({
      kind: 'element',
      sessionSecs: 4200,
    })
  })
})
