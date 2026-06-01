import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  keyFingerprint,
  migrateLegacyKey,
  scopedKeyName,
} from './useUserApiKey'

// vitest runs in the `node` environment (vitest.config.ts:
// environment: 'node') — there is no jsdom, no @testing-library, and no
// react-test-renderer, and we must not add any. So instead of rendering
// the hook, we pin the PURE scoping / migration / fingerprint logic the
// hook delegates to (the same pattern usePlexLinks.test.ts uses for its
// extracted URL builders). The hook's React-effect wiring — re-reading
// on sub change, the cross-tab `storage` listener, setKey/clearKey —
// is exercised indirectly via the component tests (MoviesTab/TvTab/
// ApiKeySettings). Where a global is needed we stub it with
// vi.stubGlobal and tear down in afterEach, matching auth.test.ts /
// queryClient conventions. Node 24 supplies EventTarget/CustomEvent
// natively, so no DOM shim is required.

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// In-memory Storage stub: a Map behind the getItem/setItem/removeItem
// slice migrateLegacyKey depends on. Optional `throwOnSet` simulates
// private-mode / quota where writes throw.
function makeStorage(
  initial: Record<string, string> = {},
  opts: { throwOnSet?: boolean } = {},
): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    map,
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      if (opts.throwOnSet) throw new DOMException('QuotaExceededError')
      map.set(k, v)
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
  }
}

describe('keyFingerprint', () => {
  it('returns "none" for falsy keys (null / empty string)', () => {
    expect(keyFingerprint(null)).toBe('none')
    expect(keyFingerprint('')).toBe('none')
  })

  it('is deterministic — same key in, same fingerprint out', () => {
    const k = 'sk-ant-api03-abcdef0123456789'
    expect(keyFingerprint(k)).toBe(keyFingerprint(k))
    expect(keyFingerprint(k)).toBe(keyFingerprint(k))
  })

  it('produces unique fingerprints across a realistic set of distinct keys', () => {
    const keys = [
      'sk-ant-api03-AAAAAAAAAAAAAAAA',
      'sk-ant-api03-BBBBBBBBBBBBBBBB',
      'sk-ant-api03-0000000000000001',
      'sk-ant-api03-0000000000000002',
      'sk-ant-api03-zzzzzzzzzzzzzzzz',
      'sk-ant-api03-household-mom-key',
      'sk-ant-api03-household-dad-key',
      'sk-ant-api03-household-kid-key',
    ]
    const fps = new Set(keys.map((k) => keyFingerprint(k)))
    expect(fps.size).toBe(keys.length)
  })

  it('REGRESSION: keys sharing the same trailing 4 chars but differing earlier collide under the old last-4 scheme — they must NOT collide now', () => {
    // djb2-over-full-key fix vs the old last-4-characters approach,
    // documented in the keyFingerprint comment.
    expect(keyFingerprint('sk-ant-AAAA-xyz9')).not.toBe(
      keyFingerprint('sk-ant-BBBB-xyz9'),
    )
  })

  it('emits a base36 string and never leaks the source key', () => {
    const key = 'sk-ant-api03-SECRETSECRETSECRET'
    const fp = keyFingerprint(key)
    expect(fp).toMatch(/^[0-9a-z]+$/)
    expect(fp).not.toContain(key)
    expect(fp).not.toContain('SECRET')
  })
})

describe('scopedKeyName', () => {
  it('prefixes the sub with "eex.apiKey." for representative subs', () => {
    expect(scopedKeyName('plex:42')).toBe('eex.apiKey.plex:42')
    expect(scopedKeyName('apple:000000.deadbeef.0000')).toBe(
      'eex.apiKey.apple:000000.deadbeef.0000',
    )
    expect(scopedKeyName('local:dev')).toBe('eex.apiKey.local:dev')
  })
})

describe('migrateLegacyKey', () => {
  it('returns the existing scoped value and leaves a present legacy key untouched', () => {
    const storage = makeStorage({
      'eex.apiKey.plex:42': 'sk-ant-scoped',
      'eex.apiKey': 'sk-ant-legacy',
    })
    expect(migrateLegacyKey(storage, 'plex:42')).toBe('sk-ant-scoped')
    // Existing scoped value wins; legacy is NOT migrated over it.
    expect(storage.getItem('eex.apiKey')).toBe('sk-ant-legacy')
    expect(storage.getItem('eex.apiKey.plex:42')).toBe('sk-ant-scoped')
  })

  it('migrates the legacy key into the scoped slot and clears legacy when scoped is absent', () => {
    const storage = makeStorage({ 'eex.apiKey': 'sk-ant-legacy' })
    expect(migrateLegacyKey(storage, 'plex:42')).toBe('sk-ant-legacy')
    expect(storage.getItem(scopedKeyName('plex:42'))).toBe('sk-ant-legacy')
    expect(storage.getItem('eex.apiKey')).toBeNull()
  })

  it('returns null and writes nothing when neither slot exists', () => {
    const storage = makeStorage()
    expect(migrateLegacyKey(storage, 'plex:42')).toBeNull()
    expect(storage.map.size).toBe(0)
  })

  it('is per-sub isolated — legacy migrates only into the requested sub', () => {
    const storage = makeStorage({ 'eex.apiKey': 'sk-ant-legacy' })
    expect(migrateLegacyKey(storage, 'plex:42')).toBe('sk-ant-legacy')
    // The migration consumed the legacy key into plex:42; a different
    // sub now finds nothing.
    expect(storage.getItem(scopedKeyName('plex:42'))).toBe('sk-ant-legacy')
    expect(migrateLegacyKey(storage, 'plex:43')).toBeNull()
    expect(storage.getItem(scopedKeyName('plex:43'))).toBeNull()
  })

  it('does not throw when setItem fails (private mode / quota), matching the original try/catch', () => {
    const storage = makeStorage({ 'eex.apiKey': 'sk-ant-legacy' }, { throwOnSet: true })
    let result: string | null = 'unset'
    expect(() => {
      result = migrateLegacyKey(storage, 'plex:42')
    }).not.toThrow()
    // Original effect assigns `current = legacy` INSIDE the try, after
    // setItem — so a throw leaves current null and the legacy key intact.
    expect(result).toBeNull()
    expect(storage.getItem('eex.apiKey')).toBe('sk-ant-legacy')
  })
})

describe('cross-tab key-name matching', () => {
  // The hook's `storage` listener updates state only when
  // e.key === scopedKeyName(sub). Pin that string identity so a
  // StorageEvent for a different sub's scoped name — or for the legacy
  // unscoped key — does not match.
  it('distinguishes scoped names per sub and from the legacy unscoped key', () => {
    expect(scopedKeyName('plex:42')).not.toBe(scopedKeyName('plex:43'))
    expect(scopedKeyName('plex:42')).not.toBe('eex.apiKey')
    // The matching event's key is exactly the scoped name.
    expect(scopedKeyName('plex:42')).toBe('eex.apiKey.plex:42')
  })
})
