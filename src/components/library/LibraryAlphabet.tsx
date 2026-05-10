import './LibraryAlphabet.css'

// Plex-style A–Z bucket filter. Renders a horizontal pill row (ALL · A · B
// · … · Z · #) above the library result grid. Letters that have no entries
// in the current library set render dimmed and disabled. The "#" bucket
// catches titles that start with anything that isn't a Latin letter
// (numbers, brackets, accented characters that don't normalize cleanly).

export type LibraryLetter = 'all' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J'
  | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'U' | 'V' | 'W' | 'X' | 'Y' | 'Z' | '#'

const ALPHABET = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z','#'] as const

// Strip leading English articles before bucketing — Plex behavior, so
// "The Mandalorian" lives under M and "An American Werewolf" under A.
export function libraryBucket(title: string): Exclude<LibraryLetter, 'all'> {
  const stripped = title.replace(/^(the|a|an)\s+/i, '').trim()
  // Normalize accents so "Émile" reads as starting with E, not #.
  const normalized = stripped.normalize('NFD').replace(/[̀-ͯ]/g, '')
  const c = normalized.charAt(0).toUpperCase()
  return /[A-Z]/.test(c) ? (c as Exclude<LibraryLetter, 'all'>) : '#'
}

type Props = {
  /** Set of buckets that have at least one entry in the current library. */
  available: Set<Exclude<LibraryLetter, 'all'>>
  /** Currently selected bucket. */
  value: LibraryLetter
  onChange: (next: LibraryLetter) => void
  /** Total count for the ALL pill. */
  totalCount: number
}

export function LibraryAlphabet({ available, value, onChange, totalCount }: Props) {
  return (
    <nav className="alpha" role="tablist" aria-label="Filter by letter">
      <button
        type="button"
        role="tab"
        aria-selected={value === 'all'}
        className={`alpha__chip alpha__chip--all${value === 'all' ? ' alpha__chip--active' : ''}`}
        onClick={() => onChange('all')}
      >
        <span className="alpha__chip-label">All</span>
        <span className="alpha__chip-count" aria-hidden="true">{totalCount}</span>
      </button>

      {ALPHABET.map((letter) => {
        const enabled = available.has(letter)
        const active = value === letter
        return (
          <button
            key={letter}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={!enabled}
            className={`alpha__chip${active ? ' alpha__chip--active' : ''}${enabled ? '' : ' alpha__chip--empty'}`}
            onClick={() => onChange(active ? 'all' : letter)}
          >
            {letter}
          </button>
        )
      })}
    </nav>
  )
}
