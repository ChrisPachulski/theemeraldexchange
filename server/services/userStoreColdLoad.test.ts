// 2026-10-16 review item 28: on a cold cache, a read whose disk read started
// before a write's rename resolved after it and put the pre-write file back in
// the cache, so later reads (and the next write) lost the write.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _setUserPoliciesPathForTests, defaultPolicy, getPolicy, setPolicy } from './userPolicies.js'
import { _setUserFeedbackPathForTests, getUserFeedback, setLike } from './userFeedback.js'
import { _setUserWatchlistPathForTests, getWatchlist, upsertWatchlist } from './userWatchlist.js'

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'cold-load-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

// Hold the FIRST disk read until released; later reads pass straight through.
function holdFirstRead(): () => void {
  const real = fs.readFile.bind(fs)
  let release!: () => void
  const gate = new Promise<void>((ok) => (release = ok))
  let first = true
  vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    const out = await real(...args)
    if (first) {
      first = false
      await gate
    }
    return out
  }) as typeof fs.readFile)
  return release
}

async function race<T>(file: string, read: () => Promise<T>, write: () => Promise<void>): Promise<void> {
  await fs.writeFile(file, '{}\n')
  const release = holdFirstRead()
  const pendingRead = read()
  const pendingWrite = write()
  await new Promise((r) => setTimeout(r, 50))
  release()
  await Promise.all([pendingRead, pendingWrite])
}

describe('cold-cache read racing a write', () => {
  it('userPolicies keeps the write', async () => {
    const file = join(tmpRoot, 'policies.json')
    _setUserPoliciesPathForTests(file)
    const kid = { ...defaultPolicy(), kid: true }
    await race(file, () => getPolicy('plex:1'), () => setPolicy('plex:1', kid))
    expect(await getPolicy('plex:1')).toEqual(kid)
  })

  it('userFeedback keeps the write', async () => {
    const file = join(tmpRoot, 'feedback.json')
    _setUserFeedbackPathForTests(file)
    await race(file, () => getUserFeedback('plex:1'), () => setLike('plex:1', 'movie', 603, 'The Matrix'))
    expect((await getUserFeedback('plex:1')).movie.liked.map((e) => e.id)).toEqual([603])
  })

  it('userWatchlist keeps the write', async () => {
    const file = join(tmpRoot, 'watchlist.json')
    _setUserWatchlistPathForTests(file)
    await race(file, () => getWatchlist('plex:1'), () => upsertWatchlist('plex:1', 'movie', { id: 603, title: 'The Matrix' }))
    expect((await getWatchlist('plex:1')).movie?.map((e) => e.id)).toEqual([603])
  })
})
