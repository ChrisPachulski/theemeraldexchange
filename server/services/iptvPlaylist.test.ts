import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hermetic deps: a controllable in-memory DB stub, stubbed token sign/verify,
// membership, env, and identity row-mappers (the real mappers are exercised by
// their own row tests; here we drive the playlist logic/branches directly).
const db = vi.hoisted(() => ({
  getRow: null as unknown,
  revokeChanges: 1,
  channels: [] as unknown[],
  categories: [] as unknown[],
  listRows: [] as unknown[],
  insertRun: vi.fn(),
  revokeRun: vi.fn(),
}))
const tok = vi.hoisted(() => ({ verify: vi.fn(), member: vi.fn() }))

vi.mock('./iptvDbSingleton.js', () => ({
  iptvDb: () => ({
    stmts: {
      insertPlaylistToken: { run: db.insertRun },
      listPlaylistTokensBySub: { all: () => db.listRows },
      getPlaylistToken: { get: () => db.getRow },
      revokePlaylistToken: { run: (...a: unknown[]) => { db.revokeRun(...a); return { changes: db.revokeChanges } } },
    },
    raw: {
      prepare: (sql: string) => ({
        all: () => (/FROM channels/.test(sql) ? db.channels : db.categories),
      }),
    },
  }),
}))
vi.mock('./iptvStreamToken.js', () => ({
  signStreamToken: () => 'TOK',
  verifyStreamToken: (...a: unknown[]) => tok.verify(...a),
}))
vi.mock('./membership.js', () => ({ memberStatus: (...a: unknown[]) => tok.member(...a) }))
vi.mock('../env.js', () => ({ env: { streamTokenSecret: 'sec' } }))
vi.mock('./iptvRows.js', () => ({
  playlistTokenRow: (r: unknown) => r,
  channelM3uRow: (r: unknown) => r,
  categoryNameRow: (r: unknown) => r,
  mapRows: (m: (r: unknown) => unknown, rows: unknown[]) => rows.map(m),
}))

import {
  escapeM3uAttr,
  playlistTokenView,
  mintPlaylistToken,
  listPlaylistTokens,
  revokePlaylistToken,
  authorizePlaylistToken,
  buildPlaylistM3u,
} from './iptvPlaylist.js'

beforeEach(() => {
  db.getRow = null
  db.revokeChanges = 1
  db.channels = []
  db.categories = []
  db.listRows = []
  db.insertRun.mockClear()
  db.revokeRun.mockClear()
  tok.verify.mockReset()
  tok.member.mockReset()
})

describe('escapeM3uAttr', () => {
  it('collapses CR/LF/tab and neutralises quotes (playlist-injection guard)', () => {
    expect(escapeM3uAttr('a\r\nb\tc')).toBe('a b c')
    expect(escapeM3uAttr('say "hi"')).toBe("say 'hi'")
    expect(escapeM3uAttr('  trim me  ')).toBe('trim me')
  })
})

describe('playlistTokenView', () => {
  const base = {
    jti: 'j',
    sub: 's',
    device_name: 'TV',
    issued_at: 'i',
    expires_at: 'e',
    revoked_at: null,
  }
  it('maps an active row', () => {
    expect(playlistTokenView({ ...base })).toMatchObject({ deviceName: 'TV', revoked: false, revokedAt: null })
  })
  it('flags a revoked row', () => {
    expect(playlistTokenView({ ...base, revoked_at: 'r' }).revoked).toBe(true)
  })
})

describe('mintPlaylistToken', () => {
  it('persists the jti and returns a ready-to-paste url', () => {
    const out = mintPlaylistToken({ sub: 's', deviceName: 'Living Room', baseUrl: 'https://h' })
    expect(out.url).toBe('https://h/api/iptv/playlist.m3u?t=TOK')
    expect(out.deviceName).toBe('Living Room')
    expect(db.insertRun).toHaveBeenCalledTimes(1)
  })
  it('defaults deviceName to null', () => {
    expect(mintPlaylistToken({ sub: 's', baseUrl: 'https://h' }).deviceName).toBeNull()
  })
})

