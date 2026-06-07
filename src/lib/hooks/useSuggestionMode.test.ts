import { describe, it, expect } from 'vitest'
import {
  STORAGE_KEY,
  readStored,
  isSuggestionModeStorageEvent,
} from './useSuggestionMode'

// vitest runs in the `node` environment (no jsdom). We can't render the
// hook or exercise its storage-event effect, so we pin the extracted PURE
// helpers it delegates to, injecting a Map-backed storage stub instead of
// the ambient localStorage. The default-fallback logic (recommended vs
// trending) lives in the caller and is exercised via the tab integration.

function makeStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem'> {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
  }
}

describe('STORAGE_KEY', () => {
  it("is 'eex.suggestionMode' (renaming silently orphans every device's saved choice)", () => {
    expect(STORAGE_KEY).toBe('eex.suggestionMode')
  })
})

describe('readStored', () => {
  it('returns the stored value for both valid modes', () => {
    expect(readStored(makeStorage({ [STORAGE_KEY]: 'recommended' }))).toBe('recommended')
    expect(readStored(makeStorage({ [STORAGE_KEY]: 'trending' }))).toBe('trending')
  })

  it('returns null when unset, so the caller can apply its deployment default', () => {
    expect(readStored(makeStorage({}))).toBeNull()
  })

  it('returns null for junk / near-miss values (never coerces to a real mode)', () => {
    expect(readStored(makeStorage({ [STORAGE_KEY]: '' }))).toBeNull()
    expect(readStored(makeStorage({ [STORAGE_KEY]: 'Recommended' }))).toBeNull()
    expect(readStored(makeStorage({ [STORAGE_KEY]: '1' }))).toBeNull()
    expect(readStored(makeStorage({ [STORAGE_KEY]: 'ai' }))).toBeNull()
  })
})

describe('isSuggestionModeStorageEvent', () => {
  it('is true for an event keyed on STORAGE_KEY', () => {
    expect(isSuggestionModeStorageEvent({ key: STORAGE_KEY })).toBe(true)
  })

  it('is false for a different key', () => {
    expect(isSuggestionModeStorageEvent({ key: 'eex.apiKey' })).toBe(false)
  })

  it('is false for a null key (whole-storage clear event)', () => {
    expect(isSuggestionModeStorageEvent({ key: null })).toBe(false)
  })

  it('is false for a near-miss prefix key', () => {
    expect(isSuggestionModeStorageEvent({ key: 'eex.suggestionModeX' })).toBe(false)
  })
})
