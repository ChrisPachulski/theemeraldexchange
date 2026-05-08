import './ModeToggle.css'

export type Mode = 'discover' | 'library'

type Props = {
  mode: Mode
  onChange: (next: Mode) => void
  libraryCount?: number
}

export function ModeToggle({ mode, onChange, libraryCount }: Props) {
  return (
    <div className="mode-toggle" role="tablist" aria-label="View mode">
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'discover'}
        className={`mode-toggle__option${mode === 'discover' ? ' mode-toggle__option--active' : ''}`}
        onClick={() => onChange('discover')}
      >
        Discover
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'library'}
        className={`mode-toggle__option${mode === 'library' ? ' mode-toggle__option--active' : ''}`}
        onClick={() => onChange('library')}
      >
        In library
        {libraryCount !== undefined && (
          <span className="mode-toggle__count">{libraryCount}</span>
        )}
      </button>
    </div>
  )
}
