import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import IptvPlayer, {
  audioOptionsFromVideo,
  subtitleOptionsFromVideo,
  selectedAudioFromVideo,
  selectedSubtitleFromVideo,
  setNativeAudioTrack,
  setNativeSubtitleTrack,
  labelForTrack,
} from './IptvPlayer'
import type { StreamGrant } from '../../lib/api/iptv'

// The vitest environment is `node` (see vitest.config.ts), not jsdom — there are
// no DOM globals. So we construct lightweight, numeric-indexed fake track lists
// shaped like MediaTrackList / TextTrackList and cast through `as any` when calling
// the helpers, instead of constructing real HTMLVideoElement / TextTrack objects.

type AudioTrackFake = {
  name?: string
  lang?: string
  language?: string
  label?: string
  enabled?: boolean
}

type TextTrackFake = {
  mode?: 'showing' | 'disabled' | 'hidden'
  label?: string
  language?: string
}

function fakeAudioTracks(tracks: AudioTrackFake[]) {
  const list: Record<number | 'length', unknown> = { length: tracks.length }
  tracks.forEach((t, i) => {
    list[i] = { ...t }
  })
  return list
}

function fakeVideoWithAudio(tracks: AudioTrackFake[]) {
  return { audioTracks: fakeAudioTracks(tracks) }
}

function fakeTextTracks(tracks: TextTrackFake[]) {
  const list: Record<number | 'length', unknown> = { length: tracks.length }
  tracks.forEach((t, i) => {
    list[i] = { ...t }
  })
  return list
}

function fakeVideoWithText(tracks: TextTrackFake[]) {
  return { textTracks: fakeTextTracks(tracks) }
}

describe('IptvPlayer', () => {
  it('renders with progressive grant', () => {
    const grant: StreamGrant = {
      url: '/api/iptv/stream/vod/20/mp4?t=fake',
      delivery: 'progressive',
      mime: 'video/mp4',
    }

    const html = renderToStaticMarkup(<IptvPlayer grant={grant} />)

    expect(html).toContain('<video')
  })

  it('renders with HLS grant', () => {
    const grant: StreamGrant = {
      url: '/api/iptv/stream/live/10/remux/index.m3u8?t=fake',
      delivery: 'hls',
      mime: 'application/vnd.apple.mpegurl',
    }

    const html = renderToStaticMarkup(<IptvPlayer grant={grant} />)

    expect(html).toContain('<video')
  })
})

describe('labelForTrack', () => {
  it('returns track.name when present', () => {
    expect(labelForTrack({ name: 'English' }, 0)).toBe('English')
  })

  it('falls back to label when name is absent', () => {
    expect(labelForTrack({ label: 'Commentary' }, 0)).toBe('Commentary')
  })

  it('falls back to lang when name and label are absent', () => {
    expect(labelForTrack({ lang: 'spa' }, 1)).toBe('spa')
  })

  it('falls back to language when name, label, and lang are absent', () => {
    expect(labelForTrack({ language: 'fra' }, 2)).toBe('fra')
  })

  it('honors the name > label > lang > language precedence', () => {
    expect(
      labelForTrack({ name: 'A', label: 'B', lang: 'C', language: 'D' }, 0),
    ).toBe('A')
    expect(labelForTrack({ label: 'B', lang: 'C', language: 'D' }, 0)).toBe('B')
    expect(labelForTrack({ lang: 'C', language: 'D' }, 0)).toBe('C')
  })

  it('falls back to `Track ${index + 1}` when no fields are present', () => {
    expect(labelForTrack({}, 0)).toBe('Track 1')
    expect(labelForTrack({}, 4)).toBe('Track 5')
  })
})

describe('audioOptionsFromVideo', () => {
  it('returns [] when video.audioTracks is undefined', () => {
    expect(audioOptionsFromVideo({} as never)).toEqual([])
  })

  it('returns [] when audioTracks length is 0', () => {
    expect(audioOptionsFromVideo(fakeVideoWithAudio([]) as never)).toEqual([])
  })

  it('maps N tracks to TrackOption[] with sequential ids and resolved labels', () => {
    const video = fakeVideoWithAudio([{ name: 'English' }, { lang: 'spa' }])
    expect(audioOptionsFromVideo(video as never)).toEqual([
      { id: 0, label: 'English' },
      { id: 1, label: 'spa' },
    ])
  })
})

