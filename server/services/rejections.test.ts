import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getRejections,
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

  it('adds and persists a rejection', async () => {
    await addRejection('movie', 1234)
    await addRejection('tv', 5678)
    const got = await getRejections()
    expect(got.movie).toContain(1234)
    expect(got.tv).toContain(5678)

    // Re-read from disk to confirm persistence
    _setRejectionsPathForTests(path)
    const reloaded = await getRejections()
    expect(reloaded.movie).toContain(1234)
    expect(reloaded.tv).toContain(5678)
  })

  it('is idempotent — adding twice leaves one entry', async () => {
    await addRejection('movie', 42)
    await addRejection('movie', 42)
    const got = await getRejections()
    expect(got.movie.filter((id) => id === 42)).toHaveLength(1)
  })

  it('removes a rejection', async () => {
    await addRejection('movie', 99)
    await removeRejection('movie', 99)
    const got = await getRejections()
    expect(got.movie).not.toContain(99)
  })

  it('survives malformed file by starting fresh', async () => {
    await fs.writeFile(path, 'not json at all')
    _setRejectionsPathForTests(path)
    expect(await getRejections()).toEqual({ movie: [], tv: [] })
    // Subsequent writes succeed
    await addRejection('tv', 1)
    expect((await getRejections()).tv).toContain(1)
  })

  it('serializes concurrent writes', async () => {
    await Promise.all([
      addRejection('movie', 1),
      addRejection('movie', 2),
      addRejection('movie', 3),
      addRejection('movie', 4),
    ])
    const got = await getRejections()
    expect(got.movie.sort()).toEqual([1, 2, 3, 4])
  })
})
