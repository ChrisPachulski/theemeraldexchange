// /api/recommender/event — thin pass-through that lets the SPA mirror
// client-side conversion signals to the local recommender. Only the
// signals that have no other delivery path live here:
//
//   - 'clicked' : user clicked a suggestion card. There's no server
//                 round-trip otherwise (the click resolves locally via
//                 the radarr/sonarr lookup endpoint, which is a read).
//                 Without this mirror, the optimizer can't see which
//                 picks actually got user attention and falls back to
//                 dot-feedback alone — a much narrower signal.
//
// 'added' is NOT exposed here. The radarr/sonarr POST routes fire it
// server-side once the upstream confirms the create. That keeps the
// add signal authoritative (a SPA-side fire could leak when the SPA
// considers an add successful but the upstream actually 4xx'd).
//
// 'like' / 'dislike' / 'reject' have their own dedicated paths under
// /api/feedback, which apply the per-user-guard logic (e.g.
// anotherUserDislikes) before mirroring.

import { Hono } from 'hono'
import { requireAuth, type Env } from '../middleware/auth.js'
import { postFeedback } from '../services/recommender.js'
import { env } from '../env.js'

export const recommenderEvents = new Hono<Env>()

recommenderEvents.use('*', requireAuth)

type ClickEvent = {
  kind?: unknown
  tmdbId?: unknown
  signal?: unknown
}

recommenderEvents.post('/event', async (c) => {
  const session = c.get('session')
  const raw = (await c.req.json().catch(() => null)) as ClickEvent | null
  if (!raw) return c.json({ error: 'invalid_body' }, 400)

  const kind = raw.kind === 'movie' || raw.kind === 'tv' ? raw.kind : null
  if (!kind) return c.json({ error: 'invalid_kind' }, 400)

  // SafeInteger gates malformed tmdb ids (NaN, infinity, decimals) so
  // they can't reach the sidecar's INSERT statements where the
  // CHECK constraint would 500 the mirror but leave the SPA's
  // optimistic update mismatched.
  if (typeof raw.tmdbId !== 'number' || !Number.isSafeInteger(raw.tmdbId) || raw.tmdbId <= 0) {
    return c.json({ error: 'invalid_tmdbId' }, 400)
  }

  // Only 'clicked' lives here — see file header. Locking the signal
  // list prevents the endpoint from becoming a generic mirror that
  // could bypass the per-user guards on the dedicated feedback path.
  if (raw.signal !== 'clicked') {
    return c.json({ error: 'invalid_signal' }, 400)
  }

  // Gate the mirror on env.useLocalRecommender so disabled deployments
  // don't generate sidecar traffic or timeout log noise. The route
  // still 200s — the SPA's fire-and-forget contract is the same in
  // either mode, and validation has already run. Mirrors the gate at
  // /api/feedback.
  if (env.useLocalRecommender) {
    void postFeedback({
      sub: session.sub,
      kind,
      tmdb_id: raw.tmdbId,
      signal: 'clicked',
    })
  }
  return c.json({ ok: true })
})
