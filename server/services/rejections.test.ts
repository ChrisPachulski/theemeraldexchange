import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'rejections-'))
  path = join(tmpRoot, 'rejections.json')
  _setRejectionsPathForTests(path)
})

afterEach(async () => {
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
})
