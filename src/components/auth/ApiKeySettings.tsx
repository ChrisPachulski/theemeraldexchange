import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useUserApiKey } from '../../lib/hooks/useUserApiKey'
import { apiUrl } from '../../lib/api/base'
import { throwApiError } from '../../lib/api/errors'
import { fmtCost } from '../../lib/fmtCost'
import './ApiKeySettings.css'

// Per-user "Your AI key" card in the user menu. The key is stored
// SERVER-SIDE, encrypted at rest and scoped to this account; the
// browser only ever sees the masked last-4 fingerprint after save.
// Replace/clear go through /api/settings/anthropic-key.
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
  if (r.status === 401 || r.status === 403) await throwApiError(r, 'Usage')
  if (!r.ok) return null
  return (await r.json()) as UsageMe
}

export function ApiKeySettings() {
  const { hasKey, fingerprint, setKey, clearKey } = useUserApiKey()
  const [draft, setDraft] = useState('')
  // "Replace" flow: show the entry form even while a key is set. The
  // existing key is never displayed; the user pastes a fresh one.
  const [replacing, setReplacing] = useState(false)
  // Show-on-type only — once a key is saved we never expose it again.
  // If the user forgot the key, they retrieve it from
  // console.anthropic.com, not from this UI. Eliminates a class of
  // shoulder-surf / screenshare leak vectors that "Show saved key"
  // buttons reliably produce.
  const [typeReveal, setTypeReveal] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Reset the entry state when the stored key changes (saved here,
  // replaced elsewhere, cleared). Synchronizing local UI state to an
  // external source is the exception the setState-in-effect lint
  // rule's docs explicitly allow.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft('')
    setTypeReveal(false)
    setReplacing(false)
  }, [hasKey, fingerprint])

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
    setBusy(true)
    // The suggestions queries re-key on the stored fingerprint, so the
    // strip refetches with the new key (useUserApiKey invalidates).
    setKey(trimmed)
      .then(() => setDraft(''))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const onClear = () => {
    setBusy(true)
    clearKey()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const summaryStatus = hasKey
    ? `Set · ${usage.data?.calls ?? 0} calls · ${fmtCost(usage.data?.costCents ?? 0)}`
    : 'Not set'

  const showForm = !hasKey || replacing

  return (
    <details className="api-key-settings user-menu__disclosure">
      <summary className="user-menu__disclosure-summary">
        <span className="user-menu__eyebrow">Your AI key</span>
        <span className="user-menu__disclosure-status">{summaryStatus}</span>
      </summary>
      <p className="api-key-settings__hint">
        Personalized picks call the Anthropic API on each refresh. You bring
        your own key so you only pay for what you use. The key is encrypted
        and stored with your account on this server; it is never shown again
        after you save it.
      </p>

      {hasKey && (
        <div className="api-key-settings__live">
          <div className="api-key-settings__current">
            {/* Masked fingerprint only (last 4 chars). The key is fully
                opaque from this UI once saved; the "lost key" path is
                the Anthropic console, not a reveal button. */}
            <span className="api-key-settings__masked" aria-label="Key saved to your account">
              <span aria-hidden="true">••••••••••••</span>
              <span className="api-key-settings__masked-tail">{fingerprint ?? ''}</span>
              <span className="api-key-settings__masked-tag">saved to your account</span>
            </span>
            {!replacing && (
              <button
                type="button"
                className="api-key-settings__small-btn"
                onClick={() => setReplacing(true)}
                disabled={busy}
              >
                Replace
              </button>
            )}
            <button
              type="button"
              className="api-key-settings__small-btn api-key-settings__small-btn--danger"
              onClick={onClear}
              disabled={busy}
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
      )}

      {showForm && (
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
                saved (see the masked block above). */}
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
              disabled={busy || draft.trim().length === 0}
            >
              {hasKey ? 'Replace' : 'Save'}
            </button>
          </div>
          {error && <p className="api-key-settings__error">{error}</p>}
          {!hasKey && (
            <p className="api-key-settings__cta">
              Need one?{' '}
              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noreferrer"
              >
                Create a key -&gt;
              </a>
            </p>
          )}
        </div>
      )}
    </details>
  )
}
