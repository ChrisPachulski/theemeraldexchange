// Device-local playback preferences — the web twin of the Apple app's
// @AppStorage playback settings (autoplay next episode, speed, subtitle
// mode/language/appearance, audio language) plus per-show subtitle memory.
// localStorage only: the server has no user-prefs endpoint.
import { useSyncExternalStore } from 'react'

export type SubtitleMode = 'off' | 'always' | 'foreignOnly'
export type SubtitleSize = 'small' | 'normal' | 'large' | 'huge'
export type SubtitleColor = 'white' | 'yellow' | 'cyan'
export type SubtitleBackground = 'default' | 'none' | 'translucent' | 'solid'

export type PlaybackPrefs = {
  autoplayNext: boolean
  speed: number
  subtitleMode: SubtitleMode
  subtitleLanguage: string
  /** '' = Original: leave the engine's own audio pick. */
  audioLanguage: string
  subtitleSize: SubtitleSize
  subtitleColor: SubtitleColor
  subtitleBackground: SubtitleBackground
  /** Peak streaming bitrate cap, bits/s; 0 = Original (uncapped). The server
   *  re-encodes anything over it with its peak held under the cap. */
  maxBitrate: number
}

// Apple defaults: autoplay on, English audio + subtitle language, subtitles
// never auto-enabled, system caption styling.
export const DEFAULT_PLAYBACK_PREFS: PlaybackPrefs = {
  autoplayNext: true,
  speed: 1,
  subtitleMode: 'off',
  subtitleLanguage: 'en',
  audioLanguage: 'en',
  subtitleSize: 'normal',
  subtitleColor: 'white',
  subtitleBackground: 'default',
  maxBitrate: 0,
}

export const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2]
export const SUBTITLE_MODES: ReadonlyArray<{ value: SubtitleMode; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'always', label: 'Always' },
  { value: 'foreignOnly', label: 'On foreign audio' },
]
export const SUBTITLE_SIZES: ReadonlyArray<{ value: SubtitleSize; label: string }> = [
  { value: 'small', label: 'Small' },
  { value: 'normal', label: 'Normal' },
  { value: 'large', label: 'Large' },
  { value: 'huge', label: 'Huge' },
]
export const SUBTITLE_COLORS: ReadonlyArray<{ value: SubtitleColor; label: string }> = [
  { value: 'white', label: 'White' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'cyan', label: 'Cyan' },
]
export const SUBTITLE_BACKGROUNDS: ReadonlyArray<{ value: SubtitleBackground; label: string }> = [
  { value: 'default', label: 'Default' },
  { value: 'none', label: 'None' },
  { value: 'translucent', label: 'Translucent' },
  { value: 'solid', label: 'Solid' },
]
/** Apple's StreamQualityCap options and labels. */
export const QUALITY_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'Original (Max)' },
  { value: 20_000_000, label: '20 Mbps' },
  { value: 12_000_000, label: '12 Mbps' },
  { value: 8_000_000, label: '8 Mbps' },
  { value: 4_000_000, label: '4 Mbps' },
  { value: 2_000_000, label: '2 Mbps' },
]
/** Curated picker list (Apple's TrackPreferences.pickerLanguages). Matching is
 *  canonical, so any track language still matches; this is only what's offered. */
export const PICKER_LANGUAGES = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh',
  'hi', 'ar', 'ru', 'nl', 'pl', 'sv', 'tr',
]

const PREFS_KEY = 'eex.playback'
const MEMORY_KEY = 'eex.playback.trackMemory'

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeRaw(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable — the choice just isn't persisted */
  }
}

function parseJson(raw: string | null): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw ?? 'null')
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function oneOf<T>(value: unknown, allowed: ReadonlyArray<{ value: T }>, fallback: T): T {
  return allowed.some((o) => o.value === value) ? (value as T) : fallback
}

/** Stored JSON -> prefs; unknown or missing fields fall back to the defaults. */
export function parsePlaybackPrefs(raw: string | null): PlaybackPrefs {
  const o = parseJson(raw)
  const d = DEFAULT_PLAYBACK_PREFS
  return {
    autoplayNext: typeof o.autoplayNext === 'boolean' ? o.autoplayNext : d.autoplayNext,
    speed: SPEED_OPTIONS.includes(o.speed as number) ? (o.speed as number) : d.speed,
    subtitleMode: oneOf(o.subtitleMode, SUBTITLE_MODES, d.subtitleMode),
    subtitleLanguage: typeof o.subtitleLanguage === 'string' && o.subtitleLanguage ? o.subtitleLanguage : d.subtitleLanguage,
    audioLanguage: typeof o.audioLanguage === 'string' ? o.audioLanguage : d.audioLanguage,
    subtitleSize: oneOf(o.subtitleSize, SUBTITLE_SIZES, d.subtitleSize),
    subtitleColor: oneOf(o.subtitleColor, SUBTITLE_COLORS, d.subtitleColor),
    subtitleBackground: oneOf(o.subtitleBackground, SUBTITLE_BACKGROUNDS, d.subtitleBackground),
    maxBitrate: oneOf(o.maxBitrate, QUALITY_OPTIONS, d.maxBitrate),
  }
}

// Snapshot keyed by the raw stored string so useSyncExternalStore gets a
// stable object until the value actually changes.
let snapshot: { raw: string | null; prefs: PlaybackPrefs } | null = null
const listeners = new Set<() => void>()

export function getPlaybackPrefs(): PlaybackPrefs {
  const raw = readRaw(PREFS_KEY)
  if (!snapshot || snapshot.raw !== raw) snapshot = { raw, prefs: parsePlaybackPrefs(raw) }
  return snapshot.prefs
}

