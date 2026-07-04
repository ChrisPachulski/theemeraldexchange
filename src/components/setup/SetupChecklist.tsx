import { useState } from 'react'
import { useAuth } from '../../lib/auth'
import { useLimits } from '../../lib/hooks/useLimits'
import './SetupChecklist.css'

// First-run setup checklist (plan 006 Phase 3 — the "wizard"). Shown to the
// admin right after they CLAIM a fresh server (auth.tsx sets the flag) and
// dismissible forever. Every step is optional and skippable: the server
// already runs on-demand-only with everything off. Configuration itself is
// env/compose-driven (the docker-native pattern) — this screen's job is to
// show what's on, what's off, and the one flag that turns each thing on,
// so the operator never spelunks a 300-line .env.example.
// ponytail: read-only checklist, not an in-app config editor — add live
// config mutation only if env-file round-trips prove too painful.

const FLAG_KEY = 'eex.showSetupChecklist'

export function shouldShowSetupChecklist(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) === '1'
  } catch {
    return false
  }
}

export function requestSetupChecklist(): void {
  try {
    localStorage.setItem(FLAG_KEY, '1')
  } catch {
    /* private mode — checklist just won't auto-show */
  }
}

function dismissSetupChecklist(): void {
  try {
    localStorage.removeItem(FLAG_KEY)
  } catch {
    /* ignore */
  }
}

export function SetupChecklist() {
  const { isAdmin } = useAuth()
  const limits = useLimits()
  const [dismissed, setDismissed] = useState(false)
  if (!isAdmin || dismissed || !shouldShowSetupChecklist()) return null
  const l = limits.data
  const rows: Array<{ label: string; on: boolean; how: string }> = [
    {
      label: 'Media library',
      on: l?.mediaEnabled !== false,
      how: 'USE_MEDIA_CORE=1 + point the media-core volumes at your library folders',
    },
    {
      label: 'Requests & downloads (Sonarr / Radarr / SAB)',
      on: l?.sonarrEnabled !== false || l?.radarrEnabled !== false || l?.sabEnabled !== false,
      how: 'set SONARR_API_KEY / RADARR_API_KEY / SAB_API_KEY (+ URLs) in .env',
    },
    {
      label: 'Live TV (IPTV)',
      on: l?.iptvEnabled !== false,
      how: 'set XTREAM_HOST / XTREAM_USERNAME / XTREAM_PASSWORD in .env',
    },
    {
      label: 'Remote access',
      on: false, // not knowable from the SPA; document the flag
      how: 'COMPOSE_PROFILES=remote (Tailscale Serve by default — private, no port-forward)',
    },
    {
      label: 'Error telemetry',
      on: false,
      how: 'COMPOSE_PROFILES=telemetry + TELEMETRY_ENABLED=1 (self-hosted Glitchtip)',
    },
  ]
  return (
    <section className="setup-checklist" aria-label="Server setup checklist">
      <div className="setup-checklist__head">
        <h2 className="setup-checklist__title">Your server is claimed 🎉</h2>
        <button
          type="button"
          className="setup-checklist__dismiss"
          onClick={() => {
            dismissSetupChecklist()
            setDismissed(true)
          }}
        >
          Done — dismiss
        </button>
      </div>
      <p className="setup-checklist__hint">
        Everything below is optional — the server already works for on-demand
        browsing. Turn a capability on by setting its flag and restarting
        (<code>docker compose up -d</code>).
      </p>
      <ul className="setup-checklist__list">
        {rows.map((r) => (
          <li key={r.label} className="setup-checklist__row">
            <span
              className={`setup-checklist__state setup-checklist__state--${r.on ? 'on' : 'off'}`}
            >
              {r.on ? 'on' : 'off'}
            </span>
            <span className="setup-checklist__label">{r.label}</span>
            <code className="setup-checklist__how">{r.how}</code>
          </li>
        ))}
      </ul>
    </section>
  )
}
