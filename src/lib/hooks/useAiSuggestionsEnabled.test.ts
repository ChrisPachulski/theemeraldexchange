import { describe, it, expect } from 'vitest'
import {
  STORAGE_KEY,
  read,
  serializeEnabled,
  isAiSuggestionsStorageEvent,
} from './useAiSuggestionsEnabled'

// vitest runs in the `node` environment (no jsdom, no @testing-library,
// no react-test-renderer). We can't render useAiSuggestionsEnabled or
// exercise its storage-event effect, so we pin the extracted PURE
// helpers it delegates to, injecting a Map-backed storage stub instead
// of the ambient localStorage.

function makeStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem'> {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
  }
}

describe('STORAGE_KEY', () => {
  it("is 'eex.aiSuggestionsEnabled' (renaming silently orphans every device's saved preference)", () => {
    expect(STORAGE_KEY).toBe('eex.aiSuggestionsEnabled')
  })
})

describe('read', () => {
  it("is true ONLY when the stored value is exactly '1'", () => {
    expect(read(makeStorage({ [STORAGE_KEY]: '1' }))).toBe(true)
  })

  it("is false for '0'", () => {
    expect(read(makeStorage({ [STORAGE_KEY]: '0' }))).toBe(false)
  })

  it('defaults OFF when the key is missing (money-saving invariant)', () => {
    expect(read(makeStorage({}))).toBe(false)
  })

  it("is false for truthy-looking near-misses ('true', '', 'TRUE')", () => {
    expect(read(makeStorage({ [STORAGE_KEY]: 'true' }))).toBe(false)
    expect(read(makeStorage({ [STORAGE_KEY]: '' }))).toBe(false)
    expect(read(makeStorage({ [STORAGE_KEY]: 'TRUE' }))).toBe(false)
  })
})

describe('serializeEnabled', () => {
  it("serializes true → '1' and false → '0'", () => {
    expect(serializeEnabled(true)).toBe('1')
    expect(serializeEnabled(false)).toBe('0')
  })

  it('round-trips through read for both booleans', () => {
    for (const b of [true, false]) {
      expect(read(makeStorage({ [STORAGE_KEY]: serializeEnabled(b) }))).toBe(b)
    }
  })
})

describe('isAiSuggestionsStorageEvent', () => {
  it('is true for an event keyed on STORAGE_KEY', () => {
    expect(isAiSuggestionsStorageEvent({ key: STORAGE_KEY })).toBe(true)
  })

  it('is false for a different key', () => {
    expect(isAiSuggestionsStorageEvent({ key: 'eex.apiKey' })).toBe(false)
  })

  it('is false for a null key (whole-storage clear event)', () => {
    expect(isAiSuggestionsStorageEvent({ key: null })).toBe(false)
  })

  it('is false for a near-miss prefix key', () => {
    expect(isAiSuggestionsStorageEvent({ key: 'eex.aiSuggestionsEnabledX' })).toBe(false)
  })
})
