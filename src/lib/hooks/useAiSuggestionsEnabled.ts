import { useEffect, useState } from 'react'

// Household-level switch for the Claude-backed recommendation system.
// Default OFF — the Claude API call costs real money per refresh, and
// most browsing doesn't need personalized picks. When OFF the Discover
// strip falls back to TMDB trending (free, instant). Preference is
// per-device via localStorage so it persists across reloads.
//
// Listens to the storage event so toggling on one tab updates open
// tabs without a refresh.

const STORAGE_KEY = 'eex.aiSuggestionsEnabled'

function read(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(STORAGE_KEY) === '1'
}

export function useAiSuggestionsEnabled(): {
  enabled: boolean
  setEnabled: (v: boolean) => void
  toggle: () => void
} {
  const [enabled, setEnabledState] = useState<boolean>(read)

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setEnabledState(read())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setEnabled = (v: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY, v ? '1' : '0')
    } catch {
      // private mode / quota — fall through, in-memory state still tracks
    }
    setEnabledState(v)
  }

  return {
    enabled,
    setEnabled,
    toggle: () => setEnabled(!enabled),
  }
}
