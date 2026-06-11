import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth'
import {
  deleteAnthropicKey,
  getAnthropicKeyInfo,
  putAnthropicKey,
  type AnthropicKeyInfo,
} from '../api/settings'

// Per-user Anthropic API key, stored SERVER-SIDE (encrypted at rest,
// scoped by sub — see server/services/userApiKeys.ts). The browser
// never holds the key after save: this hook exposes only a set flag
// plus the masked last-4 fingerprint, and the suggestions backend reads
// the stored key itself when the request carries no key header.
//
// History: the key used to live in plaintext localStorage
// ('eex.apiKey.<sub>', with an older unscoped 'eex.apiKey' before
// that) and rode every /api/suggestions request as a header from the
// browser. Plaintext localStorage is readable by any same-origin
// script and lingers on shared devices, so both slots are now
// MIGRATION SOURCES ONLY: on first authenticated mount, a key found
// there is silently PUT to the server and removed locally. Never write
// new keys to localStorage.

const SCOPED_PREFIX = 'eex.apiKey.'
const LEGACY_KEY = 'eex.apiKey'

export const KEY_INFO_QUERY_KEY = ['settings', 'anthropic-key'] as const

type MigrationStorage = Pick<Storage, 'getItem' | 'removeItem'>

/** Pure: the locally-stored key eligible for migration — the sub-scoped
 *  slot first, then the legacy unscoped slot. Null when neither holds
 *  a value. */
export function readLocalKeyForMigration(
  storage: MigrationStorage,
  sub: string,
): string | null {
  return storage.getItem(SCOPED_PREFIX + sub) ?? storage.getItem(LEGACY_KEY)
}

/** Pure: best-effort removal of BOTH local slots once the key is safely
 *  on the server (or the server already had one). */
export function clearLocalKey(storage: MigrationStorage, sub: string): void {
  try {
    storage.removeItem(SCOPED_PREFIX + sub)
    storage.removeItem(LEGACY_KEY)
  } catch {
    // private mode — non-fatal, the next mount retries
  }
}

export function useUserApiKey(): {
  /** True when a key is stored server-side for this user. */
  hasKey: boolean
  /** Masked, non-secret display fragment (last 4 chars), or null. */
  fingerprint: string | null
  /** True while the initial server read is in flight. */
  loading: boolean
  setKey: (v: string) => Promise<void>
  clearKey: () => Promise<void>
} {
  const { user } = useAuth()
  const sub = user?.sub
  const qc = useQueryClient()

  const info = useQuery({
    queryKey: KEY_INFO_QUERY_KEY,
    queryFn: getAnthropicKeyInfo,
    enabled: !!sub,
    // The set/last4 pair only changes through the mutations below (which
    // update the cache directly), so a short staleTime just avoids
    // refetch chatter across the surfaces that mount this hook.
    staleTime: 60_000,
  })

  const applyInfo = (next: AnthropicKeyInfo) => {
    qc.setQueryData(KEY_INFO_QUERY_KEY, next)
    // The suggestions lineups were fetched under the previous key state;
    // invalidate so the strip refetches with the new one (matches the
    // old localStorage flow's invalidation in ApiKeySettings).
    void qc.invalidateQueries({ queryKey: ['suggestions'] })
  }

  // One-time silent migration: a key found in either legacy localStorage
  // slot is PUT to the server and then removed locally. If the server
  // ALREADY has a key (set on another device after this one last synced),
  // the server copy wins and the local one is simply discarded — both are
  // the same user's key, and overwriting a deliberate replacement with a
  // stale local copy would be worse. On PUT failure the local key is kept
  // and the migration retries on the next mount.
  const migrating = useRef(false)
  useEffect(() => {
    if (migrating.current) return
    if (!sub || typeof localStorage === 'undefined' || !info.isSuccess) return
    const local = readLocalKeyForMigration(localStorage, sub)
    if (!local) return
    if (info.data.set) {
      clearLocalKey(localStorage, sub)
      return
    }
    migrating.current = true
    putAnthropicKey(local.trim())
      .then((next) => {
        clearLocalKey(localStorage, sub)
        applyInfo(next)
      })
      .catch(() => {
        // leave the local copy; retry next mount
      })
      .finally(() => {
        migrating.current = false
      })
    // applyInfo is stable enough for this once-per-state effect; the deps
    // that matter are the sub and the resolved server state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub, info.isSuccess, info.data?.set])

  const setMutation = useMutation({
    mutationFn: (key: string) => putAnthropicKey(key),
    onSuccess: applyInfo,
  })
  const clearMutation = useMutation({
    mutationFn: deleteAnthropicKey,
    onSuccess: applyInfo,
  })

  return {
    hasKey: info.data?.set === true,
    fingerprint: info.data?.set ? (info.data.last4 ?? null) : null,
    loading: !!sub && info.isPending,
    setKey: async (v: string) => {
      await setMutation.mutateAsync(v.trim())
    },
    clearKey: async () => {
      await clearMutation.mutateAsync()
    },
  }
}