describe('subtitleOptionsFromVideo', () => {
  it('returns [] when textTracks is empty', () => {
    expect(subtitleOptionsFromVideo(fakeVideoWithText([]) as never)).toEqual([])
  })

  it('maps subtitle tracks to TrackOption[] using label/language fallbacks', () => {
    const video = fakeVideoWithText([
      { label: 'English CC', mode: 'disabled' },
      { language: 'spa', mode: 'disabled' },
    ])
    expect(subtitleOptionsFromVideo(video as never)).toEqual([
      { id: 0, label: 'English CC' },
      { id: 1, label: 'spa' },
    ])
  })
})

describe('selectedAudioFromVideo', () => {
  it('returns 0 when there are no audioTracks', () => {
    expect(selectedAudioFromVideo({} as never)).toBe(0)
  })

  it('returns 0 when audioTracks is empty', () => {
    expect(selectedAudioFromVideo(fakeVideoWithAudio([]) as never)).toBe(0)
  })

  it('returns the index of the first enabled track', () => {
    const video = fakeVideoWithAudio([
      { name: 'English', enabled: false },
      { name: 'Spanish', enabled: true },
      { name: 'French', enabled: false },
    ])
    expect(selectedAudioFromVideo(video as never)).toBe(1)
  })

  it('returns 0 when no track is enabled', () => {
    const video = fakeVideoWithAudio([
      { name: 'English', enabled: false },
      { name: 'Spanish', enabled: false },
    ])
    expect(selectedAudioFromVideo(video as never)).toBe(0)
  })
})

describe('selectedSubtitleFromVideo', () => {
  it('returns -1 when there are no textTracks', () => {
    expect(selectedSubtitleFromVideo(fakeVideoWithText([]) as never)).toBe(-1)
  })

  it('returns -1 when no track is showing', () => {
    const video = fakeVideoWithText([
      { mode: 'disabled' },
      { mode: 'hidden' },
    ])
    expect(selectedSubtitleFromVideo(video as never)).toBe(-1)
  })

  it('returns the index of the first track whose mode === showing', () => {
    const video = fakeVideoWithText([
      { mode: 'disabled' },
      { mode: 'hidden' },
      { mode: 'showing' },
    ])
    expect(selectedSubtitleFromVideo(video as never)).toBe(2)
  })
})

describe('setNativeAudioTrack', () => {
  it('enables only the chosen track id and disables all others', () => {
    const video = fakeVideoWithAudio([
      { name: 'English', enabled: true },
      { name: 'Spanish', enabled: false },
      { name: 'French', enabled: false },
    ])
    setNativeAudioTrack(video as never, 1)
    const tracks = video.audioTracks as Record<number, AudioTrackFake>
    expect([tracks[0].enabled, tracks[1].enabled, tracks[2].enabled]).toEqual([
      false,
      true,
      false,
    ])
  })

  it('no-ops safely when audioTracks is empty', () => {
    expect(() => setNativeAudioTrack(fakeVideoWithAudio([]) as never, 0)).not.toThrow()
  })

  it('no-ops safely when audioTracks is undefined', () => {
    expect(() => setNativeAudioTrack({} as never, 0)).not.toThrow()
  })
})

describe('setNativeSubtitleTrack', () => {
  it('shows only the chosen track id and disables all others', () => {
    const video = fakeVideoWithText([
      { mode: 'disabled' },
      { mode: 'showing' },
      { mode: 'disabled' },
    ])
    setNativeSubtitleTrack(video as never, 0)
    const tracks = video.textTracks as Record<number, TextTrackFake>
    expect([tracks[0].mode, tracks[1].mode, tracks[2].mode]).toEqual([
      'showing',
      'disabled',
      'disabled',
    ])
  })
})
