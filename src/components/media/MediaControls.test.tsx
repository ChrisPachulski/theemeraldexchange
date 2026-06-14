import { describe, expect, it } from 'vitest'
import {
  applySubtitleSelection,
  nextSubtitleToggleIndex,
  resolveSeekTarget,
  showingSubtitleIndex,
  subtitleTrackIndexes,
  type TextTrackListLike,
} from './MediaControls'

// Build a TextTrackList-like from plain track descriptors. Mutable `mode`
// so applySubtitleSelection's writes are observable.
function trackList(
  tracks: Array<{ kind: string; mode?: string; label?: string }>,
): TextTrackListLike {
  const arr = tracks.map((t) => ({ mode: 'disabled', ...t }))
  return Object.assign(
    { length: arr.length },
    Object.fromEntries(arr.map((t, i) => [i, t])),
  ) as unknown as TextTrackListLike
}

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

  it('re-grants a forward seek past the produced edge (segments not made yet)', () => {
    // Session offset 600, only 100 s produced so far; a jump to 2000 (1400 s
    // into the session) is far past the edge → re-grant at the absolute target.
    expect(
      resolveSeekTarget({ targetSecs: 2000, offsetSecs: 600, seekableEndSecs: 100 }),
    ).toEqual({ kind: 'regrant', targetSecs: 2000 })
  })

  it('element-seeks a forward target still within the produced edge', () => {
    expect(
      resolveSeekTarget({ targetSecs: 650, offsetSecs: 600, seekableEndSecs: 100 }),
    ).toEqual({ kind: 'element', sessionSecs: 50 })
  })

  it('does not re-grant within the edge epsilon (encoder is about to reach it)', () => {
    // sessionSecs 102 is just past a 100 s edge but within the 5 s tolerance.
    expect(
      resolveSeekTarget({ targetSecs: 102, offsetSecs: 0, seekableEndSecs: 100 }),
    ).toEqual({ kind: 'element', sessionSecs: 102 })
  })

  it('ignores the edge when it is unknown (null) — plain in-session seek', () => {
    expect(
      resolveSeekTarget({ targetSecs: 4200, offsetSecs: 0, seekableEndSecs: null }),
    ).toEqual({ kind: 'element', sessionSecs: 4200 })
  })

  it('below-offset re-grant wins regardless of the produced edge', () => {
    expect(
      resolveSeekTarget({ targetSecs: 300, offsetSecs: 600, seekableEndSecs: 100 }),
    ).toEqual({ kind: 'regrant', targetSecs: 300 })
  })
})

describe('subtitle toggle helpers', () => {
  it('subtitleTrackIndexes returns only subtitle/caption tracks, in order', () => {
    const tracks = trackList([
      { kind: 'metadata' },
      { kind: 'subtitles' },
      { kind: 'chapters' },
      { kind: 'captions' },
    ])
    expect(subtitleTrackIndexes(tracks)).toEqual([1, 3])
  })

  it('subtitleTrackIndexes is empty for no tracks / missing list', () => {
    expect(subtitleTrackIndexes(trackList([]))).toEqual([])
    expect(subtitleTrackIndexes(undefined)).toEqual([])
    expect(subtitleTrackIndexes(null)).toEqual([])
  })

  it('showingSubtitleIndex finds the showing subtitle track, else -1', () => {
    expect(
      showingSubtitleIndex(trackList([{ kind: 'subtitles', mode: 'disabled' }])),
    ).toBe(-1)
    expect(
      showingSubtitleIndex(
        trackList([{ kind: 'metadata', mode: 'showing' }, { kind: 'subtitles', mode: 'showing' }]),
      ),
    ).toBe(1)
  })

  it('nextSubtitleToggleIndex: off → show first; on → off; none → null', () => {
    // Off (forced track shipped disabled) → turn on the first subtitle track.
    expect(
      nextSubtitleToggleIndex(trackList([{ kind: 'metadata' }, { kind: 'subtitles' }])),
    ).toBe(1)
    // A subtitle is showing → next toggle turns everything off.
    expect(
      nextSubtitleToggleIndex(trackList([{ kind: 'subtitles', mode: 'showing' }])),
    ).toBe(-1)
    // No subtitle tracks → nothing to toggle.
    expect(nextSubtitleToggleIndex(trackList([{ kind: 'metadata' }]))).toBeNull()
  })

  it('applySubtitleSelection shows the chosen track and disables the others', () => {
    const tracks = trackList([
      { kind: 'subtitles', mode: 'disabled' },
      { kind: 'subtitles', mode: 'showing' },
    ])
    applySubtitleSelection({ textTracks: tracks } as never, 0)
    expect(tracks[0].mode).toBe('showing')
    expect(tracks[1].mode).toBe('disabled')
  })

  it('applySubtitleSelection(-1) turns every subtitle track off', () => {
    const tracks = trackList([{ kind: 'subtitles', mode: 'showing' }])
    applySubtitleSelection({ textTracks: tracks } as never, -1)
    expect(tracks[0].mode).toBe('disabled')
  })

  it('applySubtitleSelection never touches non-subtitle tracks', () => {
    const tracks = trackList([
      { kind: 'metadata', mode: 'showing' },
      { kind: 'subtitles', mode: 'disabled' },
    ])
    applySubtitleSelection({ textTracks: tracks } as never, 1)
    expect(tracks[0].mode).toBe('showing') // metadata untouched
    expect(tracks[1].mode).toBe('showing')
  })
})
