import { useCallback, useOptimistic, useTransition } from 'react'

// React 19 optimistic-mutation wrapper (spec P0.5).
//
// The highest-frequency writes in this tool — toggle a feedback dot, pause /
// resume / cancel a download — already persist through React Query mutations
// that own the server round-trip and the cache reconciliation. This hook does
// NOT replace any of that. It sits one layer closer to the tap: it flips the
// *local* visual state the instant the user presses, then hands off to the
// real mutation. If that mutation rejects, React rolls the optimistic value
// back automatically once the surrounding transition settles, so the row
// snaps back to truth with no manual onError bookkeeping in the component.
//
// Mechanics:
//   - `useOptimistic(base, reducer)` layers an optimistic value on top of the
//     committed `base`. While a transition is pending it shows the reduced
//     value; when the transition ends React discards the layer and re-derives
//     from `base` (now the post-mutation truth, or the unchanged pre-mutation
//     value on failure → automatic revert).
//   - `useTransition` provides the `pending` flag used to (a) disable
//     double-submits and (b) drive the `--text-subtle` styling while the write
//     is in flight. We mirror `useActionState`'s pending semantics with the
//     lower-level primitive because these callers expose imperative `mutate`
//     handlers (React Query), not form actions.
//
// `run(patch, action)`:
//   - `patch` is the optimistic value to show immediately (passed to the
//     reducer as its second arg).
//   - `action` is the async write. It is awaited inside the transition so the
//     optimistic layer stays applied for its full duration and is torn down
//     (commit or revert) exactly when it resolves / rejects.
//
// Reduced-motion: there is no motion here to gate — the only visual delta is a
// token color/opacity swap (`--text` → `--text-subtle`), which is inert under
// `prefers-reduced-motion: reduce`. Nothing to feature-detect; `useOptimistic`
// is a core React 19 hook the rest of the stack already depends on.

export type OptimisticReducer<TState, TPatch> = (current: TState, patch: TPatch) => TState

export type OptimisticMutation<TState, TPatch> = {
  /** Optimistic value while a write is pending, committed value otherwise. */
  value: TState
  /** True from tap until the underlying mutation settles. Block re-taps with this. */
  pending: boolean
  /**
   * Apply `patch` optimistically, then await `action`. On rejection React
   * auto-reverts to `base`. Rejections are swallowed here because the
   * underlying React Query mutation owns error surfacing / rollback of the
   * shared cache; this wrapper only owns the instant-local-feedback layer.
   */
  run: (patch: TPatch, action: () => Promise<unknown> | unknown) => void
}

/**
 * Pure, framework-agnostic run orchestration extracted from the hook so it can
 * be unit-tested in the `node` environment (no jsdom / @testing-library).
 *
 * The two React primitives are INJECTED:
 *   - `applyOptimistic` is `useOptimistic`'s dispatch (apply the patch).
 *   - `startTransition` is `useTransition`'s starter (mark the work pending).
 *
 * Behavior: apply the patch optimistically, then await `action` INSIDE the
 * transition so the optimistic layer stays applied for the action's full
 * duration and is torn down (commit or revert) exactly when it settles.
 */
export function runOptimisticMutation<TPatch>(
  applyOptimistic: (patch: TPatch) => void,
  startTransition: (scope: () => void | Promise<void>) => void,
  patch: TPatch,
  action: () => Promise<unknown> | unknown,
): void {
  startTransition(async () => {
    applyOptimistic(patch)
    try {
      await action()
    } catch {
      // Intentional: the optimistic layer is discarded when this
      // transition settles, so a throw reverts `value` back to `base`.
      // The owning React Query mutation is responsible for toasts /
      // retries / cache rollback — re-throwing here would only surface
      // an unhandled rejection without changing the visible outcome.
    }
  })
}

export function useOptimisticMutation<TState, TPatch = TState>(
  base: TState,
  reducer: OptimisticReducer<TState, TPatch>,
): OptimisticMutation<TState, TPatch> {
  const [value, applyOptimistic] = useOptimistic(base, reducer)
  const [pending, startTransition] = useTransition()

  const run = useCallback(
    (patch: TPatch, action: () => Promise<unknown> | unknown) => {
      runOptimisticMutation(applyOptimistic, startTransition, patch, action)
    },
    [applyOptimistic],
  )

  return { value, pending, run }
}
