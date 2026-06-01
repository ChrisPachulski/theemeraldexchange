import { useEffect, useState } from 'react'
import { useAuth } from '../auth'

// Per-user Anthropic API key. Stored in localStorage under a
// sub-scoped key so a shared device (e.g. AppleTV in the living room
// that's been signed in as different family members across the week)
// reads the right key per member.
//
// Key shape: 'eex.apiKey.<sub>'. Plus a legacy unscoped fallback
// ('eex.apiKey') for migrations from the prior global model — read on
// first mount, copied into the sub-scoped slot, then cleared.

const SCOPED_PREFIX = 'eex.apiKey.'
const LEGACY_KEY = 'eex.apiKey'

// The localStorage key for a given sub. The cross-tab listener compares
// incoming StorageEvent.key against this exact string.
export function scopedKeyName(sub: string): string {
  return SCOPED_PREFIX + sub
}

function readScoped(sub: string | undefined): string | null {
  if (!sub) return null
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(SCOPED_PREFIX + sub)
}

// Pure form of the one-time legacy migration the mount effect runs.
// Reads the sub-scoped value; if absent, falls back to the legacy
// unscoped key and (best-effort) copies it into the scoped slot, then
// clears the legacy key — matching the original effect exactly: the
// `current = legacy` assignment lives INSIDE the try, so a setItem
// failure (private mode / quota) is swallowed and leaves `current`
// null rather than adopting the un-persisted legacy value. Returns the
// resolved key, or null when neither slot holds a value.
export function migrateLegacyKey(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  sub: string,
): string | null {
  let current = storage.getItem(SCOPED_PREFIX + sub)
  if (!current) {
    const legacy = storage.getItem(LEGACY_KEY)
    if (legacy) {
      try {
        storage.setItem(SCOPED_PREFIX + sub, legacy)
        storage.removeItem(LEGACY_KEY)
        current = legacy
      } catch {
        // private mode / quota — non-fatal
      }
    }
  }
  return current
}

// Non-secret fingerprint of an API key, suitable for use inside a
// TanStack Query key. The full key MUST never appear in a query key
// (the cache is in-memory but query keys are easy to log/dump). djb2
// over the full key, base36-encoded — deterministic per key value,
// one-way at this width (32-bit truncation hides the source), and
// collision-resistant across the small set of keys a single household
// uses. Previous last-4-characters approach was non-deterministic:
// two different keys sharing a trailing slice would collide and let
// the new key read the old key's cached suggestions.
export function keyFingerprint(key: string | null): string {
  if (!key) return 'none'
  let h = 5381
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h) ^ key.charCodeAt(i)
  }
  return (h >>> 0).toString(36)
}

export function useUserApiKey(): {
  key: string | null
  hasKey: boolean
  setKey: (v: string) => void
  clearKey: () => void
} {
  const { user } = useAuth()
  const sub = user?.sub
  const [key, setKeyState] = useState<string | null>(() => readScoped(sub))

  // Re-read whenever sub changes (login / sign-out / user switch).
  // Also handle the one-time legacy migration so a user who set the
  // key before this PR doesn't lose it. Syncing local state to
  // localStorage (an external source) is the intended exception to
  // the setState-in-effect rule.
  useEffect(() => {
    if (!sub || typeof localStorage === 'undefined') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setKeyState(null)
      return
    }
    setKeyState(migrateLegacyKey(localStorage, sub))
  }, [sub])

  // Sync across tabs.
  useEffect(() => {
    if (!sub) return
    const onStorage = (e: StorageEvent) => {
      if (e.key === scopedKeyName(sub)) setKeyState(e.newValue)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [sub])

  const setKey = (v: string) => {
    const trimmed = v.trim()
    if (!sub) return
    try {
      localStorage.setItem(SCOPED_PREFIX + sub, trimmed)
    } catch {
      // ignore quota errors — in-memory state still tracks it
    }
    setKeyState(trimmed)
  }

  const clearKey = () => {
    if (!sub) {
      setKeyState(null)
      return
    }
    try {
      localStorage.removeItem(SCOPED_PREFIX + sub)
    } catch {
      // ignore
    }
    setKeyState(null)
  }

  return {
    key,
    hasKey: !!key && key.startsWith('sk-ant-'),
    setKey,
    clearKey,
  }
}
