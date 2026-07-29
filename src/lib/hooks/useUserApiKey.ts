import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth'
import {
  deleteAnthropicKey,
  getAnthropicKeyInfo,
  putAnthropicKey,
  type AnthropicKeyInfo,
} from '../api/settings'
import { notifySessionExpired } from '../sessionExpiry'

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

type Principal = { sub: string }

function principalChangedError(): Error {
  const error = new Error('The signed-in account changed before the request started.')
  error.name = 'AbortError'
  return error
}

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
  // Object identity is the auth generation: A -> signed out -> A produces a
  // fresh principal even though the subject string matches again.
  const principal = useMemo<Principal | null>(() => (sub ? { sub } : null), [sub])
  const principalRef = useRef(principal)
  const operationControllers = useRef(new Set<AbortController>())

  useLayoutEffect(() => {
    principalRef.current = principal
  }, [principal])

  useEffect(() => {
    const controllers = operationControllers.current
    return () => {
      for (const controller of controllers) controller.abort()
      controllers.clear()
    }
  }, [principal])

  const queryKey = [...KEY_INFO_QUERY_KEY, sub] as const

  const info = useQuery({
    queryKey,
    queryFn: ({ signal }) => getAnthropicKeyInfo({ signal }),
    enabled: !!sub,
    // The set/last4 pair only changes through the mutations below (which
    // update the cache directly), so a short staleTime just avoids
    // refetch chatter across the surfaces that mount this hook.
    staleTime: 60_000,
  })

  const applyInfo = (captured: Principal, next: AnthropicKeyInfo) => {
    if (principalRef.current !== captured) return
    qc.setQueryData([...KEY_INFO_QUERY_KEY, captured.sub], next)
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
  useEffect(() => {
    const captured = principal
    const controllers = operationControllers.current
    if (!captured || typeof localStorage === 'undefined' || !info.isSuccess) return
    const local = readLocalKeyForMigration(localStorage, captured.sub)
    if (!local) return
    if (info.data.set) {
      if (principalRef.current === captured) {
        clearLocalKey(localStorage, captured.sub)
      }
      return
    }
    const controller = new AbortController()
    controllers.add(controller)
    // This check is intentionally adjacent to the POST. A stale effect must
    // not send one user's old local key under another user's cookie.
    if (principalRef.current !== captured) {
      controller.abort()
      controllers.delete(controller)
      return
    }
    putAnthropicKey(local.trim(), {
      expectedSub: captured.sub,
      signal: controller.signal,
    })
      .then((next) => {
        if (controller.signal.aborted || principalRef.current !== captured) return
        clearLocalKey(localStorage, captured.sub)
        applyInfo(captured, next)
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || principalRef.current !== captured) return
        notifySessionExpired(error)
        // leave the local copy; retry next mount
      })
      .finally(() => {
        controllers.delete(controller)
      })
    return () => {
      controller.abort()
      controllers.delete(controller)
    }
    // applyInfo is stable enough for this once-per-state effect; the deps
    // that matter are the sub and the resolved server state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [principal, info.isSuccess, info.data?.set])

  const runMutation = async (
    captured: Principal | null,
    operation: (sub: string, signal: AbortSignal) => Promise<AnthropicKeyInfo>,
  ): Promise<void> => {
    // A callback retained by the previous account can run after React renders
    // the next one. Refuse it before creating or issuing a request.
    if (!captured || principalRef.current !== captured) {
      throw principalChangedError()
    }
    const controller = new AbortController()
    operationControllers.current.add(controller)
    try {
      if (principalRef.current !== captured) throw principalChangedError()
      const next = await operation(captured.sub, controller.signal)
      if (controller.signal.aborted || principalRef.current !== captured) {
        throw principalChangedError()
      }
      applyInfo(captured, next)
    } finally {
      operationControllers.current.delete(controller)
    }
  }

  return {
    hasKey: info.data?.set === true,
    fingerprint: info.data?.set ? (info.data.last4 ?? null) : null,
    loading: !!sub && info.isPending,
    setKey: async (v: string) => {
      await runMutation(principal, (expectedSub, signal) =>
        putAnthropicKey(v.trim(), { expectedSub, signal }),
      )
    },
    clearKey: async () => {
      await runMutation(principal, (expectedSub, signal) =>
        deleteAnthropicKey({ expectedSub, signal }),
      )
    },
  }
}
