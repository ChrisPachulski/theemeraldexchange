// Per-user feedback CRUD for the red/green dots under each suggestion
// card. Two stores collaborate:
//   - userFeedback.json   — per-user likes (private positive signal)
//                           and per-user dislikes (rolled up into the
//                           household rejection list).
//   - rejections.json     — household-wide veto list (existing). Any
//                           user's dislike adds to this; removing a
//                           dislike only removes from rejections when
//                           no other user is still dissenting.
//
// Reading returns the caller's own feedback only. Writing keys off the
// caller's session.sub — no other route can edit another user's likes.

import { Hono } from 'hono'
import { requireAuth, type Env } from '../middleware/auth.js'
import {
  getUserFeedback,
  setLike,
  setDislike,
  clearFeedback,
  anotherUserDislikes,
  type FeedbackKind,
  type FeedbackSignal,
} from '../services/userFeedback.js'
import { addRejection, removeRejection } from '../services/rejections.js'

export const feedback = new Hono<Env>()

feedback.use('*', requireAuth)

function isKind(v: unknown): v is FeedbackKind {
  return v === 'movie' || v === 'tv'
}

function isSignal(v: unknown): v is FeedbackSignal {
  return v === 'like' || v === 'dislike'
}

feedback.get('/', async (c) => {
  const session = c.get('session')
  const f = await getUserFeedback(session.sub)
  return c.json(f)
})

feedback.post('/', async (c) => {
  const session = c.get('session')
  const body = (await c.req.json().catch(() => null)) as
    | { type?: unknown; tmdbId?: unknown; signal?: unknown; title?: unknown }
    | null
  if (!body) return c.json({ error: 'invalid_body' }, 400)
  if (!isKind(body.type)) return c.json({ error: 'invalid_type' }, 400)
  if (!isSignal(body.signal)) return c.json({ error: 'invalid_signal' }, 400)
  const tmdbId = Number(body.tmdbId)
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
    return c.json({ error: 'invalid_tmdbId' }, 400)
  }
  const title = typeof body.title === 'string' ? body.title : ''

  if (body.signal === 'dislike') {
    await setDislike(session.sub, body.type, tmdbId, title)
    // Roll into the household veto so nobody re-sees the title.
    await addRejection(body.type, tmdbId, title)
  } else {
    await setLike(session.sub, body.type, tmdbId, title)
  }
  return c.json({ ok: true })
})

feedback.delete('/:type/:tmdbId/:signal', async (c) => {
  const session = c.get('session')
  const type = c.req.param('type')
  const signal = c.req.param('signal')
  const tmdbId = Number(c.req.param('tmdbId'))
  if (!isKind(type)) return c.json({ error: 'invalid_type' }, 400)
  if (!isSignal(signal)) return c.json({ error: 'invalid_signal' }, 400)
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
    return c.json({ error: 'invalid_tmdbId' }, 400)
  }

  await clearFeedback(session.sub, type, tmdbId)
  if (signal === 'dislike') {
    // Only drop from household rejections if no other user still has
    // it disliked — otherwise we'd unblock a title against another
    // member's wishes.
    const stillDissenting = await anotherUserDislikes(session.sub, type, tmdbId)
    if (!stillDissenting) await removeRejection(type, tmdbId)
  }
  return c.json({ ok: true })
})
