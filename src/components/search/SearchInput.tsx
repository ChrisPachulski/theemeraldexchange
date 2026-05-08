import { useEffect, useRef } from 'react'
import './SearchInput.css'

type Props = {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  prompt?: string
  autoFocus?: boolean
}

export function SearchInput({ value, onChange, placeholder, prompt, autoFocus }: Props) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  return (
    <div className="search-hero">
      {prompt && (
        <p className="search-hero__prompt">
          <span className="search-hero__prompt-glyph" aria-hidden="true">{'->'}</span>
          {prompt}
        </p>
      )}
      <div className="search-hero__panel">
        <input
          ref={ref}
          type="search"
          className="search-hero__field"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? 'Search'}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
        />
      </div>
    </div>
  )
}
