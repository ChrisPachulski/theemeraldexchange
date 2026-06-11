import './AiToggle.css'

// Household-level on/off for the Claude-backed suggestions. Default
// OFF so the household doesn't burn API tokens just browsing. When
// OFF, the strip falls back to free TMDB trending (same shape, no
// Claude call).

type Props = {
  enabled: boolean
  onToggle: () => void
}

export function AiToggle({ enabled, onToggle }: Props) {
  return (
    <button
      type="button"
      className={`ai-toggle${enabled ? ' ai-toggle--on' : ''}`}
      role="switch"
      aria-checked={enabled}
      aria-label={
        enabled
          ? 'AI personalization on; tap to switch to free TMDB trending'
          : 'AI personalization off; tap to enable personalized picks (uses API tokens)'
      }
      title={
        enabled
          ? 'Personalized picks (Claude). Tap to switch to free TMDB trending.'
          : 'TMDB trending. Tap to enable personalized picks (uses API tokens).'
      }
      onClick={onToggle}
    >
      <span className="ai-toggle__label">AI picks</span>
      <span className="ai-toggle__track" aria-hidden="true">
        <span className="ai-toggle__thumb" />
      </span>
      <span className="ai-toggle__state">{enabled ? 'ON' : 'OFF'}</span>
    </button>
  )
}
