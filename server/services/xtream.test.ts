import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildPlayerApiUrl, parseAccountInfo, type XtreamCreds } from './xtream.js'

describe('xtream client primitives', () => {
  const creds: XtreamCreds = {
    host: 'https://panel.example',
    username: 'u',
    password: 'p',
  }

  it('builds a player_api URL with action+params', () => {
    expect(buildPlayerApiUrl(creds, 'get_live_categories')).toBe(
      'https://panel.example/player_api.php?username=u&password=p&action=get_live_categories',
    )
    expect(buildPlayerApiUrl(creds, 'get_vod_streams', { category_id: 12 })).toBe(
      'https://panel.example/player_api.php?username=u&password=p&action=get_vod_streams&category_id=12',
    )
  })

  it('parses account info, tolerating string vs number max_connections', () => {
    const a = parseAccountInfo({ user_info: { exp_date: '1893456000', max_connections: '4', status: 'Active' } })
    expect(a.expiresAt instanceof Date).toBe(true)
    expect(a.maxConnections).toBe(4)
    expect(a.status).toBe('Active')

    const b = parseAccountInfo({ user_info: { exp_date: 1893456000, max_connections: 2 } })
    expect(b.maxConnections).toBe(2)
  })
})
