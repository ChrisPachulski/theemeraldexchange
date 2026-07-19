import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiUrl } from '../../lib/api/base'
import { throwApiError } from '../../lib/api/errors'
import './DevicesPanel.css'

// Self-management surface for paired Apple devices (M2 PIN-pair flow).
// Lives inside UserMenu as a <details> disclosure following the
// ApiKeySettings + DiscordNotifications pattern.
//
// Auth: same cookie credential the rest of the dashboard uses. Bearer-
// auth is for native Apple apps; the web UI is always cookie-scoped.
//
// Admin variants under /api/admin/devices are exposed by the backend
// for tooling/cli use; a dedicated admin grid can hang off this panel
// later if it earns its place.

type DeviceView = {
  jti: string
  device_id: string
  device_name: string
  platform: string
  server_id: string
  issued_at: string
  expires_at: string
  last_seen_at: string | null
  last_seen_version: string | null
  revoked: boolean
}

async function fetchDevices(): Promise<DeviceView[]> {
  const r = await fetch(apiUrl('/api/devices/self'), { credentials: 'include' })
  if (r.status === 401 || r.status === 403) await throwApiError(r, 'Devices')
  if (!r.ok) return []
  const body = (await r.json()) as { devices: DeviceView[] }
  return body.devices
}

async function revokeDevice(jti: string): Promise<void> {
  const r = await fetch(apiUrl(`/api/devices/self/${encodeURIComponent(jti)}`), {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!r.ok) await throwApiError(r, 'Revoke device')
}

async function logoutEverywhere(): Promise<number> {
  const r = await fetch(apiUrl('/api/devices/self'), {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!r.ok) await throwApiError(r, 'Sign out everywhere')
  const body = (await r.json()) as { revoked_count: number }
  return body.revoked_count
}

async function renameDevice(jti: string, deviceName: string): Promise<void> {
  const r = await fetch(apiUrl(`/api/devices/self/${encodeURIComponent(jti)}/name`), {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_name: deviceName }),
  })
  if (!r.ok) await throwApiError(r, 'Rename device')
}

function fmtRelative(iso: string | null): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  const diff = Date.now() - then
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function platformLabel(p: string): string {
  switch (p) {
    case 'tvos':
      return 'Apple TV'
    case 'ios':
      return 'iPhone'
    case 'ipados':
      return 'iPad'
    case 'macos':
      return 'Mac'
    default:
      return p || 'Device'
  }
}

export function DevicesPanel() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const q = useQuery({
    queryKey: ['devices', 'self'],
    queryFn: fetchDevices,
    staleTime: 10_000,
  })

  const revoke = useMutation({
    mutationFn: revokeDevice,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices', 'self'] }),
    onError: () => setError('Could not revoke that device. Try again.'),
  })

  const logout = useMutation({
    mutationFn: logoutEverywhere,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices', 'self'] }),
    onError: () => setError('Could not sign out everywhere. Try again.'),
  })

  const rename = useMutation({
    mutationFn: ({ jti, name }: { jti: string; name: string }) => renameDevice(jti, name),
    onSuccess: () => {
      setEditing(null)
      setDraftName('')
      qc.invalidateQueries({ queryKey: ['devices', 'self'] })
    },
    onError: () => setError('Could not rename that device. Names must be 1-128 chars.'),
  })

  const devices = q.data ?? []
  const summary =
    devices.length === 0
      ? 'No paired devices'
      : `${devices.length} paired device${devices.length === 1 ? '' : 's'}`

  return (
    <details className="devices-panel user-menu__disclosure">
      <summary className="user-menu__disclosure-summary">
        <span className="user-menu__eyebrow">Paired devices</span>
        <span className="user-menu__disclosure-status">{summary}</span>
      </summary>
      <p className="devices-panel__hint">
        Apple TV, iPhone, and iPad apps you've paired via the PIN flow. Revoke a
        device to force it back to the pairing screen on its next request.
      </p>

      {q.isLoading && <p className="devices-panel__loading">Loading…</p>}

      {!q.isLoading && devices.length === 0 && (
        <p className="devices-panel__empty">
          Nothing paired yet. Open the EmeraldTV / EmeraldiOS app and visit{' '}
          <code>plex.tv/link</code> with the code it displays to add this server.
        </p>
      )}

      {devices.length > 0 && (
        <>
          <ul className="devices-panel__list">
            {devices.map((d) => (
              <li key={d.jti} className="devices-panel__item">
                <div className="devices-panel__item-main">
                  <div className="devices-panel__item-header">
                    <span className="devices-panel__platform">{platformLabel(d.platform)}</span>
                    {editing === d.jti ? (
                      <input
                        className="devices-panel__rename-input"
                        type="text"
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        autoFocus
                        maxLength={128}
                      />
                    ) : (
                      <span className="devices-panel__name">{d.device_name}</span>
                    )}
                  </div>
                  <div className="devices-panel__item-meta">
                    Last seen {fmtRelative(d.last_seen_at)}
                    {d.last_seen_version ? ` · v${d.last_seen_version}` : ''}
                  </div>
                </div>
                <div className="devices-panel__actions">
                  {editing === d.jti ? (
                    <>
                      <button
                        type="button"
                        className="devices-panel__btn"
                        onClick={() => rename.mutate({ jti: d.jti, name: draftName.trim() })}
                        disabled={draftName.trim().length === 0 || rename.isPending}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="devices-panel__btn devices-panel__btn--ghost"
                        onClick={() => {
                          setEditing(null)
                          setDraftName('')
                          setError(null)
                        }}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="devices-panel__btn devices-panel__btn--ghost"
                        onClick={() => {
                          setEditing(d.jti)
                          setDraftName(d.device_name)
                          setError(null)
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="devices-panel__btn devices-panel__btn--danger"
                        onClick={() => revoke.mutate(d.jti)}
                        disabled={revoke.isPending}
                      >
                        Revoke
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <div className="devices-panel__footer">
            <button
              type="button"
              className="devices-panel__btn devices-panel__btn--danger"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
            >
              Sign out everywhere
            </button>
          </div>
        </>
      )}

      {error && (
        <p className="devices-panel__error" role="alert">
          {error}
        </p>
      )}
    </details>
  )
}
