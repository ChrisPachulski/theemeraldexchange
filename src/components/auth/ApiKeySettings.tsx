import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useUserApiKey } from '../../lib/hooks/useUserApiKey'
import { apiUrl } from '../../lib/api/base'
import './ApiKeySettings.css'

// Per-user "Your AI key" card in the user menu. The key is stored in
// localStorage on this device only (scoped by Plex user id) — it
// never leaves the browser except as a request header on each
// /api/suggestions call.
//
// Below the input we show the last-30-day usage summary pulled from
// the server: calls + estimated cost. This is the "you can see what
// you're spending" surface; the admin gets a roster view separately.

type UsageMe = {
  sub: string
  username: string
  calls: number
  errors: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  costCents: number
}

async function fetchUsageMe(): Promise<UsageMe | null> {
  const r = await fetch(apiUrl('/api/usage/me'), { credentials: 'include' })
  if (!r.ok) return null
  return (await r.json()) as UsageMe
}

function fmtCost(cents: number): string {
  if (cents <= 0) return '$0.00'
  if (cents < 1) return `~$${(cents / 100).toFixed(4)}`
  return `~$${(cents / 100).toFixed(2)}`
}

export function ApiKeySettings() {
  const { key, hasKey, setKey, clearKey } = useUserApiKey()
  const [draft, setDraft] = useState('')
  // Show-on-type only — once a key is saved we never expose it again.
  // If the user forgot the key, they retrieve it from
  // console.anthropic.com, not from this UI. Eliminates a class of
  // shoulder-surf / screenshare leak vectors that "Show saved key"
  // buttons reliably produce.
  const [typeReveal, setTypeReveal] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset the draft when the underlying key changes (e.g. set on
  // another tab, cleared by the user).
  useEffect(() => {
    setDraft('')
    setTypeReveal(false)
  }, [key])

  const usage = useQuery({
    queryKey: ['usage', 'me'],
    queryFn: fetchUsageMe,
    enabled: hasKey,
    refetchInterval: hasKey ? 15_000 : false,
    staleTime: 5_000,
  })

  const onSave = () => {
    const trimmed = draft.trim()
    if (!trimmed.startsWith('sk-ant-')) {
      setError('Key should start with "sk-ant-".')
      return
    }
    setError(null)
    setKey(trimmed)
    setDraft('')
  }

  const summaryStatus = hasKey
    ? `Set · ${usage.data?.calls ?? 0} calls · ${fmtCost(usage.data?.costCents ?? 0)}`
    : 'Not set'

  return (
    <details className="api-key-settings user-menu__disclosure">
      <summary className="user-menu__disclosure-summary">
        <span className="user-menu__eyebrow">Your AI key</span>
        <span className="user-menu__disclosure-status">{summaryStatus}</span>
      </summary>
      <p className="api-key-settings__hint">
        Personalized picks call the Anthropic API on each refresh. You bring
        your own key so you only pay for what you use. The key stays on this
        device — it never persists on the server.
      </p>

      {hasKey ? (
        <div className="api-key-settings__live">
          <div className="api-key-settings__current">
            {/* Last 4 chars only, no prefix. The key is fully opaque
                from this UI once saved; "lost key" path is the
                Anthropic console, not a reveal button. */}
            <span className="api-key-settings__masked" aria-label="Key saved on this device">
              <span aria-hidden="true">••••••••••••</span>
              <span className="api-key-settings__masked-tail">{key?.slice(-4)}</span>
              <span className="api-key-settings__masked-tag">saved on this device</span>
            </span>
            <button
              type="button"
              className="api-key-settings__small-btn api-key-settings__small-btn--danger"
              onClick={clearKey}
            >
              Clear
            </button>
          </div>

          <dl className="api-key-settings__usage">
            <div>
              <dt>Calls (30d)</dt>
              <dd>{usage.data?.calls ?? 0}</dd>
            </div>
            <div>
              <dt>Errors</dt>
              <dd>{usage.data?.errors ?? 0}</dd>
            </div>
            <div>
              <dt>Cost (30d)</dt>
              <dd>{fmtCost(usage.data?.costCents ?? 0)}</dd>
            </div>
          </dl>
        </div>
      ) : (
        <div className="api-key-settings__form">
          <label className="api-key-settings__label" htmlFor="api-key-input">
            Paste your <code>sk-ant-…</code> key
          </label>
          <div className="api-key-settings__row">
            <input
              id="api-key-input"
              type={typeReveal ? 'text' : 'password'}
              className="api-key-settings__input"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                if (error) setError(null)
              }}
              placeholder="sk-ant-…"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              // Hint to password managers + Safari that this is a
              // credential field even though we're using type=text
              // when revealed.
              data-1p-ignore="false"
            />
            {/* Reveal is only for the typing flow — verify your paste
                before you hit Save. Disappears the moment the key is
                saved (see hasKey branch above). */}
            <button
              type="button"
              className="api-key-settings__small-btn"
              onClick={() => setTypeReveal((v) => !v)}
              aria-pressed={typeReveal}
            >
              {typeReveal ? 'Hide' : 'Show'}
            </button>
            <button
              type="button"
              className="api-key-settings__save"
              onClick={onSave}
              disabled={draft.trim().length === 0}
            >
              Save
            </button>
          </div>
          {error && <p className="api-key-settings__error">{error}</p>}
          <p className="api-key-settings__cta">
            Need one?{' '}
            <a
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noreferrer"
            >
              Create a key →
            </a>
          </p>
        </div>
      )}
    </details>
  )
}
