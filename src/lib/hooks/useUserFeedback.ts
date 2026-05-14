import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiUrl } from '../api/base'

// Per-user red/green feedback for the dots under each suggestion card.
// Red (dislike) writes to BOTH the user's private dislike list AND the
// household rejection list — server side. Green (like) writes only to
// the per-user list (private positive signal to Claude).
//
// The hook tracks which dot is set for each TMDB id so the dots
// component can render the current state and toggle correctly.

export type FeedbackKind = 'movie' | 'tv'
export type FeedbackSignal = 'like' | 'dislike'

type FeedbackResponse = {
  movie: { liked: number[]; disliked: number[] }
  tv: { liked: number[]; disliked: number[] }
}

async function fetchFeedback(): Promise<FeedbackResponse> {
  const r = await fetch(apiUrl('/api/feedback'), { credentials: 'include' })
  if (!r.ok) {
    return { movie: { liked: [], disliked: [] }, tv: { liked: [], disliked: [] } }
  }
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
    mutationFn: async (vars: { tmdbId: number; signal: FeedbackSignal | null }) => {
      if (vars.signal === null) {
        // Clearing — need to know which signal was set so the URL is
        // correct. The cached feedback tells us; default to dislike
        // (the more important one to clean up since it also affects
        // the household rejection list).
        const fb = qc.getQueryData<FeedbackResponse>(['feedback'])
        const liked = fb?.[kind].liked.includes(vars.tmdbId)
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
        body: JSON.stringify({ type: kind, tmdbId: vars.tmdbId, signal: vars.signal }),
      })
      if (!r.ok) throw new Error(`set failed: ${r.status}`)
    },
    onMutate: async ({ tmdbId, signal }) => {
      await qc.cancelQueries({ queryKey: ['feedback'] })
      const prev = qc.getQueryData<FeedbackResponse>(['feedback'])
      if (prev) {
        const bucket = prev[kind]
        const liked = bucket.liked.filter((id) => id !== tmdbId)
        const disliked = bucket.disliked.filter((id) => id !== tmdbId)
        if (signal === 'like') liked.push(tmdbId)
        if (signal === 'dislike') disliked.push(tmdbId)
        qc.setQueryData<FeedbackResponse>(['feedback'], {
          ...prev,
          [kind]: { liked, disliked },
        })
      }

      // When the user dislikes something, hide it from the suggestion
      // strip immediately (server will also bake it into household
      // rejections so next refetch wouldn't return it anyway).
      let suggestionsSnapshot: Array<{
        key: readonly [string, FeedbackKind, string]
        prev: unknown
      }> = []
      if (signal === 'dislike') {
        await qc.cancelQueries({ queryKey: ['suggestions', kind] })
        const variants = [
          ['suggestions', kind, 'ai'] as const,
          ['suggestions', kind, 'trending'] as const,
        ]
        suggestionsSnapshot = variants.map((key) => ({
          key,
          prev: qc.getQueryData(key),
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
    },
  })
}
