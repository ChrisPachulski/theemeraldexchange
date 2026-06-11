// @vitest-environment jsdom
//
// Mounted-hook tests for useSuggestionStrip — the shared Discover-strip
// orchestration extracted from the MoviesTab/TvTab twins. The collaborating
// hooks (suggestions query, limits, BYO key, feedback) are mocked at the
// module boundary so the tests pin exactly the orchestration this hook owns:
// library filtering + dedupe, label selection, mode-toggle gating, feedback
// dot wiring, and the stability of the refresh handler.
//
// NOTE the owner-mandated refresh semantics: this hook must never refetch on
// like/judgement/toggle — only the explicit refresh() may hit refetch. The
// "like does not refetch" test below is the regression guard for that rule.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSuggestionStrip } from './useSuggestionStrip'

const { suggestedMock, limitsMock, userApiKeyMock, feedbackMock, setFeedbackMutate, suggestionModeMock } =
  vi.hoisted(() => ({
    suggestedMock: vi.fn(),
    limitsMock: vi.fn(),
    userApiKeyMock: vi.fn(),
    feedbackMock: vi.fn(),
    setFeedbackMutate: vi.fn(),
    suggestionModeMock: vi.fn(),
  }))

vi.mock('./useSuggested', () => ({ useSuggested: suggestedMock }))
vi.mock('./useLimits', () => ({ useLimits: limitsMock }))
vi.mock('./useUserApiKey', () => ({ useUserApiKey: userApiKeyMock }))
vi.mock('./useUserFeedback', () => ({
  useFeedback: feedbackMock,
  useSetFeedback: () => ({ mutate: setFeedbackMutate }),
}))
vi.mock('./useSuggestionMode', () => ({ useSuggestionMode: suggestionModeMock }))

type Item = { id: number; title: string; posterPath: string | null; reason: string | null }
const item = (id: number, title: string): Item => ({ id, title, posterPath: null, reason: null })

function suggestedResult(over: Record<string, unknown> = {}) {
  return {
    data: { items: [], source: 'trending', diag: null },
    error: null,
    isPending: false,
    isFetching: false,
    refetch: vi.fn(),
    ...over,
  }
}

beforeEach(() => {
  suggestedMock.mockReturnValue(suggestedResult())
  limitsMock.mockReturnValue({ data: { useLocalRecommender: true } })
  userApiKeyMock.mockReturnValue({ hasKey: false, fingerprint: null, loading: false, setKey: vi.fn(), clearKey: vi.fn() })
  feedbackMock.mockReturnValue({ data: undefined, error: null })
  suggestionModeMock.mockReturnValue({ mode: 'recommended', setMode: vi.fn(), toggle: vi.fn() })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useSuggestionStrip — items', () => {
  it('filters out library overlap and dedupes by id', () => {
    suggestedMock.mockReturnValue(
      suggestedResult({
        data: {
          items: [item(1, 'In Library'), item(2, 'Fresh'), item(2, 'Fresh Dupe'), item(3, 'Also Fresh')],
          source: 'recommender',
          diag: null,
        },
      }),
    )
    const { result } = renderHook(() => useSuggestionStrip('movie', new Set([1])))
    expect(result.current.items.map((i) => i.id)).toEqual([2, 3])
  })
})

describe('useSuggestionStrip — label', () => {
  it('says "Picked for you" for personalized/recommender sources', () => {
    for (const source of ['personalized', 'personalized_filled', 'recommender']) {
      suggestedMock.mockReturnValue(suggestedResult({ data: { items: [], source, diag: null } }))
      const { result } = renderHook(() => useSuggestionStrip('tv', new Set()))
      expect(result.current.label).toBe('Picked for you')
    }
  })

  it('keeps the per-kind trending label for trending sources', () => {
    suggestedMock.mockReturnValue(suggestedResult({ data: { items: [], source: 'trending', diag: null } }))
    const movie = renderHook(() => useSuggestionStrip('movie', new Set()))
    expect(movie.result.current.label).toBe('Trending movies this week')
    const tv = renderHook(() => useSuggestionStrip('tv', new Set()))
    expect(tv.result.current.label).toBe('Trending this week')
  })
})

