import type { SuggestionMode } from '../../lib/hooks/useSuggestionMode'
// Reuse the emerald segmented-pod styling that ModeToggle/KindToggle use,
// so the suggestion-source switch matches the rest of the app's toggles.
import './ModeToggle.css'

// Recommended ⇄ Trending switch for the Discover suggestion strip.
// "Recommended" = the household's personalized picks (on-NAS recommender,
// or Claude when a BYO key is set). "Trending" = TMDB trending this week.
// Shown whenever personalization is achievable so the user can always
// flip between their picks and what's popular.

type Props = {
  value: SuggestionMode
  onChange: (next: SuggestionMode) => void
}

export function StripModeToggle({ value, onChange }: Props) {
  return (
    <div className="mode-toggle" role="tablist" aria-label="Suggestion source">
      <button
        type="button"
        role="tab"
        aria-selected={value === 'recommended'}
        className={`mode-toggle__option${value === 'recommended' ? ' mode-toggle__option--active' : ''}`}
        onClick={() => onChange('recommended')}
      >
        Recommended
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={value === 'trending'}
        className={`mode-toggle__option${value === 'trending' ? ' mode-toggle__option--active' : ''}`}
        onClick={() => onChange('trending')}
      >
        Trending
      </button>
    </div>
  )
}
