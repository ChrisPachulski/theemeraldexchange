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
// (the cache is in-memory but query keys are easy to log/dump).
// Last-4 mirrors the masked-tail pattern in ApiKeySettings — low
// entropy but enough to disambiguate different keys in practice, and
// it changes whenever the user rotates their key (the only thing this
// fingerprint exists to detect).
export function keyFingerprint(key: string | null): string {
  return key ? key.slice(-4) : 'none'
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