describe('useSuggestionStrip — personalization gating', () => {
  it('omits the mode toggle when personalization is not achievable', () => {
    limitsMock.mockReturnValue({ data: { useLocalRecommender: false } })
    userApiKeyMock.mockReturnValue({ hasKey: false, fingerprint: null, loading: false, setKey: vi.fn(), clearKey: vi.fn() })
    const { result } = renderHook(() => useSuggestionStrip('movie', new Set()))
    expect(result.current.mode).toBeUndefined()
    expect(result.current.personalizedAchievable).toBe(false)
  })

  it('exposes the mode toggle when the local recommender runs', () => {
    const setMode = vi.fn()
    suggestionModeMock.mockReturnValue({ mode: 'recommended', setMode, toggle: vi.fn() })
    const { result } = renderHook(() => useSuggestionStrip('movie', new Set()))
    expect(result.current.mode).toEqual({ value: 'recommended', onChange: setMode })
  })

  it('forces trending when the user explicitly picked Trending', () => {
    suggestionModeMock.mockReturnValue({ mode: 'trending', setMode: vi.fn(), toggle: vi.fn() })
    renderHook(() => useSuggestionStrip('movie', new Set()))
    expect(suggestedMock).toHaveBeenCalledWith('movie', true, null)
  })
})

describe('useSuggestionStrip — refresh', () => {
  it('refresh() hits refetch and keeps a stable identity across rerenders', () => {
    const refetch = vi.fn().mockResolvedValue(undefined)
    suggestedMock.mockReturnValue(suggestedResult({ refetch }))
    const { result, rerender } = renderHook(() => useSuggestionStrip('movie', new Set()))
    const first = result.current.refresh
    rerender()
    expect(result.current.refresh).toBe(first)
    act(() => result.current.refresh())
    expect(refetch).toHaveBeenCalledTimes(1)
  })
})

describe('useSuggestionStrip — feedback dots', () => {
  const fb = {
    movie: { liked: [{ id: 10 }], disliked: [{ id: 20 }] },
    tv: { liked: [], disliked: [] },
  }

  it('stateFor reflects the per-kind feedback store', () => {
    feedbackMock.mockReturnValue({ data: fb, error: null })
    const { result } = renderHook(() => useSuggestionStrip('movie', new Set()))
    expect(result.current.feedback.stateFor(10)).toBe('liked')
    expect(result.current.feedback.stateFor(20)).toBe('disliked')
    expect(result.current.feedback.stateFor(30)).toBe('unset')
  })

  it('onLike toggles: unset -> like, liked -> null (undo)', () => {
    feedbackMock.mockReturnValue({ data: fb, error: null })
    const { result } = renderHook(() => useSuggestionStrip('movie', new Set()))
    result.current.feedback.onLike(30, 'Fresh Pick')
    expect(setFeedbackMutate).toHaveBeenCalledWith({ tmdbId: 30, title: 'Fresh Pick', signal: 'like' })
    result.current.feedback.onLike(10, 'Already Liked')
    expect(setFeedbackMutate).toHaveBeenCalledWith({ tmdbId: 10, title: 'Already Liked', signal: null })
  })

  it('onDislike toggles: unset -> dislike, disliked -> null (undo)', () => {
    feedbackMock.mockReturnValue({ data: fb, error: null })
    const { result } = renderHook(() => useSuggestionStrip('movie', new Set()))
    result.current.feedback.onDislike(30, 'Fresh Pick')
    expect(setFeedbackMutate).toHaveBeenCalledWith({ tmdbId: 30, title: 'Fresh Pick', signal: 'dislike' })
    result.current.feedback.onDislike(20, 'Already Disliked')
    expect(setFeedbackMutate).toHaveBeenCalledWith({ tmdbId: 20, title: 'Already Disliked', signal: null })
  })

  it('a like never refetches the strip (owner-mandated stability rule)', () => {
    const refetch = vi.fn()
    suggestedMock.mockReturnValue(suggestedResult({ refetch }))
    feedbackMock.mockReturnValue({ data: fb, error: null })
    const { result } = renderHook(() => useSuggestionStrip('movie', new Set()))
    result.current.feedback.onLike(30, 'Fresh Pick')
    result.current.feedback.onDislike(31, 'Other Pick')
    expect(refetch).not.toHaveBeenCalled()
  })

  it('marks dots unavailable when the feedback store is unreachable', () => {
    feedbackMock.mockReturnValue({ data: undefined, error: new Error('boom') })
    const { result } = renderHook(() => useSuggestionStrip('movie', new Set()))
    expect(result.current.feedback.unavailable).toBe(true)
  })
})
