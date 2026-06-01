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

async function fetchFeedback(): Promise<FeedbackResponse> {
  const r = await fetch(apiUrl('/api/feedback'), { credentials: 'include' })
  if (!r.ok) {
    // Throw so React Query exposes isError/error to the caller. Used
    // to return EMPTY, which hid backend 500s (e.g. the fail-closed
    // corrupted-store path) as "no dots set" — operators couldn't
    // tell the difference between a fresh user and a broken store.
    // Consumers that don't care about errors fall back to `data ??`
    // and render no dots, same UX as before.
    const body = await r.text().catch(() => '')
    throw new Error(`feedback ${r.status}: ${body.slice(0, 200)}`)
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
    onSettled: (_data, _err, variables) => {
      qc.invalidateQueries({ queryKey: ['feedback'] })
      // Do NOT reflexively re-ask the model on every dot click.
      // Invalidating ['suggestions'] here refetches the whole strip and
      // replaces the lineup, so a single yes/no destroys any in-progress
      // triage — the user can't keep marking the other cards they were
      // eyeing (the original complaint). The signal is already persisted
      // server-side and the optimistic cache update above reflects the
      // click instantly, so the strip stays stable across a batch of
      // yes/no calls. The new reject/like state is picked up on the next
      // natural refetch (mount / tab revisit / manual refresh).
      //
      // Only a DISLIKE removes a card (the onMutate optimistic filter
      // above), so only a dislike can drain the strip toward empty. Likes
      // and clears leave the lineup length untouched, so they must never
      // reach the low-water check — otherwise a single green dot refetches
      // the whole strip whenever the visible list already sits at/under the
      // mark (a short strip = every like reshuffles, the reported bug).
      // Gate the lazy refill on dislikes only.
      if (variables.signal !== 'dislike') return
      const LOW_WATER_MARK = 5
      const entries = qc.getQueryCache().findAll({ queryKey: ['suggestions', kind] })
      let lowest = Infinity
      for (const entry of entries) {
        const data = entry.state.data as { items?: unknown[] } | undefined
        if (data && Array.isArray(data.items)) {
          lowest = Math.min(lowest, data.items.length)
        }
      }
      if (lowest <= LOW_WATER_MARK) {
        qc.invalidateQueries({ queryKey: ['suggestions', kind] })
      }
    },
  })
}
