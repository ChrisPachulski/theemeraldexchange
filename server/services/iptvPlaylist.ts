// Playlist-token CRUD + M3U generation for external players (VLC,
// iPlayTV, TiviMate). Extracted from routes/iptv.ts — the route file
// keeps the HTTP handlers; the token lifecycle (mint / list / revoke /
// authorize) and the M3U body builder live here.
//
// Token model (§5.6 / D12): a playlist token is a 90-day HMAC stream
// token whose jti is persisted in iptv_playlist_tokens at mint time so
// revocation is enforceable. The M3U body embeds short-lived (300 s)
// per-channel `live` tokens — external players re-fetch the M3U often
// enough that the short TTL holds, and it limits credential exposure if
// the M3U body leaks.

import { randomUUID } from 'node:crypto'
import { iptvDb } from './iptvDbSingleton.js'
import { signStreamToken, verifyStreamToken } from './iptvStreamToken.js'
import { memberStatus } from './membership.js'
import { env } from '../env.js'
import {
  channelM3uRow,
  categoryNameRow,
  playlistTokenRow,
  mapRows,
  type PlaylistTokenRow,
} from './iptvRows.js'

/** Canonical resource id carried by every playlist token (§16 D-row). */
const PLAYLIST_RID = 'iptv-channels-all'
const PLAYLIST_TTL_SECS = 90 * 24 * 3600
const CHANNEL_TOKEN_TTL_SECS = 300

export function escapeM3uAttr(value: string): string {
  // Provider-controlled fields (channel name, group title, tvg-id/logo) are
  // interpolated into a quoted #EXTINF attribute and the trailing display name.
  // Collapse CR/LF/tab (which would otherwise inject new playlist lines, e.g. a
  // rogue #EXTINF + stream URL) to a space and neutralize the attribute quote.
  return value.replace(/[\r\n\t]+/g, ' ').replace(/"/g, '\'').trim()
}

export type PlaylistTokenView = {
  jti: string
  sub: string
  deviceName: string | null
  issuedAt: string
  expiresAt: string
  revokedAt: string | null
  revoked: boolean
}

export function playlistTokenView(row: PlaylistTokenRow): PlaylistTokenView {
  return {
    jti: row.jti,
    sub: row.sub,
    deviceName: row.device_name,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revoked: row.revoked_at != null,
  }
}

/** Mint a playlist token for `sub`, persist its jti, and return the
 *  ready-to-paste URL rooted at `baseUrl`. */
export function mintPlaylistToken(opts: {
  sub: string
  deviceName?: string
  baseUrl: string
}): { jti: string; deviceName: string | null; url: string; expiresAt: string } {
  const jti = randomUUID()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + PLAYLIST_TTL_SECS * 1000)
  const token = signStreamToken(env.streamTokenSecret, {
    kind: 'playlist',
    resourceId: PLAYLIST_RID,
    sub: opts.sub,
    ttlSecs: PLAYLIST_TTL_SECS,
    jti,
  })
  iptvDb().stmts.insertPlaylistToken.run({
    jti,
    sub: opts.sub,
    device_name: opts.deviceName ?? null,
    issued_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  })
  return {
    jti,
    deviceName: opts.deviceName ?? null,
    url: `${opts.baseUrl}/api/iptv/playlist.m3u?t=${token}`,
    expiresAt: expiresAt.toISOString(),
  }
}

export function listPlaylistTokens(sub: string): PlaylistTokenView[] {
  const rows = mapRows(playlistTokenRow, iptvDb().stmts.listPlaylistTokensBySub.all(sub))
  return rows.map(playlistTokenView)
}

export type RevokeOutcome = 'revoked' | 'not_found' | 'forbidden' | 'already_revoked'

