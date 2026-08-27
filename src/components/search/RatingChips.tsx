import type { RatingPiece } from '../../lib/api/ratings'
import './RatingChips.css'

// Score chips: source icon + number, no text labels. Icons are simplified
// inline marks (not the trademarked logos) that read at 12px: IMDb's yellow
// plate, RT's tomato (green splat when rotten), the popcorn bucket (tipped
// when the audience score is under 60), and Metacritic's colour-coded tile.

function ImdbMark() {
  return (
    <svg viewBox="0 0 32 16" width="24" height="12" aria-hidden="true">
      <rect width="32" height="16" rx="3" fill="#f5c518" />
      <text x="16" y="12" textAnchor="middle" fontFamily="Arial, Helvetica, sans-serif" fontWeight="700" fontSize="11" fill="#000">IMDb</text>
    </svg>
  )
}

function TomatoMark({ fresh }: { fresh: boolean }) {
  return fresh ? (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <circle cx="8" cy="9.5" r="6.2" fill="#fa320a" />
      <path d="M8 3.6c-1.4-1.6-3.4-1.4-4.6-.7 1.5.2 2.4 1 3 1.9C7.1 4.3 8.6 3.5 10.6 3c-1.5-.3-2.1.2-2.6.6z" fill="#00912d" />
      <path d="M8 3.2c.2-1 .8-1.7 1.6-2.1-.2.9-.1 1.6.1 2.2C9 3.2 8.5 3.1 8 3.2z" fill="#00912d" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="M8 1.5l1.8 3.2 3.5-1.2-.9 3.6 3.1 2-3.2 1.7.4 3.7-3.3-1.6L6.1 15l-.2-3.7L2.6 9.9l2.9-2.2-1.3-3.5 3.6.9z" fill="#0ac855" />
    </svg>
  )
}

function PopcornMark({ fresh }: { fresh: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" style={fresh ? undefined : { transform: 'rotate(-28deg)' }}>
      <path d="M3 6h10l-1.2 8.5H4.2z" fill="#fa320a" />
      <path d="M5.4 6h1.6l-.3 8.5H5.2zM9 6h1.6l-.5 8.5H8.7z" fill="#fff" opacity=".85" />
      <circle cx="5" cy="4.6" r="2" fill="#ffd24d" />
      <circle cx="8.2" cy="3.4" r="2.2" fill="#ffe27a" />
      <circle cx="11.2" cy="4.6" r="2" fill="#ffd24d" />
    </svg>
  )
}

function MetacriticMark({ score }: { score: number }) {
  const fill = score >= 61 ? '#66cc33' : score >= 40 ? '#ffcc33' : '#ff0000'
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <rect width="16" height="16" rx="3" fill={fill} />
      <text x="8" y="12" textAnchor="middle" fontFamily="Arial, Helvetica, sans-serif" fontWeight="700" fontSize="10" fill="#000">M</text>
    </svg>
  )
}

function Mark({ piece }: { piece: RatingPiece }) {
  switch (piece.kind) {
    case 'imdb':
      return <ImdbMark />
    case 'rt':
      return <TomatoMark fresh={piece.score >= 60} />
    case 'popcorn':
      return <PopcornMark fresh={piece.score >= 60} />
    case 'mc':
      return <MetacriticMark score={piece.score} />
    default:
      return <span className="rating-chip__src">{piece.kind.toUpperCase()}</span>
  }
}

export function RatingChips({ pieces, size = 'md' }: { pieces: RatingPiece[]; size?: 'md' | 'lg' }) {
  if (pieces.length === 0) return null
  return (
    <p className={`rating-chips rating-chips--${size}`} aria-label="ratings">
      {pieces.map((p) => (
        <span key={p.kind} className="rating-chip" title={p.label} aria-label={p.label}>
          <Mark piece={p} />
          <span className="rating-chip__value">{p.value}</span>
        </span>
      ))}
    </p>
  )
}
