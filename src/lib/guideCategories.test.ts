import { describe, expect, it, vi } from 'vitest'
import type { CategoryDto } from './api/iptv'
import {
  defaultGuideSelection,
  effectiveGuideCategoryIds,
  formatGuideCategoryNames,
  guideCategoryIdsForNames,
  isAdultCategory,
  isDefaultGuideCategory,
  parseGuideCategoryNames,
  readGuidePreview,
  writeGuidePreview,
} from './guideCategories'

function cat(category_id: number, name: string): CategoryDto {
  return { category_id, name, parent_id: 0 }
}

// Ported from the Apple app's GuideCategoriesTests, plus the GuideCategoryPrefs
// name-keyed effective-selection logic (Apple's SettingsScreen helpers).
describe('isDefaultGuideCategory', () => {
  it('matches US-region and sports, not lookalikes', () => {
    for (const name of ['US| News', 'USA| Sports', 'US - Locals', 'us entertainment', 'World Sports', 'PPV SPORTS']) {
      expect(isDefaultGuideCategory(name), name).toBe(true)
    }
    // "US" appearing mid-word must NOT match.
    for (const name of ['MUSIC', 'PLUS HD', 'AUSTRALIA', 'UK| News', 'CA Movies']) {
      expect(isDefaultGuideCategory(name), name).toBe(false)
    }
  })

  it('never qualifies an adult category, even with a US prefix or "sports"', () => {
    for (const name of ['USA XXX', 'US| Adult', 'XXX Sports', 'US 18+']) {
      expect(isDefaultGuideCategory(name), name).toBe(false)
    }
  })
})

describe('isAdultCategory', () => {
  it('matches whole adult tokens only', () => {
    for (const name of ['XXX', 'XXX OnlyFans', 'Adult', 'ADULTS 24/7', '18+ Channels', 'porn hd', 'US| XXX']) {
      expect(isAdultCategory(name), name).toBe(true)
    }
    for (const name of ['US| News', 'Boxxxing', 'Adulting Today', 'Kids 18', 'Sports+']) {
      expect(isAdultCategory(name), name).toBe(false)
    }
  })
})

describe('defaultGuideSelection', () => {
  it('returns matching ids in catalog order', () => {
    const cats = [
      cat(1, 'UK| News'),
      cat(2, 'US| Entertainment'),
      cat(3, 'World Sports'),
      cat(4, 'Music Hits'),
      cat(5, 'USA XXX'),
    ]
    expect(defaultGuideSelection(cats)).toEqual([2, 3])
  })
})

describe('guide category prefs (stored by name)', () => {
  it('parses and formats newline-separated names, keeping commas and pipes', () => {
    expect(parseGuideCategoryNames('US| News\n Sports, Live \n\n')).toEqual(['US| News', 'Sports, Live'])
    expect(parseGuideCategoryNames('')).toEqual([])
    expect(formatGuideCategoryNames(['US| News', 'Sports, Live'])).toBe('US| News\nSports, Live')
  })

  it('resolves names to today’s ids case-insensitively, in catalog order', () => {
    const cats = [cat(10, 'UK| News'), cat(20, 'US| Entertainment'), cat(30, 'World Sports')]
    expect(guideCategoryIdsForNames(['world sports', 'UK| News', 'Gone'], cats)).toEqual([10, 30])
  })

  it('follows a category the provider renumbered (names, not ids)', () => {
    const before = [cat(1, 'UK| News'), cat(2, 'US| Sports')]
    const after = [cat(7, 'XXX'), cat(8, 'UK| News'), cat(9, 'US| Sports')]
    const stored = formatGuideCategoryNames(['UK| News'])
    expect(effectiveGuideCategoryIds(stored, before)).toEqual([1])
    expect(effectiveGuideCategoryIds(stored, after)).toEqual([8])
  })

  it('never resolves a saved adult category', () => {
    const cats = [cat(1, 'XXX'), cat(2, 'UK| News')]
    expect(guideCategoryIdsForNames(['XXX', 'UK| News'], cats)).toEqual([2])
  })

  it('falls back to the US+sports default when the pref is empty or names nothing live', () => {
    const cats = [cat(1, 'UK| News'), cat(2, 'US| Entertainment'), cat(3, 'World Sports')]
    expect(effectiveGuideCategoryIds('', cats)).toEqual([2, 3])
    expect(effectiveGuideCategoryIds('Gone\nAlso gone', cats)).toEqual([2, 3])
  })

  it('is empty (the guide fails closed) when nothing qualifies', () => {
    expect(effectiveGuideCategoryIds('', [cat(1, 'UK| News'), cat(2, 'XXX')])).toEqual([])
  })
})

describe('guide live-preview pref', () => {
  it('defaults off, round-trips, and stays off when storage throws', () => {
    const map = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) })
    expect(readGuidePreview()).toBe(false)
    writeGuidePreview(true)
    expect(readGuidePreview()).toBe(true)
    writeGuidePreview(false)
    expect(readGuidePreview()).toBe(false)
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } })
    expect(() => writeGuidePreview(true)).not.toThrow()
    expect(readGuidePreview()).toBe(false)
  })
})
