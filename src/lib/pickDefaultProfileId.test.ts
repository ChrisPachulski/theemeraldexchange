import { describe, it, expect } from 'vitest'
import { pickDefaultProfileId } from './pickDefaultProfileId'
import { pickProfile } from '../../server/services/arrAdd'

type Profile = { id: number; name: string }

describe('pickDefaultProfileId', () => {
  it('returns null for an undefined or empty profile list', () => {
    expect(pickDefaultProfileId(undefined, 'choose me')).toBeNull()
    expect(pickDefaultProfileId([], 'choose me')).toBeNull()
  })

  it('matches the curated name ignoring case and whitespace on EITHER side', () => {
    const profiles: Profile[] = [
      { id: 1, name: 'Any' },
      { id: 2, name: 'choose me' },
    ]
    expect(pickDefaultProfileId(profiles, ' Choose Me ')).toBe(2)
    expect(pickDefaultProfileId([{ id: 7, name: '  CHOOSE ME  ' }], 'choose me')).toBe(7)
  })

  it('prefers a 1080p profile when no name matches (the reported regression)', () => {
    const profiles: Profile[] = [
      { id: 1, name: 'Any' },
      { id: 2, name: 'HD - 1080p' },
    ]
    expect(pickDefaultProfileId(profiles, 'choose me')).toBe(2)
  })

  it('falls back to a profile starting with "hd" when nothing contains 1080p', () => {
    const profiles: Profile[] = [
      { id: 1, name: 'Any' },
      { id: 2, name: 'SD' },
      { id: 3, name: 'HD-720p' },
    ]
    expect(pickDefaultProfileId(profiles, 'choose me')).toBe(3)
  })

  it('falls back to anything that is not "Any"', () => {
    const profiles: Profile[] = [
      { id: 1, name: ' Any ' },
      { id: 2, name: 'Ultra-HD' },
    ]
    // 'Ultra-HD' neither contains 1080p nor starts with 'hd', so it wins only
    // on the not-'any' rung — and the leading/trailing space on 'Any' must not
    // let it slip through as a non-'any' name.
    expect(pickDefaultProfileId(profiles, 'choose me')).toBe(2)
  })

  it('returns the first profile when every rung fails', () => {
    expect(pickDefaultProfileId([{ id: 9, name: 'ANY' }], 'choose me')).toBe(9)
    expect(
      pickDefaultProfileId(
        [
          { id: 4, name: 'any' },
          { id: 5, name: ' ANY ' },
        ],
        'choose me',
      ),
    ).toBe(4)
  })

  it('agrees with the server pickProfile chain it duplicates', () => {
    // The Add modals always send qualityProfileId, so the server's own fallback
    // never runs to correct a client-side mismatch — these two MUST stay in
    // lockstep. Cross-check the whole chain on the same fixtures.
    const cases: Profile[][] = [
      [
        { id: 1, name: 'Any' },
        { id: 2, name: 'HD - 1080p' },
      ],
      [
        { id: 1, name: 'Any' },
        { id: 2, name: 'SD' },
        { id: 3, name: 'HD-720p' },
      ],
      [
        { id: 1, name: ' Any ' },
        { id: 2, name: 'Ultra-HD' },
      ],
      [{ id: 9, name: 'ANY' }],
      [
        { id: 1, name: 'Any' },
        { id: 2, name: 'choose me' },
      ],
    ]
    for (const profiles of cases) {
      expect(pickDefaultProfileId(profiles, 'choose me')).toBe(pickProfile(profiles, 'choose me')?.id)
    }
  })
})
