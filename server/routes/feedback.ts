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
import { addRejection, getRejectionIds, removeRejection } from '../services/rejections.js'
import {
  postFeedback,
  postRejection,
  postClearFeedback,
  postClearRejection,
} from '../services/recommender.js'
import { env } from '../env.js'

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

  // Tracks whether the like branch dropped a household veto so the
  // recommender mirror below knows to send the matching rejection-clear.
  let rejectionClearedByLike = false

  if (body.signal === 'dislike') {
    // Two-step write with rollback. We do the household rejection
    // FIRST because:
    //   - its rollback is simple (removeRejection, conditional on no
    //     other dissent), no prior-state reconstruction needed;
    //   - if it fails, no personal state has changed yet → clean
    //     500 with no split-brain.
    // After it succeeds, attempt the personal dislike. If THAT fails,
    // undo the household rejection — but only when our call was the
    // one that added it (otherwise we'd erase another user's dissent).
    const wasAlreadyRejected = (await getRejectionIds(body.type)).has(tmdbId)
    await addRejection(body.type, tmdbId, title)
    try {
      await setDislike(session.sub, body.type, tmdbId, title)
    } catch (err) {
      if (!wasAlreadyRejected) {
        const stillDissenting = await anotherUserDislikes(
          session.sub,
          body.type,
          tmdbId,
        ).catch(() => true)
        if (!stillDissenting) {
          await removeRejection(body.type, tmdbId).catch((rbErr) => {
            console.error(
              '[feedback] dislike rollback failed — split-brain (rejection persisted, personal write failed):',
              { setErr: err, rbErr },
            )
          })
        }
      }
      throw err
    }
  } else {
    // Like branch. Red-to-green toggle: if the caller's PRIOR signal
    // was dislike, that dislike was rolled into the household veto.
    // Switching to a like means we must also drop the veto (assuming
    // nobody else still dislikes), otherwise the title stays in
    // kindRejections and is silently filtered out of every suggestion
    // call — the user sees their green dot but their like has no
    // effect. removeRejection FIRST keeps failure modes clean (its
    // failure is a clean 500 with no personal mutation). On setLike
    // failure we restore the rejection so we don't leave the title
    // visible to other users.
    const f = await getUserFeedback(session.sub)
    const priorDislike = f[body.type].disliked.find((e) => e.id === tmdbId)
    if (priorDislike) {
      const stillDissenting = await anotherUserDislikes(
        session.sub,
        body.type,
        tmdbId,
      )
      if (!stillDissenting) {
        await removeRejection(body.type, tmdbId)
        rejectionClearedByLike = true
      }
    }
    try {
      await setLike(session.sub, body.type, tmdbId, title)
    } catch (err) {
      if (rejectionClearedByLike) {
        await addRejection(
          body.type,
          tmdbId,
          priorDislike?.title ?? title,
        ).catch((rbErr) => {
          console.error(
            '[feedback] red-to-green rollback failed — split-brain (rejection cleared, like write failed):',
            { setErr: err, rbErr },
          )
        })
      }
      throw err
    }
  }
  // Mirror to the recommender so the optimizer learns from outcomes.
  if (env.useLocalRecommender) {
    void postFeedback({ sub: session.sub, kind: body.type, tmdb_id: tmdbId, signal: body.signal })
    if (body.signal === 'dislike') {
      void postRejection({ kind: body.type, tmdb_id: tmdbId })
    } else if (rejectionClearedByLike) {
      // Mirror the household-veto removal triggered by red→green so
      // the recommender's household_rejections stays in sync.
      void postClearRejection({ kind: body.type, tmdb_id: tmdbId })
    }
  }
  return c.json({ ok: true })
})

feedback.delete('/:type/:tmdbId/:signal', async (c) => {
  const session = c.get('session')
  const type = c.req.param('type')
  const signalParam = c.req.param('signal')
  const tmdbId = Number(c.req.param('tmdbId'))
  if (!isKind(type)) return c.json({ error: 'invalid_type' }, 400)
  if (!isSignal(signalParam)) return c.json({ error: 'invalid_signal' }, 400)
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
    return c.json({ error: 'invalid_tmdbId' }, 400)
  }

  // URL :signal is a client hint that may be stale (rapid double-click,
  // cross-tab signal change). Server-side truth determines whether to
  // clean up the household rejection: only when the caller's ACTUAL
  // prior signal was a dislike. If the URL said 'dislike' but the
  // stored signal was 'like', a naive cleanup would either be a no-op
  // (id not in household) or — worse — race with another user.
  const f = await getUserFeedback(session.sub)
  const priorDislike = f[type].disliked.find((e) => e.id === tmdbId)
  const priorLike = f[type].liked.find((e) => e.id === tmdbId)
  const actualPrior: 'like' | 'dislike' | null = priorDislike
    ? 'dislike'
    : priorLike
      ? 'like'
      : null
  const priorTitle = priorDislike?.title ?? priorLike?.title ?? ''

  await clearFeedback(session.sub, type, tmdbId)

  // Track whether removeRejection actually fired so the recommender
  // mirror below knows to send the rejection-clear too.
  let rejectionWasRemoved = false
  if (actualPrior === 'dislike') {
    try {
      // Only drop from household rejections if no other user still has
      // it disliked — otherwise we'd unblock a title against another
      // member's wishes.
      const stillDissenting = await anotherUserDislikes(session.sub, type, tmdbId)
      if (!stillDissenting) {
        await removeRejection(type, tmdbId)
        rejectionWasRemoved = true
      }
    } catch (err) {
      // Restore the prior signal so the user isn't left with cleared
      // personal feedback while the household veto still applies.
      try {
        await setDislike(session.sub, type, tmdbId, priorTitle)
      } catch (rbErr) {
        console.error(
          '[feedback] dislike-delete rollback failed — split-brain (personal cleared, household veto kept):',
          { remErr: err, rbErr },
        )
      }
      throw err
    }
  }

  // Mirror to recommender so its tables converge with Hono's truth.
  // Always send a clear event — the recommender INSERTs by
  // (sub, kind, tmdb_id, signal) so without an explicit clear a
  // toggle leaves stale opposite-signal rows that load_user_context
  // unions back in.
  if (env.useLocalRecommender) {
    void postClearFeedback({ sub: session.sub, kind: type, tmdb_id: tmdbId })
    if (rejectionWasRemoved) {
      void postClearRejection({ kind: type, tmdb_id: tmdbId })
    }
  }
  return c.json({ ok: true })
})
