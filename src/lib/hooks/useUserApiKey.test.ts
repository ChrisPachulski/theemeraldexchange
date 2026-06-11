import { describe, expect, it } from 'vitest'
import { clearLocalKey, readLocalKeyForMigration } from './useUserApiKey'

// Node-env tests for the PURE localStorage-migration helpers. The
// hook's React wiring (server fetch, one-time PUT migration, mutations)
// is covered by useUserApiKey.dom.test.tsx in jsdom; these pin the slot
// precedence and cleanup behavior the migration is built on.
//
// History note: the localStorage slots ('eex.apiKey.<sub>' scoped,
// 'eex.apiKey' legacy-unscoped) are MIGRATION SOURCES ONLY since the
// key moved server-side — nothing writes them anymore.

function makeStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    map,
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    removeItem: (k: string) => {
      map.delete(k)
    },
  }
}

describe('readLocalKeyForMigration', () => {
  it('prefers the sub-scoped slot over the legacy unscoped slot', () => {
    const s = makeStorage({
      'eex.apiKey.plex:1': 'sk-ant-scoped',
      'eex.apiKey': 'sk-ant-legacy',
    })
    expect(readLocalKeyForMigration(s, 'plex:1')).toBe('sk-ant-scoped')
  })

  it('falls back to the legacy slot when the scoped slot is empty', () => {
    const s = makeStorage({ 'eex.apiKey': 'sk-ant-legacy' })
    expect(readLocalKeyForMigration(s, 'plex:1')).toBe('sk-ant-legacy')
  })

  it('returns null when neither slot holds a value', () => {
    expect(readLocalKeyForMigration(makeStorage(), 'plex:1')).toBeNull()
  })

  it('never reads another sub’s scoped slot', () => {
    const s = makeStorage({ 'eex.apiKey.plex:2': 'sk-ant-other' })
    expect(readLocalKeyForMigration(s, 'plex:1')).toBeNull()
  })
})

describe('clearLocalKey', () => {
  it('removes both the scoped and legacy slots', () => {
    const s = makeStorage({
      'eex.apiKey.plex:1': 'sk-ant-scoped',
      'eex.apiKey': 'sk-ant-legacy',
      'eex.apiKey.plex:2': 'sk-ant-other',
    })
    clearLocalKey(s, 'plex:1')
    expect(s.map.has('eex.apiKey.plex:1')).toBe(false)
    expect(s.map.has('eex.apiKey')).toBe(false)
    // Another member's slot on a shared device is left for THEIR migration.
    expect(s.map.get('eex.apiKey.plex:2')).toBe('sk-ant-other')
  })

  it('swallows storage errors (private mode)', () => {
    const throwing = {
      getItem: () => null,
      removeItem: () => {
        throw new DOMException('SecurityError')
      },
    }
    expect(() => clearLocalKey(throwing, 'plex:1')).not.toThrow()
  })
})
