import { describe, expect, it } from 'vitest'
import type { CategoryDto } from './api/iptv'
import {
  defaultGuideSelection,
  effectiveGuideCategoryIds,
  formatGuideCategoryCsv,
  isDefaultGuideCategory,
  parseGuideCategoryCsv,
} from './guideCategories'

function cat(category_id: number, name: string): CategoryDto {
  return { category_id, name, parent_id: 0 }
}

// Ported from the Apple app's GuideCategoriesTests, plus the GuideCategoryPrefs
// CSV/effective-selection logic (Apple's SettingsScreen helpers).
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
})

describe('defaultGuideSelection', () => {
  it('returns matching ids in catalog order', () => {
    const cats = [
      cat(1, 'UK| News'),
      cat(2, 'US| Entertainment'),
      cat(3, 'World Sports'),
      cat(4, 'Music Hits'),
    ]
    expect(defaultGuideSelection(cats)).toEqual([2, 3])
  })
})

describe('guide category prefs CSV', () => {
  it('parses and formats a CSV of ids, dropping junk', () => {
    expect(parseGuideCategoryCsv('1, 2,3')).toEqual([1, 2, 3])
    expect(parseGuideCategoryCsv('1,,abc,4')).toEqual([1, 4])
    expect(parseGuideCategoryCsv('')).toEqual([])
    expect(formatGuideCategoryCsv([2, 3])).toBe('2,3')
  })

  it('intersects stored ids with live categories', () => {
    const cats = [cat(1, 'UK| News'), cat(2, 'US| Entertainment'), cat(3, 'World Sports')]
    // 2 is live, 99 is stale → only 2 survives.
    expect(effectiveGuideCategoryIds('2,99', cats)).toEqual([2])
  })

  it('falls back to the US+sports default when the pref is empty or all-stale', () => {
    const cats = [cat(1, 'UK| News'), cat(2, 'US| Entertainment'), cat(3, 'World Sports')]
    expect(effectiveGuideCategoryIds('', cats)).toEqual([2, 3])
    expect(effectiveGuideCategoryIds('99,100', cats)).toEqual([2, 3])
  })
})
