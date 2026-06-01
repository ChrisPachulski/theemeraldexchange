import { describe, expect, it, vi } from 'vitest'
import { runOptimisticMutation } from './useOptimisticMutation'

// vitest runs in the `node` environment for this repo — there is NO jsdom, NO
// @testing-library, and NO react-test-renderer installed. The React-primitive
// wiring inside useOptimisticMutation (useOptimistic / useTransition) is
// therefore un-renderable here: we cannot mount the hook or drive the real
// transition. Following the established idiom (see SourceToggle.test.tsx), the
// run-orchestration was extracted into the pure, dependency-injected helper
// `runOptimisticMutation`, which we pin below. The hook's `run` callback is a
// one-line delegation to this helper, so if the helper is correct the hook is
// correct by construction; only the bare primitive wiring stays untested.
//
// `startTransition` is faked to synchronously invoke its scope callback. Because
// the scope is async, we capture the returned promise so each test can await the
// transition's full settling before asserting.

describe('runOptimisticMutation', () => {
  // Build a fake startTransition that runs the scope immediately and exposes the
  // scope's promise so tests can await the (async) transition body to completion.
  function makeFakeTransition() {
    let scopePromise: Promise<void> | undefined
    const startTransition = vi.fn((scope: () => void | Promise<void>) => {
      scopePromise = Promise.resolve(scope())
    })
    return {
      startTransition,
      // Awaiting this resolves once the async scope (apply + await action) settles.
      settle: () => scopePromise as Promise<void>,
    }
  }

  it('applies the optimistic patch before awaiting the action', async () => {
    const applyOptimistic = vi.fn()
    let resolveAction: () => void = () => {}
    const action = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAction = resolve
        }),
    )
    const { startTransition, settle } = makeFakeTransition()

    runOptimisticMutation(applyOptimistic, startTransition, true, action)

    // The patch must be applied synchronously as the scope starts, while the
    // action's promise is still pending (not yet resolved).
    expect(applyOptimistic).toHaveBeenCalledTimes(1)
    expect(applyOptimistic).toHaveBeenCalledWith(true)
    expect(action).toHaveBeenCalledTimes(1)
    // Call-order proof: applyOptimistic ran before action was invoked.
    expect(applyOptimistic.mock.invocationCallOrder[0]).toBeLessThan(
      action.mock.invocationCallOrder[0],
    )

    resolveAction()
    await settle()
  })

  it('passes the patch through to applyOptimistic unchanged', async () => {
    const patch = { id: 42, paused: true, nested: { tag: 'x' } }
    const applyOptimistic = vi.fn()
    const action = vi.fn(async () => undefined)
    const { startTransition, settle } = makeFakeTransition()

    runOptimisticMutation(applyOptimistic, startTransition, patch, action)
    await settle()

    expect(applyOptimistic).toHaveBeenCalledTimes(1)
    // Reference equality: the exact object is forwarded, not a copy/clone.
    expect(applyOptimistic.mock.calls[0][0]).toBe(patch)
    expect(applyOptimistic.mock.calls[0][0]).toEqual({
      id: 42,
      paused: true,
      nested: { tag: 'x' },
    })
  })

  it('awaits the action inside the transition scope', async () => {
    const applyOptimistic = vi.fn()
    const action = vi.fn(async () => 'done')
    const { startTransition, settle } = makeFakeTransition()

    runOptimisticMutation(applyOptimistic, startTransition, false, action)
    await settle()

    expect(action).toHaveBeenCalledTimes(1)
  })

  it('swallows a rejected action so no rejection escapes', async () => {
    const applyOptimistic = vi.fn()
    const action = vi.fn(() => Promise.reject(new Error('boom')))
    const { startTransition, settle } = makeFakeTransition()

    runOptimisticMutation(applyOptimistic, startTransition, true, action)

    // The transition settles cleanly (resolves) even though the action rejected,
    // and the optimistic layer was still applied (revert is React's job).
    await expect(settle()).resolves.toBeUndefined()
    expect(applyOptimistic).toHaveBeenCalledTimes(1)
    expect(applyOptimistic).toHaveBeenCalledWith(true)
  })

  it('swallows a synchronously-thrown action', async () => {
    const applyOptimistic = vi.fn()
    const action = vi.fn(() => {
      throw new Error('sync')
    })
    const { startTransition, settle } = makeFakeTransition()

    // The throw must not propagate out of runOptimisticMutation itself.
    expect(() =>
      runOptimisticMutation(applyOptimistic, startTransition, true, action),
    ).not.toThrow()

    await expect(settle()).resolves.toBeUndefined()
    expect(applyOptimistic).toHaveBeenCalledTimes(1)
  })

  it('supports a synchronous (non-promise) action result', async () => {
    const applyOptimistic = vi.fn()
    const action = vi.fn(() => 'plain-value')
    const { startTransition, settle } = makeFakeTransition()

    runOptimisticMutation(applyOptimistic, startTransition, false, action)

    await expect(settle()).resolves.toBeUndefined()
    expect(action).toHaveBeenCalledTimes(1)
    expect(applyOptimistic).toHaveBeenCalledTimes(1)
    expect(applyOptimistic).toHaveBeenCalledWith(false)
  })

  it('invokes startTransition exactly once per run', async () => {
    const applyOptimistic = vi.fn()
    const action = vi.fn(async () => undefined)
    const { startTransition, settle } = makeFakeTransition()

    runOptimisticMutation(applyOptimistic, startTransition, true, action)
    await settle()

    expect(startTransition).toHaveBeenCalledTimes(1)
  })
})
