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

// Per-item mutex around the two-store (userFeedback + rejections)
// mutations. Each store has its own internal write queue, but there's
// no coordination BETWEEN them — so a red-to-green flow ("check
// anotherUserDislikes false → removeRejection → setLike") can
// interleave with a concurrent dislike on the same title and leave a
// dislike WITHOUT the matching household veto. Serializing on
// (kind, tmdbId) keeps unrelated titles parallel while preventing
// the cross-file race on the same one.
const itemLocks = new Map<string, Promise<void>>()

async function withItemLock<T>(
  kind: FeedbackKind,
  tmdbId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${kind}:${tmdbId}`
  const prev = itemLocks.get(key) ?? Promise.resolve()
  // Wait for the prior holder either way (fulfilled or rejected) — a
  // failed prior op is its caller's problem; we still get our turn.
  const op = prev.then(fn, fn)
  // Tail tracker: never rejects, signals "I'm done" to the next
  // awaiter so prev.then(fn, fn) wakes up cleanly.
  const tail = op.then(
    () => undefined,
    () => undefined,
  )
  itemLocks.set(key, tail)
  // GC: when this op settles, if no later caller has overwritten the
  // entry, remove it so the map doesn't grow per distinct title.
  tail.then(() => {
    if (itemLocks.get(key) === tail) itemLocks.delete(key)
  })
  return op
}

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
  // Stores normalize to positive integer ids on read (see
  // services/rejections.ts and services/userFeedback.ts); accepting
  // 1.5 or 1e20 here would persist a row the next load() would
  // silently drop, leaving the route looking like it succeeded.
  if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) {
    return c.json({ error: 'invalid_tmdbId' }, 400)
  }
  const title = typeof body.title === 'string' ? body.title : ''
  const type: FeedbackKind = body.type
  const signal: FeedbackSignal = body.signal

  return withItemLock(type, tmdbId, async () => {
  // Tracks whether the like branch dropped a household veto so the
  // recommender mirror below knows to send the matching rejection-clear.
  let rejectionClearedByLike = false

  if (signal === 'dislike') {
    // Two-step write with rollback. We do the household rejection
    // FIRST because:
    //   - its rollback is simple (removeRejection, conditional on no
    //     other dissent), no prior-state reconstruction needed;
    //   - if it fails, no personal state has changed yet → clean
    //     500 with no split-brain.
    // After it succeeds, attempt the personal dislike. If THAT fails,
    // undo the household rejection — but only when our call was the
    // one that added it (otherwise we'd erase another user's dissent).
    const wasAlreadyRejected = (await getRejectionIds(type)).has(tmdbId)
    await addRejection(type, tmdbId, title)
    try {
      await setDislike(session.sub, type, tmdbId, title)
    } catch (err) {
      if (!wasAlreadyRejected) {
        const stillDissenting = await anotherUserDislikes(
          session.sub,
          type,
          tmdbId,
        ).catch(() => true)
        if (!stillDissenting) {
          await removeRejection(type, tmdbId).catch((rbErr) => {
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
    const priorDislike = f[type].disliked.find((e) => e.id === tmdbId)
    if (priorDislike) {
      const stillDissenting = await anotherUserDislikes(
        session.sub,
        type,
        tmdbId,
      )
      if (!stillDissenting) {
        await removeRejection(type, tmdbId)
        rejectionClearedByLike = true
      }
    }
    try {
      await setLike(session.sub, type, tmdbId, title)
    } catch (err) {
      if (rejectionClearedByLike) {
        await addRejection(
          type,
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
    void postFeedback({ sub: session.sub, kind: type, tmdb_id: tmdbId, signal: signal })
    if (signal === 'dislike') {
      void postRejection({ kind: type, tmdb_id: tmdbId })
    } else if (rejectionClearedByLike) {
      // Mirror the household-veto removal triggered by red→green so
      // the recommender's household_rejections stays in sync.
      void postClearRejection({ kind: type, tmdb_id: tmdbId })
    }
  }
  return c.json({ ok: true })
  })
})

feedback.delete('/:type/:tmdbId/:signal', async (c) => {
  const session = c.get('session')
  const typeParam = c.req.param('type')
  const signalParam = c.req.param('signal')
  const tmdbId = Number(c.req.param('tmdbId'))
  if (!isKind(typeParam)) return c.json({ error: 'invalid_type' }, 400)
  if (!isSignal(signalParam)) return c.json({ error: 'invalid_signal' }, 400)
  // Same safe-integer constraint as POST — keep DELETE in sync so a
  // malformed id can't make it past the route guard.
  if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) {
    return c.json({ error: 'invalid_tmdbId' }, 400)
  }
  const type = typeParam

  return withItemLock(type, tmdbId, async () => {
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
  // Always send a clear event for dot signals so stale mirrored like/dislike
  // rows don't survive a toggle or clear.
  if (env.useLocalRecommender) {
    void postClearFeedback({
      sub: session.sub,
      kind: type,
      tmdb_id: tmdbId,
      signal: actualPrior ?? undefined,
    })
    if (rejectionWasRemoved) {
      void postClearRejection({ kind: type, tmdb_id: tmdbId })
    }
  }
  return c.json({ ok: true })
  })
})
