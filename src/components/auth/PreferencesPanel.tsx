import { useState } from 'react'
import { setReduceMotion, storedReduceMotion } from '../../lib/reduceMotion'
import { crashReportsEnabled, setCrashReportsEnabled } from '../../lib/telemetry'

// Device-local switches the Apple app keeps in Settings: Reduce motion
// (Appearance) and Send crash reports (Diagnostics). Both live in this
// browser's localStorage only; the server has no user-prefs endpoint.

function Switch({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      className="user-menu__toggle"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
    >
      <span className="user-menu__toggle-label">{label}</span>
      <span
        className={on ? 'user-menu__toggle-track user-menu__toggle-track--on' : 'user-menu__toggle-track'}
        aria-hidden="true"
      >
        <span className="user-menu__toggle-thumb" />
      </span>
    </button>
  )
}

export function PreferencesPanel() {
  const [reduceMotion, setReduceMotionState] = useState(storedReduceMotion)
  const [crashReports, setCrashReports] = useState(crashReportsEnabled)

  return (
    <details className="user-menu__disclosure">
      <summary className="user-menu__disclosure-summary">
        <span className="user-menu__eyebrow">Preferences</span>
      </summary>
      <Switch
        label="Reduce motion"
        on={reduceMotion}
        onChange={(on) => {
          setReduceMotion(on)
          setReduceMotionState(on)
        }}
      />
      <Switch
        label="Send crash reports to my server"
        on={crashReports}
        onChange={(on) => {
          setCrashReportsEnabled(on)
          setCrashReports(on)
        }}
      />
      <p className="user-menu__hint">
        Crash reports go only to the error service your server names, and never include your
        token, server address, or identity.
      </p>
    </details>
  )
}
