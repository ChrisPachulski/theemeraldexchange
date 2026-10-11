import type { CSSProperties } from 'react'
import {
  PICKER_LANGUAGES,
  SUBTITLE_BACKGROUNDS,
  SUBTITLE_COLORS,
  SUBTITLE_MODES,
  SUBTITLE_SIZES,
  languageName,
  setPlaybackPrefs,
  subtitleCueVars,
  usePlaybackPrefs,
} from '../../lib/playbackPrefs'

// Device-local playback settings (Apple Settings -> Playback): autoplay next
// episode, when subtitles turn on, preferred subtitle/audio language, and
// subtitle appearance with a live preview. The fields render inside the
// player's settings popover; PlaybackSettings wraps them as the account-menu
// disclosure.

const LANGUAGE_OPTIONS = PICKER_LANGUAGES.map((code) => ({ value: code, label: languageName(code) }))

function PrefSelect<K extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: K
  options: ReadonlyArray<{ value: K; label: string }>
  onChange: (next: K) => void
}) {
  return (
    <label className="playback-settings__row">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as K)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function PlaybackSettingsFields() {
  const prefs = usePlaybackPrefs()
  return (
    <div className="playback-settings__fields">
      <label className="playback-settings__row">
        <span>Autoplay next episode</span>
        <input
          type="checkbox"
          checked={prefs.autoplayNext}
          onChange={(e) => setPlaybackPrefs({ autoplayNext: e.target.checked })}
        />
      </label>
      <PrefSelect
        label="Subtitles"
        value={prefs.subtitleMode}
        options={SUBTITLE_MODES}
        onChange={(subtitleMode) => setPlaybackPrefs({ subtitleMode })}
      />
      <PrefSelect
        label="Subtitle language"
        value={prefs.subtitleLanguage}
        options={LANGUAGE_OPTIONS}
        onChange={(subtitleLanguage) => setPlaybackPrefs({ subtitleLanguage })}
      />
      <PrefSelect
        label="Audio language"
        value={prefs.audioLanguage}
        options={[{ value: '', label: 'Original' }, ...LANGUAGE_OPTIONS]}
        onChange={(audioLanguage) => setPlaybackPrefs({ audioLanguage })}
      />
      <PrefSelect
        label="Subtitle size"
        value={prefs.subtitleSize}
        options={SUBTITLE_SIZES}
        onChange={(subtitleSize) => setPlaybackPrefs({ subtitleSize })}
      />
      <PrefSelect
        label="Subtitle color"
        value={prefs.subtitleColor}
        options={SUBTITLE_COLORS}
        onChange={(subtitleColor) => setPlaybackPrefs({ subtitleColor })}
      />
      <PrefSelect
        label="Subtitle background"
        value={prefs.subtitleBackground}
        options={SUBTITLE_BACKGROUNDS}
        onChange={(subtitleBackground) => setPlaybackPrefs({ subtitleBackground })}
      />
      <p className="playback-settings__preview">
        <span style={(subtitleCueVars(prefs) ?? undefined) as CSSProperties | undefined}>
          Subtitles will look like this.
        </span>
      </p>
    </div>
  )
}

export function PlaybackSettings() {
  const { autoplayNext } = usePlaybackPrefs()
  return (
    <details className="playback-settings user-menu__disclosure">
      <summary className="user-menu__disclosure-summary">
        <span className="user-menu__eyebrow">Playback</span>
        <span className="user-menu__disclosure-status">
          {autoplayNext ? 'Autoplay on' : 'Autoplay off'}
        </span>
      </summary>
      <PlaybackSettingsFields />
    </details>
  )
}

export default PlaybackSettings
