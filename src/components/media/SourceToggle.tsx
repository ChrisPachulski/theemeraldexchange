import './SourceToggle.css'

// The SOURCE distinction the Media Library tab asks for:
//   'local'       — truly on-disk via media-core (playable now)
//   'requestable' — the existing Radarr/Sonarr discover/search path
// Cloned from ModeToggle's visual + ARIA pattern; kept separate so the
// in-library "Discover / In library" toggle stays single-purpose.
export type SourceMode = 'local' | 'requestable'

type Props = {
  mode: SourceMode
  onChange: (next: SourceMode) => void
  localCount?: number
}

export function SourceToggle({ mode, onChange, localCount }: Props) {
  return (
    <div className="source-toggle" role="tablist" aria-label="Media source">
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'local'}
        className={`source-toggle__option${mode === 'local' ? ' source-toggle__option--active' : ''}`}
        onClick={() => onChange('local')}
      >
        Available locally
        {localCount !== undefined && (
          <span className="source-toggle__count">{localCount}</span>
        )}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'requestable'}
        className={`source-toggle__option${mode === 'requestable' ? ' source-toggle__option--active' : ''}`}
        onClick={() => onChange('requestable')}
      >
        Requestable
      </button>
    </div>
  )
}
