// Helpers shared by the /api/iptv route modules (see ../iptv.ts).

import { type Context } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { type Env } from '../../middleware/auth.js'
import { iptvDb } from '../../services/iptvDbSingleton.js'
import { verifyStreamToken, type StreamKind } from '../../services/iptvStreamToken.js'
import { memberStatus } from '../../services/membership.js'
import { checkReplay } from '../../services/tokenReplayCache.js'
import { parseSub } from '../../services/sub.js'
import { type SessionView, type SessionKind } from '../../services/iptvConcurrency.js'
import { episodeTitleRow, nameRow } from '../../services/iptvRows.js'
import { env } from '../../env.js'

export function firstHeaderValue(value: string | undefined): string {
  return value?.split(',')[0]?.trim() ?? ''
}

export function safeHost(value: string, fallback: string): string {
  if (!value) return fallback
  if (/[\s/\\]/.test(value)) return fallback
  return value
}

// X-Forwarded-Host / Host are attacker-controlled on any deploy where the
// backend is reachable without the trusted proxy in front, so a host is only
// echoed into minted playlist URLs when it belongs to the operator's
// configured ALLOWED_ORIGINS — either exactly, or as a subdomain (the API
// lives at api.<spa-domain> in the Netlify ↔ NAS split, while ALLOWED_ORIGINS
// carries the SPA origin). An attacker can't serve content from a subdomain
// of the operator's domain without controlling its DNS.
export function isAllowedPublicHost(host: string): boolean {
  const hostname = host.toLowerCase().replace(/:\d+$/, '')
  for (const origin of env.allowedOrigins) {
    let originHostname: string
    try {
      originHostname = new URL(origin).hostname.toLowerCase()
    } catch {
      continue // malformed allowlist entry can never match
    }
    if (hostname === originHostname || hostname.endsWith(`.${originHostname}`)) return true
  }
  return false
}

export function publicBaseUrl(c: Context): string {
  const requestUrl = new URL(c.req.url)
  const forwardedProto = firstHeaderValue(c.req.header('x-forwarded-proto')).toLowerCase()
  const proto = forwardedProto === 'http' || forwardedProto === 'https'
    ? `${forwardedProto}:`
    : requestUrl.protocol
  const host = safeHost(
    firstHeaderValue(c.req.header('x-forwarded-host')) ||
      firstHeaderValue(c.req.header('host')) ||
      requestUrl.host,
    requestUrl.host,
  )
  // No allowlist configured (dev / direct-LAN deploys): header passthrough.
  if (env.allowedOrigins.length === 0) return `${proto}//${host}`
  if (isAllowedPublicHost(host)) return `${proto}//${host}`
  // Forwarded host doesn't belong to the operator — never echo it into a
  // minted URL. Fall back to the first parseable configured origin; if every
  // entry is malformed, use the socket-level request host (not the headers).
  for (const origin of env.allowedOrigins) {
    try {
      return new URL(origin).origin
    } catch {
      continue
    }
  }
  return `${proto}//${requestUrl.host}`
}

// Best-effort client IP. Cloudflare Tunnel terminates TLS at the edge
// and forwards the original visitor IP in CF-Connecting-IP. X-Forwarded-For
// is the fallback for non-CF deploys. Used to label active sessions so the
// user can tell "the browser I'm sitting at" from "that phone in the
// kitchen" when deciding which slot to free.
export function clientIp(c: Context<Env>): string | null {
  const cf = c.req.header('cf-connecting-ip')?.trim()
  if (cf) return cf
  const firstForwarded = c.req.header('x-forwarded-for')
    ?.split(',')
    .map((part) => part.trim())
    .find(Boolean)
  return firstForwarded ?? null
}

// Title resolver for the sessions widget. Called only when listing — keeps
// the tracker itself ignorant of catalog schema. Tolerant of missing rows
// (cleaned catalog, deleted item) by returning null so the UI just shows
// the resourceId.
export function sessionTitle(kind: SessionKind, resourceId: string): string | null {
  const db = iptvDb().raw
  try {
    if (kind === 'live' || kind === 'remux') {
      const row = nameRow(db.prepare('SELECT name FROM channels WHERE stream_id = ?').get(Number(resourceId)))
      return row?.name ?? null
    }
    if (kind === 'vod') {
      const row = nameRow(db.prepare('SELECT name FROM vod WHERE stream_id = ?').get(Number(resourceId)))
      return row?.name ?? null
    }
    if (kind === 'series') {
      const row = episodeTitleRow(
        db.prepare('SELECT title, series_id FROM series_episodes WHERE episode_id = ?').get(resourceId),
      )
      if (!row) return null
      const series = nameRow(db.prepare('SELECT name FROM series WHERE series_id = ?').get(row.series_id))
      return series ? `${series.name}${row.title ? ` — ${row.title}` : ''}` : row.title
    }
    if (kind === 'catchup') {
      // catchup resourceId encoded as streamId|startUtc|durationMin
      const sid = Number(resourceId.split('|')[0])
      const row = nameRow(db.prepare('SELECT name FROM channels WHERE stream_id = ?').get(sid))
      return row?.name ?? null
    }
  } catch {
    return null
  }
  return null
}

// Test-only export: sessionTitle is module-private to keep the session tracker
// ignorant of catalog schema, but its series branch (episode→series join, with
// null-title and missing-row fallbacks) is non-trivial and worth unit-pinning.
export const __test = { sessionTitle }

