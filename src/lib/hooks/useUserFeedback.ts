import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiUrl } from '../api/base'

// Per-user red/green feedback for the dots under each suggestion card.
// Red (dislike) writes to BOTH the user's private dislike list AND the
// household rejection list — server side. Green (like) writes only to
// the per-user list (private positive signal to Claude).
//
// The hook tracks which dot is set for each TMDB id so the dots
// component can render the current state and toggle correctly.
// Entries carry titles alongside ids so the suggestions route can
// render "you liked <Title>" / "never suggest <Title>" blocks for
// Claude — bare ids are unactionable signal for the model.

export type FeedbackKind = 'movie' | 'tv'
export type FeedbackSignal = 'like' | 'dislike'
export type FeedbackEntry = { id: number; title: string }

type KindBucket = { liked: FeedbackEntry[]; disliked: FeedbackEntry[] }
type FeedbackResponse = { movie: KindBucket; tv: KindBucket }

const EMPTY: FeedbackResponse = {
  movie: { liked: [], disliked: [] },
  tv: { liked: [], disliked: [] },
}

async function fetchFeedback(): Promise<FeedbackResponse> {
  const r = await fetch(apiUrl('/api/feedback'), { credentials: 'include' })
  if (!r.ok) return EMPTY
  return (await r.json()) as FeedbackResponse
}

export function useFeedback() {
  return useQuery({
    queryKey: ['feedback'],
    queryFn: fetchFeedback,
    staleTime: 60_000,
  })
}

// Mutation that sets a signal (or clears it when null). Optimistic
// update against the feedback cache; mirror on the suggestions cache
// for instant red-removes-the-card UX (the dislike + household-veto
// roll-up happens server-side; the cache mirror reproduces the visible
// effect immediately).
export function useSetFeedback(kind: FeedbackKind) {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (vars: { tmdbId: number; title: string; signal: FeedbackSignal | null }) => {
      if (vars.signal === null) {
        // Clearing — need to know which signal was set so the URL is
        // correct. The cached feedback tells us; default to dislike
        // (the more important one to clean up since it also affects
        // the household rejection list).
        const fb = qc.getQueryData<FeedbackResponse>(['feedback'])
        const liked = fb?.[kind].liked.some((e) => e.id === vars.tmdbId) ?? false
        const signal: FeedbackSignal = liked ? 'like' : 'dislike'
        const r = await fetch(
          apiUrl(`/api/feedback/${kind}/${vars.tmdbId}/${signal}`),
          { method: 'DELETE', credentials: 'include' },
        )
        if (!r.ok) throw new Error(`clear failed: ${r.status}`)
        return
      }
      const r = await fetch(apiUrl('/api/feedback'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: kind,
          tmdbId: vars.tmdbId,
          title: vars.title,
          signal: vars.signal,
        }),
      })
      if (!r.ok) throw new Error(`set failed: ${r.status}`)
    },
    onMutate: async ({ tmdbId, title, signal }) => {
      await qc.cancelQueries({ queryKey: ['feedback'] })
      const prev = qc.getQueryData<FeedbackResponse>(['feedback'])
      if (prev) {
        const bucket = prev[kind]
        const liked = bucket.liked.filter((e) => e.id !== tmdbId)
        const disliked = bucket.disliked.filter((e) => e.id !== tmdbId)
        if (signal === 'like') liked.push({ id: tmdbId, title })
        if (signal === 'dislike') disliked.push({ id: tmdbId, title })
        qc.setQueryData<FeedbackResponse>(['feedback'], {
          ...prev,
          [kind]: { liked, disliked },
        })
      }

      // When the user dislikes something, hide it from the suggestion
      // strip immediately (server will also bake it into household
      // rejections so next refetch wouldn't return it anyway).
      //
      // Query keys are ['suggestions', kind, mode, keyFingerprint] —
      // we discover all live entries via the prefix match rather than
      // hardcoding the fingerprint (which would couple this mutation
      // to useUserApiKey and miss any stale entries left over from a
      // previous key). This patches every matching cache entry so the
      // optimistic update applies regardless of which key is active.
      let suggestionsSnapshot: Array<{
        key: readonly unknown[]
        prev: unknown
      }> = []
      if (signal === 'dislike') {
        await qc.cancelQueries({ queryKey: ['suggestions', kind] })
        const entries = qc.getQueryCache().findAll({ queryKey: ['suggestions', kind] })
        suggestionsSnapshot = entries.map((entry) => ({
          key: entry.queryKey,
          prev: entry.state.data,
        }))
        for (const { key, prev } of suggestionsSnapshot) {
          const snap = prev as { items?: Array<{ id: number }> } | undefined
          if (snap && Array.isArray(snap.items)) {
            qc.setQueryData(key, {
              ...snap,
              items: snap.items.filter((i) => i.id !== tmdbId),
            })
          }
        }
      }
      return { prev, suggestionsSnapshot }
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['feedback'], ctx.prev)
      for (const { key, prev } of ctx?.suggestionsSnapshot ?? []) {
        if (prev) qc.setQueryData(key, prev)
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['feedback'] })
      // Critical: also invalidate the suggestions cache so Claude (or
      // TMDB trending) is re-asked with the updated reject/like state.
      // Without this, dots just optimistically shrink the local list
      // forever and the user can't tell the signal landed — the model
      // never gets the chance to react. Triggers a fresh ~15s Claude
      // call if AI is on; that's the right tradeoff — the alternative
      // is the strip slowly running dry as more items are dismissed.
      qc.invalidateQueries({ queryKey: ['suggestions', kind] })
    },
  })
}
