import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import IptvPlayer from './IptvPlayer'
import type { StreamGrant } from '../../lib/api/iptv'

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