export function setPlaybackPrefs(patch: Partial<PlaybackPrefs>): void {
  writeRaw(PREFS_KEY, JSON.stringify({ ...getPlaybackPrefs(), ...patch }))
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Live prefs: every component using this re-renders when any of them changes
 *  a setting (the player's settings popover and the account panel share it). */
export function usePlaybackPrefs(): PlaybackPrefs {
  return useSyncExternalStore(subscribe, getPlaybackPrefs, () => DEFAULT_PLAYBACK_PREFS)
}

// ── Per-show subtitle memory ─────────────────────────────────────────

/** What the viewer last chose for a show, by language (track indexes differ per
 *  episode). `subtitleOff` records an explicit Off so later episodes never
 *  re-enable subtitles the viewer turned off for this show. */
export type ShowTrackMemory = { subtitleLanguage?: string; subtitleOff?: boolean }

export function showTrackMemory(showId: number): ShowTrackMemory | null {
  const m = parseJson(readRaw(MEMORY_KEY))[String(showId)]
  return m && typeof m === 'object' ? (m as ShowTrackMemory) : null
}

/** Remember a subtitle pick for a show: a language, or null for an explicit Off. */
export function rememberShowSubtitle(showId: number, language: string | null): void {
  const all = parseJson(readRaw(MEMORY_KEY))
  all[String(showId)] = language ? { subtitleLanguage: language } : { subtitleOff: true }
  writeRaw(MEMORY_KEY, JSON.stringify(all))
}

// ── Language matching + startup track decisions ──────────────────────

/** Primary language subtag, canonicalised so 'eng', 'en-US' and 'EN' all
 *  compare equal to 'en' (Intl.Locale applies the ISO 639-2/3 aliases). */
export function canonicalLanguage(tag: string): string {
  try {
    return new Intl.Locale(tag).language
  } catch {
    return tag.toLowerCase().split(/[-_]/)[0]
  }
}

export function languageMatches(tag: string | null | undefined, language: string): boolean {
  return !!tag && !!language && canonicalLanguage(tag) === canonicalLanguage(language)
}

export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

export type TrackInfo = { language?: string | null; label?: string | null }

/** Index of the first track tagged `language`, else the first whose label
 *  names it ("English 5.1"); -1 when none matches. */
export function preferredTrackIndex(tracks: ReadonlyArray<TrackInfo>, language: string): number {
  if (!language) return -1
  const byTag = tracks.findIndex((t) => languageMatches(t.language, language))
  if (byTag >= 0) return byTag
  const name = languageName(language).toLowerCase()
  return tracks.findIndex((t) => t.label?.toLowerCase().includes(name) ?? false)
}

/** Which subtitle track a fresh item opens with (Apple's TrackStartup):
 *  per-show memory > the viewer's mode/language > leave the default alone.
 *  Returns a track index to show, -1 to turn every track off, or null to leave
 *  the engine's default (a forced track keeps showing). An unknown playing
 *  audio language never counts as foreign — no auto-enable on guesses. */
export function startupSubtitleIndex(args: {
  tracks: ReadonlyArray<TrackInfo>
  memory: ShowTrackMemory | null
  prefs: Pick<PlaybackPrefs, 'subtitleMode' | 'subtitleLanguage' | 'audioLanguage'>
  playingAudioLanguage: string | null
}): number | null {
  const { tracks, memory, prefs, playingAudioLanguage } = args
  const pick = (language: string) => {
    const i = preferredTrackIndex(tracks, language)
    return i >= 0 ? i : null
  }
  if (memory?.subtitleOff) return -1
  if (memory?.subtitleLanguage) return pick(memory.subtitleLanguage)
  if (prefs.subtitleMode === 'always') return pick(prefs.subtitleLanguage)
  if (
    prefs.subtitleMode === 'foreignOnly' &&
    playingAudioLanguage &&
    prefs.audioLanguage &&
    !languageMatches(playingAudioLanguage, prefs.audioLanguage)
  ) {
    return pick(prefs.subtitleLanguage)
  }
  return null
}

// ── Subtitle appearance ──────────────────────────────────────────────

const SIZE_PERCENT: Record<SubtitleSize, number> = { small: 80, normal: 100, large: 140, huge: 180 }
const COLOR_CSS: Record<SubtitleColor, string> = {
  white: '#fff',
  yellow: 'rgb(255 214 0)',
  cyan: 'rgb(102 230 255)',
}
const BACKGROUND_CSS: Record<SubtitleBackground, string | null> = {
  default: null,
  none: 'transparent',
  translucent: 'rgb(0 0 0 / 0.55)',
  solid: '#000',
}

/** CSS custom properties the `::cue` rule reads (index.css). Null when every
 *  field is default, so the browser's own caption styling stays in charge. */
export function subtitleCueVars(
  prefs: Pick<PlaybackPrefs, 'subtitleSize' | 'subtitleColor' | 'subtitleBackground'>,
): Record<string, string> | null {
  const vars: Record<string, string> = {}
  if (prefs.subtitleSize !== 'normal') vars['--cue-size'] = `${SIZE_PERCENT[prefs.subtitleSize]}%`
  if (prefs.subtitleColor !== 'white') vars['--cue-color'] = COLOR_CSS[prefs.subtitleColor]
  const bg = BACKGROUND_CSS[prefs.subtitleBackground]
  if (bg) vars['--cue-bg'] = bg
  return Object.keys(vars).length > 0 ? vars : null
}