describe('listPlaylistTokens', () => {
  it('maps each row to a view', () => {
    db.listRows = [{ jti: 'a', sub: 's', device_name: null, issued_at: 'i', expires_at: 'e', revoked_at: null }]
    const out = listPlaylistTokens('s')
    expect(out).toHaveLength(1)
    expect(out[0].jti).toBe('a')
  })
})

describe('revokePlaylistToken', () => {
  it('not_found when the row is absent', () => {
    db.getRow = null
    expect(revokePlaylistToken('j', { sub: 's', isAdmin: false })).toBe('not_found')
  })
  it('forbidden when a non-admin targets another sub', () => {
    db.getRow = { sub: 'owner', revoked_at: null }
    expect(revokePlaylistToken('j', { sub: 'other', isAdmin: false })).toBe('forbidden')
  })
  it('revoked on success', () => {
    db.getRow = { sub: 'owner', revoked_at: null }
    db.revokeChanges = 1
    expect(revokePlaylistToken('j', { sub: 'owner', isAdmin: false })).toBe('revoked')
  })
  it('already_revoked when no rows change and the row was revoked', () => {
    db.getRow = { sub: 'owner', revoked_at: 'r' }
    db.revokeChanges = 0
    expect(revokePlaylistToken('j', { sub: 'owner', isAdmin: true })).toBe('already_revoked')
  })
})

describe('authorizePlaylistToken', () => {
  it('invalid_token on a non-playlist kind', () => {
    tok.verify.mockReturnValue({ k: 'live', rid: 'iptv-channels-all', jti: 'j', sub: 's' })
    expect(authorizePlaylistToken('t')).toMatchObject({ ok: false, error: 'invalid_token' })
  })
  it('invalid_token on a resource mismatch', () => {
    tok.verify.mockReturnValue({ k: 'playlist', rid: 'wrong', jti: 'j', sub: 's' })
    expect(authorizePlaylistToken('t')).toMatchObject({ ok: false, error: 'invalid_token' })
  })
  it('token_not_found when the jti row is gone', () => {
    tok.verify.mockReturnValue({ k: 'playlist', rid: 'iptv-channels-all', jti: 'j', sub: 's' })
    db.getRow = null
    expect(authorizePlaylistToken('t')).toMatchObject({ ok: false, error: 'token_not_found' })
  })
  it('token_revoked when the row is revoked', () => {
    tok.verify.mockReturnValue({ k: 'playlist', rid: 'iptv-channels-all', jti: 'j', sub: 's' })
    db.getRow = { sub: 's', revoked_at: 'r' }
    expect(authorizePlaylistToken('t')).toMatchObject({ ok: false, error: 'token_revoked' })
  })
  it('access_revoked and hard-revokes when membership is revoked', () => {
    tok.verify.mockReturnValue({ k: 'playlist', rid: 'iptv-channels-all', jti: 'j', sub: 's' })
    db.getRow = { sub: 's', revoked_at: null }
    tok.member.mockReturnValue('revoked')
    expect(authorizePlaylistToken('t')).toMatchObject({ ok: false, error: 'access_revoked' })
    expect(db.revokeRun).toHaveBeenCalled()
  })
  it('ok for an allowed member', () => {
    tok.verify.mockReturnValue({ k: 'playlist', rid: 'iptv-channels-all', jti: 'j', sub: 's' })
    db.getRow = { sub: 's', revoked_at: null }
    tok.member.mockReturnValue('allowed')
    expect(authorizePlaylistToken('t')).toEqual({ ok: true, sub: 's' })
  })
})

describe('buildPlaylistM3u', () => {
  it('emits an #EXTM3U body with a per-channel tokenised url and group title', () => {
    db.channels = [
      { stream_id: 5, num: 1, name: 'News A', stream_icon: null, epg_channel_id: null, category_id: 1 },
      { stream_id: 6, num: 2, name: 'Sports', stream_icon: 'l.png', epg_channel_id: 'e', category_id: null },
    ]
    db.categories = [{ category_id: 1, name: 'News' }]
    const m3u = buildPlaylistM3u('s', 'https://h')
    expect(m3u.startsWith('#EXTM3U')).toBe(true)
    expect(m3u).toContain('https://h/api/iptv/stream/live/5.ts?t=TOK')
    expect(m3u).toContain('group-title="News"')
    expect(m3u).toContain('group-title="Other"') // category_id null → Other
  })
})
