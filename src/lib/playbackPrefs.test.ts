import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PLAYBACK_PREFS,
  canonicalLanguage,
  getPlaybackPrefs,
  parsePlaybackPrefs,
  preferredTrackIndex,
  rememberShowSubtitle,
  setPlaybackPrefs,
  showTrackMemory,
  startupSubtitleIndex,
  subtitleCueVars,
} from './playbackPrefs'

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})

describe('playback prefs storage', () => {
  it('defaults when nothing (or garbage) is stored', () => {
    expect(getPlaybackPrefs()).toEqual(DEFAULT_PLAYBACK_PREFS)
    expect(parsePlaybackPrefs('not json')).toEqual(DEFAULT_PLAYBACK_PREFS)
    expect(parsePlaybackPrefs(JSON.stringify({ speed: 3, subtitleMode: 'sometimes' }))).toEqual(
      DEFAULT_PLAYBACK_PREFS,
    )
  })

  it('keeps only an offered Quality cap, defaulting to Original', () => {
    expect(DEFAULT_PLAYBACK_PREFS.maxBitrate).toBe(0)
    expect(parsePlaybackPrefs(JSON.stringify({ maxBitrate: 8_000_000 })).maxBitrate).toBe(8_000_000)
    expect(parsePlaybackPrefs(JSON.stringify({ maxBitrate: 5_000_000 })).maxBitrate).toBe(0)
    expect(parsePlaybackPrefs(JSON.stringify({ maxBitrate: '8000000' })).maxBitrate).toBe(0)
  })

  it('persists a patch and returns a stable snapshot until it changes', () => {
    const before = getPlaybackPrefs()
    expect(getPlaybackPrefs()).toBe(before)
    setPlaybackPrefs({ speed: 1.5, autoplayNext: false })
    const after = getPlaybackPrefs()
    expect(after).not.toBe(before)
    expect(after).toMatchObject({ speed: 1.5, autoplayNext: false, subtitleMode: 'off' })
  })

  it('degrades to defaults when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    expect(() => setPlaybackPrefs({ speed: 2 })).not.toThrow()
    expect(getPlaybackPrefs()).toEqual(DEFAULT_PLAYBACK_PREFS)
  })

  it('remembers a per-show subtitle language or an explicit Off', () => {
    expect(showTrackMemory(7)).toBeNull()
    rememberShowSubtitle(7, 'es')
    rememberShowSubtitle(8, null)
    expect(showTrackMemory(7)).toEqual({ subtitleLanguage: 'es' })
    expect(showTrackMemory(8)).toEqual({ subtitleOff: true })
    rememberShowSubtitle(7, null)
    expect(showTrackMemory(7)).toEqual({ subtitleOff: true })
  })
})

describe('language matching', () => {
  it('canonicalises ISO 639-2 and region tags', () => {
    expect(canonicalLanguage('eng')).toBe('en')
    expect(canonicalLanguage('fre')).toBe('fr')
    expect(canonicalLanguage('pt-BR')).toBe('pt')
    expect(canonicalLanguage('EN')).toBe('en')
  })

  it('picks by tag first, then by label', () => {
    expect(preferredTrackIndex([{ language: 'fra' }, { language: 'eng' }], 'en')).toBe(1)
    expect(preferredTrackIndex([{ label: 'Commentary' }, { label: 'English 5.1' }], 'en')).toBe(1)
    expect(preferredTrackIndex([{ language: 'ja' }], 'en')).toBe(-1)
    expect(preferredTrackIndex([{ language: 'en' }], '')).toBe(-1)
  })
})

describe('startupSubtitleIndex', () => {
  const tracks = [{ language: 'eng' }, { language: 'spa' }]
  const prefs = { subtitleMode: 'off' as const, subtitleLanguage: 'en', audioLanguage: 'en' }

  it('leaves the default alone with mode Off and no memory', () => {
    expect(startupSubtitleIndex({ tracks, memory: null, prefs, playingAudioLanguage: 'ja' })).toBeNull()
  })

  it('Always shows the preferred language', () => {
    const p = { ...prefs, subtitleMode: 'always' as const, subtitleLanguage: 'es' }
    expect(startupSubtitleIndex({ tracks, memory: null, prefs: p, playingAudioLanguage: null })).toBe(1)
  })

  it('foreign-audio mode only fires when the playing audio is known and foreign', () => {
    const p = { ...prefs, subtitleMode: 'foreignOnly' as const }
    expect(startupSubtitleIndex({ tracks, memory: null, prefs: p, playingAudioLanguage: 'jpn' })).toBe(0)
    expect(startupSubtitleIndex({ tracks, memory: null, prefs: p, playingAudioLanguage: 'eng' })).toBeNull()
    expect(startupSubtitleIndex({ tracks, memory: null, prefs: p, playingAudioLanguage: null })).toBeNull()
  })

  it('per-show memory beats prefs, and a remembered Off turns everything off', () => {
    const p = { ...prefs, subtitleMode: 'always' as const }
    expect(
      startupSubtitleIndex({ tracks, memory: { subtitleOff: true }, prefs: p, playingAudioLanguage: null }),
    ).toBe(-1)
    expect(
      startupSubtitleIndex({ tracks, memory: { subtitleLanguage: 'es' }, prefs, playingAudioLanguage: null }),
    ).toBe(1)
  })
})

describe('subtitleCueVars', () => {
  it('is null for all-default appearance (system styling stays in charge)', () => {
    expect(subtitleCueVars(DEFAULT_PLAYBACK_PREFS)).toBeNull()
  })

  it('emits only the overridden properties', () => {
    expect(
      subtitleCueVars({ subtitleSize: 'large', subtitleColor: 'white', subtitleBackground: 'solid' }),
    ).toEqual({ '--cue-size': '140%', '--cue-bg': '#000' })
  })
})
