import { describe, expect, it } from 'vitest'
import type { EpgSearchHit } from '../../lib/api/iptv'
import { groupAirings } from './programmeAirings'

const hit = (streamId: number, title: string, start: string, stop = '2026-10-11T18:30:00Z'): EpgSearchHit => ({
  streamId,
  channelName: `ch ${streamId}`,
  categoryId: 21,
  programIndex: 0,
  programme: { channel_id: `c${streamId}`, start_utc: start, stop_utc: stop, title, description: null },
})

describe('groupAirings', () => {
  it('folds every feed of one airing into one entry, label or not', () => {
    const airings = groupAirings([
      hit(1, 'NHL Hockey : Toronto Maple Leafs at Colorado Avalanche', '2026-10-11T16:00:00Z'),
      hit(2, 'NHL Hockey : Toronto Maple Leafs at Colorado Avalanche', '2026-10-11T16:00:00.000Z'),
      hit(3, 'Toronto Maple Leafs at Colorado Avalanche', '2026-10-11T16:00:00Z'),
      hit(4, 'Toronto Maple Leafs vs. Colorado Avalanche', '2026-10-13T18:00:00Z', '2026-10-13T21:00:00Z'),
    ])
    expect(airings).toHaveLength(2)
    expect(airings[0]).toMatchObject({
      eyebrow: 'NHL Hockey',
      title: 'Toronto Maple Leafs at Colorado Avalanche',
    })
    expect(airings[0].hits.map((h) => h.streamId)).toEqual([1, 2, 3])
    expect(airings[1].hits.map((h) => h.streamId)).toEqual([4])
  })

  it('keeps different programmes in the same slot apart, and colons inside titles', () => {
    const airings = groupAirings([
      hit(1, 'Star Trek: Discovery', '2026-10-11T16:00:00Z'),
      hit(2, 'Toronto Today', '2026-10-11T16:00:00Z'),
    ])
    expect(airings.map((a) => [a.eyebrow, a.title])).toEqual([
      [null, 'Star Trek: Discovery'],
      [null, 'Toronto Today'],
    ])
  })
})
