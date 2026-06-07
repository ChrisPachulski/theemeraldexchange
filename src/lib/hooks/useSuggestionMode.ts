import { useEffect, useState } from 'react'

// Per-device preference for the Discover suggestion strip: show the
// personalized "Recommended" feed or the plain "Trending" feed. This is
// the toggle the user flips between the on-NAS recommender's picks and
// TMDB trending.
//
// Distinct from useAiSuggestionsEnabled (which framed the choice as a
// Claude-token on/off switch). With the local recommender, "Recommended"
// is free, so the choice is purely editorial — personalized vs popular —
// and the toggle is shown in BOTH local-recommender and BYO-key modes.
//
// When unset, the default depends on the deployment: local-recommender
// households default to Recommended (free + the better experience);
// BYO-key-only deployments default to Trending so they don't spend
// Anthropic tokens until the user opts in. The caller passes the
// resolved default.
//
// Listens to the storage event so toggling in one tab updates other
// open tabs without a refresh.

export type SuggestionMode = 'recommended' | 'trending'

export const STORAGE_KEY = 'eex.suggestionMode'

// Pure: read the persisted choice, or null when the user has never set
// one (so the caller can fall back to the deployment default). Defaults
// to ambient localStorage but accepts an injected storage for tests.
export function readStored(storage?: Pick<Storage, 'getItem'>): SuggestionMode | null {
  const store = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
  if (typeof store === 'undefined') return null
  const v = store.getItem(STORAGE_KEY)
  return v === 'recommended' || v === 'trending' ? v : null
}

// Pure: does this storage event concern our preference key?
export function isSuggestionModeStorageEvent(e: Pick<StorageEvent, 'key'>): boolean {
  return e.key === STORAGE_KEY
}

export function useSuggestionMode(defaultMode: SuggestionMode): {
  mode: SuggestionMode
  setMode: (m: SuggestionMode) => void
  toggle: () => void
} {
  const [stored, setStored] = useState<SuggestionMode | null>(() => readStored())

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (isSuggestionModeStorageEvent(e)) setStored(readStored())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const mode = stored ?? defaultMode

  const setMode = (m: SuggestionMode) => {
    try {
      localStorage.setItem(STORAGE_KEY, m)
    } catch {
      // private mode / quota — in-memory state still tracks the choice
    }
    setStored(m)
  }

  return {
    mode,
    setMode,
    toggle: () => setMode(mode === 'recommended' ? 'trending' : 'recommended'),
  }
}
