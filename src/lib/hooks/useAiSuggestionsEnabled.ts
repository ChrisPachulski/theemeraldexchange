import { useEffect, useState } from 'react'

// Household-level switch for the Claude-backed recommendation system.
// Default OFF — the Claude API call costs real money per refresh, and
// most browsing doesn't need personalized picks. When OFF the Discover
// strip falls back to TMDB trending (free, instant). Preference is
// per-device via localStorage so it persists across reloads.
//
// Listens to the storage event so toggling on one tab updates open
// tabs without a refresh.

export const STORAGE_KEY = 'eex.aiSuggestionsEnabled'

// Pure: reads the persisted preference. Default OFF is a money-saving
// invariant — only the exact string '1' counts as enabled. Defaults to
// the ambient localStorage, but accepts an injected storage for tests.
export function read(storage?: Pick<Storage, 'getItem'>): boolean {
  const store = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
  if (typeof store === 'undefined') return false
  return store.getItem(STORAGE_KEY) === '1'
}

// Pure: serializes the enabled flag to the persisted string form.
export function serializeEnabled(v: boolean): string {
  return v ? '1' : '0'
}

// Pure: does this storage event concern our preference key? Used to
// filter cross-tab storage events down to the ones we care about.
export function isAiSuggestionsStorageEvent(e: Pick<StorageEvent, 'key'>): boolean {
  return e.key === STORAGE_KEY
}

export function useAiSuggestionsEnabled(): {
  enabled: boolean
  setEnabled: (v: boolean) => void
  toggle: () => void
} {
  const [enabled, setEnabledState] = useState<boolean>(() => read())

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (isAiSuggestionsStorageEvent(e)) setEnabledState(read())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setEnabled = (v: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY, serializeEnabled(v))
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
