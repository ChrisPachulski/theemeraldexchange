import { useEffect, useState } from 'react'
import { apiUrl } from '../../lib/api/base'

// Discord-webhook configuration card inside the admin UserMenu.
// Fetches current state once on mount, lets the admin paste a webhook
// URL, fires a test ping, or remove the integration. Wraps the small
// /api/notifications/discord set of routes.

type Status = { sonarr: boolean; radarr: boolean; configured: boolean }

type Props = { onClose: () => void }

export function DiscordNotifications({ onClose }: Props) {
  const [status, setStatus] = useState<Status | null>(null)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch(apiUrl('/api/notifications/discord'), { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Status | null) => {
        if (alive) setStatus(s)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const save = async () => {
    setBusy('save')
    setMessage(null)
    try {
      const res = await fetch(apiUrl('/api/notifications/discord'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ webhookUrl: url.trim() }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `save failed ${res.status}`)
      }
      setStatus({ sonarr: true, radarr: true, configured: true })
      setUrl('')
      setMessage('Saved. Sonarr + Radarr will ping Discord on grab, download, and manual-interaction events.')
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const test = async () => {
    setBusy('test')
    setMessage(null)
    try {
      const res = await fetch(apiUrl('/api/notifications/discord/test'), {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `test failed ${res.status}`)
      }
      setMessage('Test ping sent; check your Discord channel.')
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // Returns true on success, false on any error. The caller uses this
  // to decide whether to close the menu — without it, the click
  // handler's `.then(() => onClose())` ran whether the DELETE succeeded
  // or not, hiding the partial-failure message the backend now
  // surfaces (a connector might still be live). Keep the menu open on
  // failure so the user sees what happened.
  const remove = async (): Promise<boolean> => {
    setBusy('remove')
    setMessage(null)
    try {
      const res = await fetch(apiUrl('/api/notifications/discord'), {
        method: 'DELETE',
        credentials: 'include',
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string
          failures?: Array<{ app: string; status: number }>
          message?: string
        }
        const failedApps = body.failures?.map((f) => f.app).join(' + ')
        throw new Error(
          body.message ??
            (failedApps
              ? `remove failed for ${failedApps} (${res.status})`
              : (body.error ?? `remove failed ${res.status}`)),
        )
      }
      setStatus({ sonarr: false, radarr: false, configured: false })
      setMessage('Removed. Sonarr + Radarr will stop pinging Discord.')
      return true
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(null)
    }
  }

  const configured = status?.configured ?? false

  const summaryStatus =
    status === null ? 'Checking…' : configured ? 'Configured' : 'Not set'

  return (
    <details
      className="user-menu__apps user-menu__discord user-menu__disclosure"
      aria-label="Discord notifications"
    >
      <summary className="user-menu__disclosure-summary">
        <span className="user-menu__eyebrow">Discord notifications</span>
        <span className="user-menu__disclosure-status">{summaryStatus}</span>
      </summary>
      <p className="user-menu__discord-status">
        {status === null
          ? 'Checking…'
          : configured
            ? 'Configured · firing on grab / download / failure'
            : 'Not configured'}
      </p>
      {!configured && (
        <>
          <input
            type="url"
            className="user-menu__discord-input"
            placeholder="https://discord.com/api/webhooks/..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={busy !== null}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            className="user-menu__discord-action"
            onClick={save}
            disabled={busy !== null || url.trim().length === 0}
          >
            {busy === 'save' ? 'Saving…' : 'Save webhook'}
          </button>
        </>
      )}
      {configured && (
        <div className="user-menu__discord-actions">
          <button
            type="button"
            className="user-menu__discord-action"
            onClick={test}
            disabled={busy !== null}
          >
            {busy === 'test' ? 'Sending…' : 'Send test ping'}
          </button>
          <button
            type="button"
            className="user-menu__discord-action user-menu__discord-action--danger"
            onClick={() => {
              if (window.confirm('Remove Discord notifications from Sonarr + Radarr?')) {
                void remove().then((ok) => {
                  // Only close on success. On failure the menu stays
                  // open so the user can read the error and retry —
                  // closing would hide the message the backend went
                  // through the trouble of returning (partial-delete
                  // failures, in particular, mean a connector may
                  // still be active).
                  if (ok) onClose()
                })
              }
            }}
            disabled={busy !== null}
          >
            {busy === 'remove' ? 'Removing…' : 'Remove'}
          </button>
        </div>
      )}
      {message && (
        <p className="user-menu__discord-message" role="status">
          {message}
        </p>
      )}
    </details>
  )
}
