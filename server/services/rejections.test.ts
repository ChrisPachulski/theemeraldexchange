import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getRejections,
  getRejectionIds,
  addRejection,
  removeRejection,
  _setRejectionsPathForTests,
} from './rejections.js'

let tmpRoot: string
let path: string

// Capture the real fs.writeFile ONCE before any test spies on it, so
// the write-failure tests can forward to a known-good implementation
// even if a stale spy reference somehow survives between tests.
const realWriteFile = fs.writeFile

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'rejections-'))
  path = join(tmpRoot, 'rejections.json')
  _setRejectionsPathForTests(path)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('rejections store', () => {
  it('returns empty when file is missing', async () => {
    expect(await getRejections()).toEqual({ movie: [], tv: [] })
  })

  it('adds and persists titled rejections', async () => {
    await addRejection('movie', 1234, 'The Substance')
    await addRejection('tv', 5678, 'Severance')
    const got = await getRejections()
    expect(got.movie).toContainEqual({ id: 1234, title: 'The Substance' })
    expect(got.tv).toContainEqual({ id: 5678, title: 'Severance' })

    // Re-read from disk to confirm persistence
    _setRejectionsPathForTests(path)
    const reloaded = await getRejections()
    expect(reloaded.movie).toContainEqual({ id: 1234, title: 'The Substance' })
    expect(reloaded.tv).toContainEqual({ id: 5678, title: 'Severance' })
  })

  it('is idempotent — adding twice leaves one entry', async () => {
    await addRejection('movie', 42, 'X')
    await addRejection('movie', 42, 'X')
    const got = await getRejections()
    expect(got.movie.filter((e) => e.id === 42)).toHaveLength(1)
  })

  it('upgrades title in place when a known id re-rejected with a title', async () => {
    await addRejection('movie', 42, '')
    await addRejection('movie', 42, 'The Lighthouse')
    const got = await getRejections()
    expect(got.movie).toEqual([{ id: 42, title: 'The Lighthouse' }])
  })

  it('does not overwrite a known title with an empty one', async () => {
    await addRejection('movie', 42, 'Mickey 17')
    await addRejection('movie', 42, '')
    const got = await getRejections()
    expect(got.movie).toEqual([{ id: 42, title: 'Mickey 17' }])
  })

  it('removes a rejection', async () => {
    await addRejection('movie', 99, 'Bad Movie')
    await removeRejection('movie', 99)
    const got = await getRejections()
    expect(got.movie).not.toContainEqual({ id: 99, title: 'Bad Movie' })
  })

  it('survives malformed file by starting fresh', async () => {
    await fs.writeFile(path, 'not json at all')
    _setRejectionsPathForTests(path)
    expect(await getRejections()).toEqual({ movie: [], tv: [] })
    // Subsequent writes succeed
    await addRejection('tv', 1, 'Pilot')
    expect((await getRejections()).tv).toContainEqual({ id: 1, title: 'Pilot' })
  })

  it('loads legacy bare-number files and normalizes to titled entries', async () => {
    await fs.writeFile(
      path,
      JSON.stringify({ movie: [10, 20, 30], tv: [40] }),
    )
    _setRejectionsPathForTests(path)
    const got = await getRejections()
    expect(got.movie).toEqual([
      { id: 10, title: '' },
      { id: 20, title: '' },
      { id: 30, title: '' },
    ])
    expect(got.tv).toEqual([{ id: 40, title: '' }])
  })

  it('upgrades a legacy bare-number entry when the same id is re-rejected with a title', async () => {
    await fs.writeFile(path, JSON.stringify({ movie: [10], tv: [] }))
    _setRejectionsPathForTests(path)
    await addRejection('movie', 10, 'Megalopolis')
    const got = await getRejections()
    expect(got.movie).toEqual([{ id: 10, title: 'Megalopolis' }])
  })

  it('getRejectionIds returns a Set of just the ids', async () => {
    await addRejection('movie', 1, 'A')
    await addRejection('movie', 2, 'B')
    const ids = await getRejectionIds('movie')
    expect(ids.has(1)).toBe(true)
    expect(ids.has(2)).toBe(true)
    expect(ids.size).toBe(2)
  })

  it('serializes concurrent writes', async () => {
    await Promise.all([
      addRejection('movie', 1, 'A'),
      addRejection('movie', 2, 'B'),
      addRejection('movie', 3, 'C'),
      addRejection('movie', 4, 'D'),
    ])
    const got = await getRejections()
    expect(got.movie.map((e) => e.id).sort()).toEqual([1, 2, 3, 4])
  })

  it('writeFile failure rejects the awaited result (no UI lie)', async () => {
    // Swallow the "[rejections] write failed" log so it doesn't
    // pollute test output.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(fs, 'writeFile').mockImplementationOnce(() =>
      Promise.reject(new Error('ENOSPC')),
    )

    // First write's persist fails — the caller's `await` MUST see the
    // rejection so the route can return 500 instead of `{ ok: true }`.
    // This is the regression fix: previously the .catch swallowed it
    // and the route lied to the UI about success.
    await expect(addRejection('movie', 1, 'A')).rejects.toThrow('ENOSPC')
  })

  it('queue stays alive after a failed write (recovery branch)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(fs, 'writeFile').mockImplementationOnce(() =>
      Promise.reject(new Error('ENOSPC')),
    )

    // First write rejects (real failure surfaces to caller).
    await expect(addRejection('movie', 1, 'A')).rejects.toThrow('ENOSPC')

    // Second write must still resolve: the recovery branch
    // (`writeQueue = op.catch(...)`) kept the chain alive.
    await expect(addRejection('movie', 2, 'B')).resolves.toBeUndefined()

    // Reload from disk to confirm the second write actually persisted.
    _setRejectionsPathForTests(path)
    const got = await getRejections()
    // id 1's persist failed, but id 1 was already mutated into the
    // in-memory cache BEFORE persist ran. When id 2's persist
    // succeeded, it wrote the cumulative {1, 2}. The load-bearing
    // claim: id 2 is on disk, proving the queue wasn't poisoned.
    expect(got.movie.map((e) => e.id).sort()).toEqual([1, 2])
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

    // Fire five concurrent writes; the 2nd persist will fail. Use
    // allSettled so we can inspect each promise individually — the
    // 2nd op MUST reject (surfacing the failure to its caller), the
    // other four MUST fulfill.
    const results = await Promise.allSettled([
      addRejection('movie', 1, 'A'),
      addRejection('movie', 2, 'B'),
      addRejection('movie', 3, 'C'),
      addRejection('movie', 4, 'D'),
      addRejection('movie', 5, 'E'),
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

    // Reload from disk so we don't read the cache.
    _setRejectionsPathForTests(path)
    const got = await getRejections()
    const ids = got.movie.map((e) => e.id).sort()
    // The 2nd persist rejected, but id 2's cache mutation happened
    // BEFORE persist (cache mutation order: load → push → persist).
    // Later writes serialize cumulative cache, so all 5 ids end up on
    // disk. This in-memory-cache-vs-persist ordering is a known
    // subtlety — the awaited op correctly rejected, but the cache was
    // already dirty.
    expect(ids).toEqual([1, 2, 3, 4, 5])
  })
})
