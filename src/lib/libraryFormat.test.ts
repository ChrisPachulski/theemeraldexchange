import { describe, expect, it } from 'vitest'
import type { YoutubeVideo } from './api/media'
import { countLabel, formatUploadDate, metaLine, youtubeShelves } from './libraryFormat'

const video = (id: number, channel: string): YoutubeVideo => ({
  id,
  channel,
  title: `v${id}`,
  uploadDate: null,
  durationSecs: null,
  thumbUrl: null,
})

describe('youtubeShelves', () => {
  it('puts Latest first, then channels in server order, dropping empty rows', () => {
    const shelves = youtubeShelves(
      [video(3, 'PBS'), video(1, 'Kurzgesagt')],
      ['PBS', 'Empty', 'Kurzgesagt'],
      [[video(3, 'PBS')], [], [video(1, 'Kurzgesagt')]],
    )
    expect(shelves.map((s) => [s.id, s.title, s.videos.map((v) => v.id)])).toEqual([
      ['latest', 'Latest', [3, 1]],
      ['channel:PBS', 'PBS', [3]],
      ['channel:Kurzgesagt', 'Kurzgesagt', [1]],
    ])
  })

  it('returns no rows for an empty library', () => {
    expect(youtubeShelves([], [], [])).toEqual([])
  })
})

describe('formatUploadDate', () => {
  it('formats a calendar date in UTC so it never slips a day', () => {
    expect(formatUploadDate('2026-10-01')).toBe('Oct 1, 2026')
    expect(formatUploadDate('2018-02-22')).toBe('Feb 22, 2018')
  })

  it('returns null for missing or malformed dates', () => {
    expect(formatUploadDate(null)).toBeNull()
    expect(formatUploadDate('20180222')).toBeNull()
    expect(formatUploadDate('2018-13-45')).toBeNull()
  })
})

describe('countLabel / metaLine', () => {
  it('pluralizes everything but one', () => {
    expect(countLabel(1, 'album')).toBe('1 album')
    expect(countLabel(0, 'album')).toBe('0 albums')
    expect(countLabel(12, 'track')).toBe('12 tracks')
  })

  it('joins only the known pieces', () => {
    expect(metaLine(['1999', null, '12 tracks', undefined, ''])).toBe('1999 · 12 tracks')
    expect(metaLine([null])).toBe('')
  })
})
