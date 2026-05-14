import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'feedback-'))
  path = join(tmpRoot, 'feedback.json')
  _setUserFeedbackPathForTests(path)
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('user feedback store', () => {
  it('returns empty bucket for unknown sub', async () => {
    expect(await getUserFeedback('nobody')).toEqual({
      movie: { liked: [], disliked: [] },
      tv: { liked: [], disliked: [] },
    })
  })

  it('records a like and persists', async () => {
    await setLike('alice', 'movie', 42)
    expect((await getUserFeedback('alice')).movie.liked).toContain(42)

    // Reload from disk
    _setUserFeedbackPathForTests(path)
    expect((await getUserFeedback('alice')).movie.liked).toContain(42)
  })

  it('records a dislike and persists', async () => {
    await setDislike('alice', 'tv', 99)
    expect((await getUserFeedback('alice')).tv.disliked).toContain(99)
  })

  it('setLike clears an existing dislike (mutually exclusive)', async () => {
    await setDislike('alice', 'movie', 7)
    await setLike('alice', 'movie', 7)
    const f = await getUserFeedback('alice')
    expect(f.movie.liked).toContain(7)
    expect(f.movie.disliked).not.toContain(7)
  })

  it('isolates users — bob is unaffected by alice', async () => {
    await setLike('alice', 'movie', 1)
    await setDislike('alice', 'movie', 2)
    expect((await getUserFeedback('bob')).movie.liked).toEqual([])
    expect((await getUserFeedback('bob')).movie.disliked).toEqual([])
  })

  it('clearFeedback removes both signals for the item', async () => {
    await setLike('alice', 'tv', 5)
    await clearFeedback('alice', 'tv', 5)
    expect((await getUserFeedback('alice')).tv.liked).not.toContain(5)
  })

  it('anotherUserDislikes returns true only when a different user disliked', async () => {
    await setDislike('alice', 'movie', 100)
    expect(await anotherUserDislikes('alice', 'movie', 100)).toBe(false)
    await setDislike('bob', 'movie', 100)
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

  it('serializes concurrent writes', async () => {
    await Promise.all([
      setLike('alice', 'movie', 1),
      setLike('alice', 'movie', 2),
      setLike('alice', 'movie', 3),
    ])
    expect((await getUserFeedback('alice')).movie.liked.sort()).toEqual([1, 2, 3])
  })
})
