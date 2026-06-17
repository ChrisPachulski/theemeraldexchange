// Local-media playback authentication via stream tokens.
//
// A cross-origin <video>/hls.js client cannot reliably present the session
// cookie on every byte-range / HLS-segment fetch (no-cors media requests don't
// carry credentials, and adding a Range header to a credentialed cross-origin
// fetch trips CORS preflight). The IPTV player already solved this: bake a
// signed token into the URL query (?t=) so the media GET authenticates itself.
// Local-media playback reuses that exact machinery.
//
// The token `kind` is Rust-canonical (emerald-contracts), so we borrow the two
// existing kinds that fit rather than minting a new one:
//   - 'vod'   — a non-live, seekable file. A local movie/episode IS vod.
//   - 'remux' — the existing MULTI-USE HLS kind (one token authorizes a
//               manifest plus all its segments), exactly the transcoder case.
// Resource ids are namespaced `media:*` so a media token can never satisfy an
// IPTV resource check (and vice-versa) even though the kinds overlap.

import { env } from '../env.js'
import {
  signStreamToken,
  verifyStreamToken,
  type StreamKind,
} from './iptvStreamToken.js'
import { checkReplay } from './tokenReplayCache.js'

/** Direct-play (progressive) token kind. */
export const MEDIA_DIRECT_KIND: StreamKind = 'vod'
/** Transcoder HLS (manifest + segments) token kind — multi-use until exp. */
export const MEDIA_HLS_KIND: StreamKind = 'remux'

/** Resource id bound to a specific library title, e.g. `media:movie:123`. */
export function mediaResourceId(kind: string, id: string | number): string {
  return `media:${kind}:${id}`
}

/** Resource id bound to a transcoder session, e.g. `media:session:<sid>`. */
export function mediaSessionResourceId(sessionId: string): string {
  return `media:session:${sessionId}`
}

export function signMediaToken(opts: {
  sub: string
  rid: string
  kind: StreamKind
}): string {
  return signStreamToken(env.streamTokenSecret, {
    kind: opts.kind,
    resourceId: opts.rid,
    sub: opts.sub,
    ttlSecs: env.MEDIA_STREAM_TOKEN_TTL_SECS,
  })
}

export type MediaTokenCheck =
  | { ok: true; sub: string; kind: StreamKind; rid: string }
  | { ok: false; error: string }

/**
 * Verify a `?t=` media stream token. Enforces, in order: valid signature +
 * time window (STREAM_TOKEN_SECRET only — the D2a SESSION_SECRET fallback is
 * gone, preserving key separation), the `media:` rid namespace, an optional
 * expected kind set, an optional exact rid match (binds a token to one
 * resource), and replay policy (all tracked kinds — vod/remux/segment — are
 * multi-use within TTL; media only ever mints vod/remux).
 */
export function verifyMediaToken(
  token: string,
  opts?: { rid?: string; kinds?: StreamKind[] },
): MediaTokenCheck {
  let claims
  try {
    claims = verifyStreamToken(env.streamTokenSecret, token)
  } catch {
    return { ok: false, error: 'invalid_token' }
  }
  if (!claims.rid.startsWith('media:')) return { ok: false, error: 'token_kind' }
  if (opts?.kinds && !opts.kinds.includes(claims.k)) {
    return { ok: false, error: 'token_kind' }
  }
  if (opts?.rid && claims.rid !== opts.rid) {
    return { ok: false, error: 'token_mismatch' }
  }
  // Media only ever mints 'vod'/'remux'; a 'playlist' kind here is malformed
  // (and checkReplay does not track it). Reject before the replay check so the
  // cast to checkReplay's TrackedKind (StreamKind minus 'playlist') is sound.
  if (claims.k === 'playlist') return { ok: false, error: 'token_kind' }
  const replay = checkReplay(claims.jti, claims.exp, claims.k)
  if (!replay.allowed) return { ok: false, error: replay.reason }
  return { ok: true, sub: claims.sub, kind: claims.k, rid: claims.rid }
}
