import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getUserFeedback,
  setLike,
  setDislike,
  clearFeedback,
  anotherUserDislikes,
  _setUserFeedbackPathForTests,
} from './userFeedback.js'

let tmpRoot: string
let path: string

// Capture the real fs.writeFile ONCE before any test spies on it, so
// the write-failure tests can forward to a known-good implementation
// even if a stale spy reference somehow survives between tests.
const realWriteFile = fs.writeFile

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'feedback-'))
  path = join(tmpRoot, 'feedback.json')
  _setUserFeedbackPathForTests(path)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('user feedback store', () => {
  it('returns empty bucket for unknown sub', async () => {
    expect(await getUserFeedback('nobody')).toEqual({
      movie: { liked: [], disliked: [] },
      tv: { liked: [], disliked: [] },
    })
  })

  it('records a like with title and persists', async () => {
    await setLike('alice', 'movie', 42, 'The Substance')
    expect((await getUserFeedback('alice')).movie.liked).toContainEqual({
      id: 42,
      title: 'The Substance',
    })

    // Reload from disk
    _setUserFeedbackPathForTests(path)
    expect((await getUserFeedback('alice')).movie.liked).toContainEqual({
      id: 42,
      title: 'The Substance',
    })
  })

  it('records a dislike with title and persists', async () => {
    await setDislike('alice', 'tv', 99, 'Bad Show')
    expect((await getUserFeedback('alice')).tv.disliked).toContainEqual({
      id: 99,
      title: 'Bad Show',
    })
  })

  it('setLike clears an existing dislike and carries the title', async () => {
    await setDislike('alice', 'movie', 7, 'Mickey 17')
    await setLike('alice', 'movie', 7, 'Mickey 17')
    const f = await getUserFeedback('alice')
    expect(f.movie.liked).toContainEqual({ id: 7, title: 'Mickey 17' })
    expect(f.movie.disliked.find((e) => e.id === 7)).toBeUndefined()
  })

  it('preserves existing title when called with empty title', async () => {
    await setLike('alice', 'movie', 8, 'Conclave')
    await setDislike('alice', 'movie', 8, '')
    const f = await getUserFeedback('alice')
    expect(f.movie.disliked).toContainEqual({ id: 8, title: 'Conclave' })
  })

  it('isolates users — bob is unaffected by alice', async () => {
    await setLike('alice', 'movie', 1, 'A')
    await setDislike('alice', 'movie', 2, 'B')
    expect((await getUserFeedback('bob')).movie.liked).toEqual([])
    expect((await getUserFeedback('bob')).movie.disliked).toEqual([])
  })

  it('clearFeedback removes both signals for the item', async () => {
    await setLike('alice', 'tv', 5, 'X')
    await clearFeedback('alice', 'tv', 5)
    expect((await getUserFeedback('alice')).tv.liked.find((e) => e.id === 5)).toBeUndefined()
  })

  it('anotherUserDislikes returns true only when a different user disliked', async () => {
    await setDislike('alice', 'movie', 100, 'X')
    expect(await anotherUserDislikes('alice', 'movie', 100)).toBe(false)
    await setDislike('bob', 'movie', 100, 'X')
    expect(await anotherUserDislikes('alice', 'movie', 100)).toBe(true)
    expect(await anotherUserDislikes('bob', 'movie', 100)).toBe(true)
  })

  it('survives malformed file by starting fresh', async () => {
    await fs.writeFile(path, 'definitely not json')
    _setUserFeedbackPathForTests(path)
    expect(await getUserFeedback('alice')).toEqual({
      movie: { liked: [], disliked: [] },
      tv: { liked: [], disliked: [] },
    })
  })

  it('loads legacy bare-number entries and normalizes them', async () => {
    await fs.writeFile(
      path,
      JSON.stringify({
        alice: {
          movie: { liked: [10, 20], disliked: [30] },
          tv: { liked: [], disliked: [40] },
        },
      }),
    )
    _setUserFeedbackPathForTests(path)
    const f = await getUserFeedback('alice')
    expect(f.movie.liked).toEqual([
      { id: 10, title: '' },
      { id: 20, title: '' },
    ])
    expect(f.movie.disliked).toEqual([{ id: 30, title: '' }])
    expect(f.tv.disliked).toEqual([{ id: 40, title: '' }])
  })

  it('upgrades a legacy bare-number entry when re-clicked with a title', async () => {
    await fs.writeFile(
      path,
      JSON.stringify({
        alice: {
          movie: { liked: [10], disliked: [] },
          tv: { liked: [], disliked: [] },
        },
      }),
    )
    _setUserFeedbackPathForTests(path)
    await setLike('alice', 'movie', 10, 'Heat')
    expect((await getUserFeedback('alice')).movie.liked).toEqual([{ id: 10, title: 'Heat' }])
  })

  it('serializes concurrent writes', async () => {
    await Promise.all([
      setLike('alice', 'movie', 1, 'A'),
      setLike('alice', 'movie', 2, 'B'),
      setLike('alice', 'movie', 3, 'C'),
    ])
    expect(
      (await getUserFeedback('alice')).movie.liked.map((e) => e.id).sort(),
    ).toEqual([1, 2, 3])
  })

  it('writeFile failure rejects the awaited result (no UI lie)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(fs, 'writeFile').mockImplementationOnce(() =>
      Promise.reject(new Error('ENOSPC')),
    )

    // First write's persist fails — the caller's `await` MUST see the
    // rejection so the route can return 500 instead of `{ ok: true }`.
    // This is the regression fix: previously the .catch swallowed it
    // and the route lied to the UI about success.
    await expect(setLike('alice', 'movie', 1, 'A')).rejects.toThrow('ENOSPC')
  })

  it('queue stays alive after a failed write (recovery branch)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(fs, 'writeFile').mockImplementationOnce(() =>
      Promise.reject(new Error('ENOSPC')),
    )

    // First write rejects (real failure surfaces to caller).
    await expect(setLike('alice', 'movie', 1, 'A')).rejects.toThrow('ENOSPC')

    // Second write must still resolve — the recovery branch
    // (`writeQueue = op.catch(...)`) kept the chain alive.
    // (No mock for this call, so the real writeFile runs.)
    await expect(setLike('alice', 'movie', 2, 'B')).resolves.toBeUndefined()

    // Reload from disk to confirm the second write actually persisted.
    _setUserFeedbackPathForTests(path)
    const f = await getUserFeedback('alice')
    // id 1's persist failed, but id 1 was mutated into the in-memory
    // cache before persist ran — so when id 2's persist succeeded, it
    // wrote the cumulative {1, 2}. The load point: id 2 reached disk
    // at all, proving the queue wasn't poisoned.
    expect(f.movie.liked.map((e) => e.id).sort()).toEqual([1, 2])
  })

  it('concurrent writes — failed ones reject, others succeed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let call = 0
    vi.spyOn(fs, 'writeFile').mockImplementation(((
      ...args: Parameters<typeof realWriteFile>
    ) => {
      call += 1
      if (call === 2) return Promise.reject(new Error('transient EIO'))
      return realWriteFile(...args)
    }) as typeof fs.writeFile)

    // Five concurrent writes; the 2nd persist rejects. Use allSettled
    // so we can inspect each promise individually — the 2nd op MUST
    // reject (surfacing the failure to its caller), the other four
    // MUST fulfill (recovery branch kept the chain alive).
    const results = await Promise.allSettled([
      setLike('alice', 'movie', 1, 'A'),
      setLike('alice', 'movie', 2, 'B'),
      setLike('alice', 'movie', 3, 'C'),
      setLike('alice', 'movie', 4, 'D'),
      setLike('alice', 'movie', 5, 'E'),
    ])
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ])
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({
      message: 'transient EIO',
    })

    _setUserFeedbackPathForTests(path)
    const f = await getUserFeedback('alice')
    const ids = f.movie.liked.map((e) => e.id).sort()
    // All 5 ids end up on disk: the cache was mutated before persist
    // failed, and the next successful persist wrote the cumulative
    // cache. This in-memory-cache-vs-persist ordering is a known
    // subtlety — the awaited op correctly rejected, but the cache was
    // already dirty.
    expect(ids).toEqual([1, 2, 3, 4, 5])
  })
})