export function enrichSessions(list: SessionView[]): Array<SessionView & { resolvedTitle: string | null }> {
  return list.map((s) => ({ ...s, resolvedTitle: s.title ?? sessionTitle(s.kind, s.resourceId) }))
}

// Same leak class as the GET /sessions scoping above (commit b7b7bf5), reached
// through the concurrency-cap 429: `acquired.sessions` on iptv_concurrency_limit
// is the WHOLE household's session list, each entry carrying sub/ip/title. On a
// small provider line the cap is hit routinely, and ConcurrencyLimitModal renders
// this exact payload (title + IP) with a kick button. Non-admins must not learn
// who else is streaming what from where. The response SHAPE is a closed-enum
// contract the Swift client Decodable-switches on — every field stays PRESENT,
// only the CONTENT of other members' rows is redacted. The caller's own row (and
// everything, for admins) stays untouched so kick/support visibility doesn't regress.
type RedactedSessionView = Omit<SessionView, 'sub' | 'ip'> & { sub: string | null; ip: string | null; resolvedTitle: string | null }
export function enrichSessionsFor(list: SessionView[], callerSub: string, isAdmin: boolean): RedactedSessionView[] {
  return enrichSessions(list).map((s) => {
    if (isAdmin || s.sub === callerSub) return s
    return { ...s, sub: null, ip: null, title: 'another household member', resolvedTitle: 'another household member' }
  })
}

export const KINDS = new Set(['live', 'vod', 'series'])
export const HIST_KINDS = new Set(['live', 'vod', 'series_episode'])

export function userOf(c: Context<Env>): { sub: string } {
  const session = c.get('session')
  if (session) return { sub: session.sub }

  const user = (c.var as Record<string, unknown>).user
  if (typeof user === 'object' && user != null && 'sub' in user && typeof user.sub === 'string') {
    return { sub: user.sub }
  }
  throw new Error('missing_user')
}

// Constant-time secret comparison (length-prefixed) so a shared-secret check
// doesn't leak via response timing. Mirrors how the other auth secrets compare.
export function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function clientWantsAvplayer(c: Context<Env>): boolean {
  return c.req.query('client') === 'avplayer'
}

// A pass-through TransformStream that invokes `onChunk` for each chunk that
// flows through it. Used to heartbeat a long-lived byte stream's concurrency
// slot (finding 8-1) without buffering or copying the payload. `onChunk` is
// throttled to once per HEARTBEAT_THROTTLE_MS so a high-bitrate stream doesn't
// hammer the tracker Map on every TS packet.
export const HEARTBEAT_THROTTLE_MS = 5_000
export function makeHeartbeatStream(
  onChunk: () => void,
  // Fires once when the UPSTREAM side closes cleanly (EOF), NOT on client abort
  // or upstream error — the transform's flush() only runs on a normal readable
  // completion. The live .ts proxy uses this to tag a dead-placeholder feed.
  onUpstreamEof?: () => void,
): TransformStream<Uint8Array, Uint8Array> {
  let lastBeat = 0
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const now = Date.now()
      if (now - lastBeat >= HEARTBEAT_THROTTLE_MS) {
        lastBeat = now
        try {
          onChunk()
        } catch {
          // Heartbeat is best-effort; never let it break the byte stream.
        }
      }
      controller.enqueue(chunk)
    },
    flush() {
      if (!onUpstreamEof) return
      try {
        onUpstreamEof()
      } catch {
        // Best-effort dead-feed bookkeeping; never let it break teardown.
      }
    },
  })
}

export function formatXtreamTimeshiftStart(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) throw new Error('invalid_start')
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}:${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}`
}

export function parsePositiveInt(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null
  return parsed
}

export function checkToken(c: Context<Env>, expectKind: StreamKind, resourceId: string): { ok: true; sub: string } | { ok: false; resp: Response } {
  const t = c.req.query('t') ?? ''
  try {
    const claims = verifyStreamToken(env.streamTokenSecret, t)
    if (claims.k !== expectKind || claims.rid !== resourceId) {
      return { ok: false, resp: c.json({ error: 'token_mismatch' }, 401) }
    }
    // Per-kind replay enforcement. 'playlist' tokens are not routed through
    // checkToken (they have their own inline path) so the cast is always safe.
    if (claims.k !== 'playlist') {
      const replay = checkReplay(claims.jti, claims.exp, claims.k)
      if (!replay.allowed) {
        return { ok: false, resp: c.json({ error: replay.reason }, 401) }
      }
    }
    // The sub claim must be canonical namespaced form (§8). The M1
    // bare-numeric grace normalization is gone — its 30-day window closed.
    let sub: string
    try {
      sub = parseSub(claims.sub).raw
    } catch {
      return { ok: false, resp: c.json({ error: 'invalid_token', detail: 'sub_invalid_format' }, 401) }
    }
    // Tokens are stateless and live up to 12h: membership must be re-checked
    // at serve time (same as media/transcode/dvr) or revocation cannot reach
    // an already-minted stream grant.
    if (memberStatus(sub) !== 'allowed') {
      return { ok: false, resp: c.json({ error: 'access_revoked' }, 401) }
    }
    return { ok: true, sub }
  } catch (err) {
    return { ok: false, resp: c.json({ error: 'invalid_token', detail: err instanceof Error ? err.message : String(err) }, 401) }
  }
}

// The live remux session index (which viewer owns which ffmpeg session,
// manifest/segment URL rewriting) lives in services/iptvLiveRemuxMap.ts.

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