export function revokePlaylistToken(
  jti: string,
  requester: { sub: string; isAdmin: boolean },
): RevokeOutcome {
  const row = playlistTokenRow(iptvDb().stmts.getPlaylistToken.get(jti))
  if (!row) return 'not_found'
  if (row.sub !== requester.sub && !requester.isAdmin) return 'forbidden'
  const info = iptvDb().stmts.revokePlaylistToken.run(new Date().toISOString(), jti)
  if (info.changes === 0 && row.revoked_at != null) return 'already_revoked'
  return 'revoked'
}

export type PlaylistAuthResult =
  | { ok: true; sub: string }
  | { ok: false; error: string; detail?: string }

/**
 * Authorize a raw `?t=` playlist token: HMAC verification, kind/rid
 * checks, the persistent jti row (revocation, §6.2/D12), and live
 * membership. A token whose member has been revoked is hard-revoked on
 * sight so it can never race back in.
 */
export function authorizePlaylistToken(token: string): PlaylistAuthResult {
  let claims: ReturnType<typeof verifyStreamToken>
  try {
    claims = verifyStreamToken(env.streamTokenSecret, token)
    if (claims.k !== 'playlist') throw new Error('kind_mismatch')
    // §16 D-row: canonical rid only. The M1-era 'all' fallback (D2a
    // migration window) is gone — those tokens have expired.
    if (claims.rid !== PLAYLIST_RID) throw new Error('resource_mismatch')
  } catch (err) {
    return {
      ok: false,
      error: 'invalid_token',
      detail: err instanceof Error ? err.message : String(err),
    }
  }

  // Persistent revocation check: every playlist token minted since D12
  // persists its jti at mint time, so the row lookup is unconditional —
  // no row → reject (pre-D12 tokens have expired naturally).
  const row = playlistTokenRow(iptvDb().stmts.getPlaylistToken.get(claims.jti))
  if (!row) return { ok: false, error: 'token_not_found' }
  if (row.revoked_at != null) return { ok: false, error: 'token_revoked' }

  const status = memberStatus(claims.sub)
  if (status !== 'allowed') {
    if (status === 'revoked') {
      iptvDb().stmts.revokePlaylistToken.run(new Date().toISOString(), claims.jti)
    }
    return { ok: false, error: 'access_revoked' }
  }
  return { ok: true, sub: claims.sub }
}

/** Build the M3U body: every channel, sorted, each with a short-lived
 *  per-channel live token rooted at `baseUrl`. */
export function buildPlaylistM3u(sub: string, baseUrl: string): string {
  const db = iptvDb()
  const channels = mapRows(
    channelM3uRow,
    db.raw
      .prepare(
        `SELECT stream_id, num, name, stream_icon, epg_channel_id, category_id FROM channels ORDER BY num, name`,
      )
      .all(),
  )
  const catNames = new Map<number, string>()
  for (const row of mapRows(
    categoryNameRow,
    db.raw.prepare(`SELECT category_id, name FROM categories WHERE kind='live'`).all(),
  )) {
    catNames.set(row.category_id, row.name)
  }

  const lines: string[] = ['#EXTM3U']
  for (const ch of channels) {
    const chToken = signStreamToken(env.streamTokenSecret, {
      kind: 'live',
      resourceId: String(ch.stream_id),
      sub,
      ttlSecs: CHANNEL_TOKEN_TTL_SECS,
    })
    const url = `${baseUrl}/api/iptv/stream/live/${ch.stream_id}.ts?t=${chToken}`
    const groupTitle = ch.category_id != null ? (catNames.get(ch.category_id) ?? 'Other') : 'Other'
    const tvgId = escapeM3uAttr(ch.epg_channel_id ?? '')
    const tvgLogo = escapeM3uAttr(ch.stream_icon ?? '')
    lines.push(
      `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${escapeM3uAttr(ch.name)}" tvg-logo="${tvgLogo}" group-title="${escapeM3uAttr(groupTitle)}",${escapeM3uAttr(ch.name)}`,
    )
    lines.push(url)
  }
  return lines.join('\n') + '\n'
}
