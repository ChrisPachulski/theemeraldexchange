// /api/iptv playlist routes, split from the former single iptv.ts (paths unchanged).

import { Hono } from 'hono'
import { requireAuth } from '../../middleware/auth.js'
import { requireSection, getPolicy } from '../../services/userPolicies.js'
import { capBlocksUnrated } from '../../services/parentalRating.js'
import { effectiveRoleFor } from '../../services/sessionGate.js'
import { authorizePlaylistToken, buildPlaylistM3u, listPlaylistTokens, mintPlaylistToken, revokePlaylistToken } from '../../services/iptvPlaylist.js'
import { parseLimitedJson } from '../../services/parseLimitedJson.js'
import { type Env } from '../../middleware/auth.js'
import { publicBaseUrl, userOf } from './shared.js'

export const iptv = new Hono<Env>()

const PLAYLIST_TOKEN_MAX_BODY_BYTES = 1024

// Playlist-token lifecycle + M3U generation live in services/iptvPlaylist.ts;
// these handlers only parse the HTTP shape and map outcomes to statuses.
iptv.post('/playlist/token', requireAuth, requireSection('live'), async (c) => {
  // The exported M3U is every live channel, each embedding a per-channel
  // `live` token (buildPlaylistM3u) — an unguarded mint here would let a
  // capped member bypass the exact rating gate just added to the live grant
  // by exporting a playlist instead of tuning in-app. Same rule, same
  // exemptions (admins never blocked), applied at the OTHER place a live
  // token gets minted. A token minted before this gate remains valid for
  // its 90-day TTL; DELETE /playlist/tokens/:jti (already existed) revokes
  // it early if that residual window is a concern for a specific member.
  if (await capBlocksUnrated(c.get('session'))) {
    return c.json({ error: 'rating_blocked' }, 403)
  }
  const { sub } = userOf(c)
  // Optional device label — free-form string, max 120 chars. Returned in the
  // response so the admin list can show "iPhone 15 (kitchen)" next to the jti.
  const parsed = await parseLimitedJson(c, PLAYLIST_TOKEN_MAX_BODY_BYTES)
  if (parsed.tooLarge) return c.json({ error: 'body_too_large' }, 413)
  // The shared reader reports "no parseable body" as null; an absent body is
  // fine here (deviceName is optional), so normalize to an empty object.
  const body = (parsed.body ?? {}) as { deviceName?: unknown }
  const deviceName = typeof body.deviceName === 'string'
    ? body.deviceName.trim().slice(0, 120)
    : undefined
  return c.json(mintPlaylistToken({ sub, deviceName, baseUrl: publicBaseUrl(c) }))
})

iptv.get('/playlist/tokens', requireAuth, (c) => {
  const { sub } = userOf(c)
  return c.json({ tokens: listPlaylistTokens(sub) })
})

iptv.delete('/playlist/tokens/:jti', requireAuth, (c) => {
  const session = c.get('session')
  const outcome = revokePlaylistToken(c.req.param('jti'), {
    sub: session.sub,
    isAdmin: session.role === 'admin',
  })
  if (outcome === 'not_found') return c.json({ error: 'not_found' }, 404)
  if (outcome === 'forbidden') return c.json({ error: 'forbidden' }, 403)
  if (outcome === 'already_revoked') return c.json({ error: 'already_revoked' }, 409)
  return c.json({ ok: true })
})

// Hit by external players (VLC, iPlayTV, TiviMate) that have no session
// cookie. Token-in-URL is the auth; see comment on /stream/live/:id.ts.
iptv.get('/playlist.m3u', async (c) => {
  const auth = authorizePlaylistToken(c.req.query('t') ?? '')
  if (!auth.ok) {
    return c.json(
      auth.detail ? { error: auth.error, detail: auth.detail } : { error: auth.error },
      401,
    )
  }
  // Same two gates the mint handler above applies (rating cap AND the live
  // section gate), both re-checked at SERVE time. The mint gate alone leaves
  // a residual hole: a token minted BEFORE a cap was applied, or before an
  // admin turned live off, or before either gate existed, stays valid for
  // its 90-day TTL — a newly-restricted member would keep exporting the full
  // live playlist from VLC until an admin hand-revokes the jti. Policy
  // changes must take effect on the next fetch, not at token expiry.
  //
  // There is no session here (token-in-URL auth, no cookie), so role comes
  // from configured ADMIN_SUBS + the DB members row (effectiveRoleFor) — the
  // same durable authority reconcileSession itself is built on. This is NOT
  // literally identical to the cookie path: a legacy admin granted only via
  // the ADMINS-by-Plex-username allowlist (not ADMIN_SUBS, no admin members
  // row) resolves to 'user' here, since there is no username to check. That
  // fails CLOSED — such an admin could be rating/section-blocked on their
  // own export if they also carry a cap — not a security defect, just a
  // narrower admin recognition than the cookie path's.
  const role = effectiveRoleFor('', auth.sub)
  if (role !== 'admin') {
    const policy = await getPolicy(auth.sub)
    if (policy.allowedSections && !policy.allowedSections.live) {
      return c.json({ error: 'section_blocked' }, 403)
    }
  }
  if (await capBlocksUnrated({ sub: auth.sub, role })) {
    return c.json({ error: 'rating_blocked' }, 403)
  }
  return new Response(buildPlaylistM3u(auth.sub, publicBaseUrl(c)), {
    status: 200,
    headers: {
      'Content-Type': 'audio/x-mpegurl',
      'Content-Disposition': 'attachment; filename="theemeraldexchange.m3u"',
      'Cache-Control': 'no-store',
    },
  })
})
