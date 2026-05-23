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

function readScoped(sub: string | undefined): string | null {
  if (!sub) return null
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(SCOPED_PREFIX + sub)
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
    let current = localStorage.getItem(SCOPED_PREFIX + sub)
    if (!current) {
      const legacy = localStorage.getItem(LEGACY_KEY)
      if (legacy) {
        try {
          localStorage.setItem(SCOPED_PREFIX + sub, legacy)
          localStorage.removeItem(LEGACY_KEY)
          current = legacy
        } catch {
          // private mode / quota — non-fatal
        }
      }
    }
    setKeyState(current)
  }, [sub])

  // Sync across tabs.
  useEffect(() => {
    if (!sub) return
    const onStorage = (e: StorageEvent) => {
      if (e.key === SCOPED_PREFIX + sub) setKeyState(e.newValue)
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
