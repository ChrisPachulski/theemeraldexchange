import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { syncplay } from './syncplay.js'
import { createSession } from '../session.js'
import { _resetSyncplayForTests } from '../services/syncplay.js'
import type { Env } from '../middleware/auth.js'

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', syncplay)
  return app
}

async function cookieFor(sub: 'alice' | 'bob') {
  const numericSub = sub === 'alice' ? 'plex:1' : 'plex:2'
  const t = await createSession({ sub: numericSub, username: `user-${sub}`, role: 'user' })
  return `eex.session=${t}`
}

function post(app: ReturnType<typeof appUnderTest>, cookie: string, path: string, body?: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

type Snapshot = {
  id: string
  media_kind: string
  media_id: number
  paused: boolean
  position_secs: number
  version: number
  members: { sub: string; username: string }[]
}

beforeEach(() => {
  _resetSyncplayForTests()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-01T12:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('syncplay groups', () => {
  it('creates a group, joins, and keeps members in lockstep', async () => {
    const app = appUnderTest()
    const alice = await cookieFor('alice')
    const bob = await cookieFor('bob')

    const created = await post(app, alice, '/groups', { media_kind: 'movie', media_id: 7 })
    expect(created.status).toBe(200)
    const g = (await created.json()) as Snapshot
    expect(g.paused).toBe(true)
    expect(g.members).toHaveLength(1)

    const joined = await post(app, bob, `/groups/${g.id}/join`)
    expect(joined.status).toBe(200)
    expect(((await joined.json()) as Snapshot).members).toHaveLength(2)

    // Alice starts playback at her playhead (30s in).
    const play = await post(app, alice, `/groups/${g.id}/command`, {
      type: 'play',
      position_secs: 30,
    })
    const afterPlay = (await play.json()) as Snapshot
    expect(afterPlay.paused).toBe(false)
    expect(afterPlay.position_secs).toBe(30)

    // 10 wall-clock seconds later, Bob's poll sees the advanced playhead.
    vi.advanceTimersByTime(10_000)
    const poll = await app.request(`/groups/${g.id}`, { headers: { Cookie: bob } })
    expect(poll.status).toBe(200)
    const polled = (await poll.json()) as Snapshot
    expect(polled.position_secs).toBeCloseTo(40, 1)
    expect(polled.version).toBeGreaterThan(g.version)

    // Pause freezes the playhead where the pauser reports it, no matter how
    // much wall-clock time passes (Bob stays under the idle prune window).
    await post(app, bob, `/groups/${g.id}/command`, { type: 'pause', position_secs: 41 })
    vi.advanceTimersByTime(45_000)
    const frozen = (await (
      await app.request(`/groups/${g.id}`, { headers: { Cookie: bob } })
    ).json()) as Snapshot
    expect(frozen.paused).toBe(true)
    expect(frozen.position_secs).toBe(41)
  })

  it('rejects non-members and unknown groups', async () => {
    const app = appUnderTest()
    const alice = await cookieFor('alice')
    const bob = await cookieFor('bob')

    const g = (await (
      await post(app, alice, '/groups', { media_kind: 'episode', media_id: 3 })
    ).json()) as Snapshot

    // Bob never joined: poll and command are both 403.
    expect((await app.request(`/groups/${g.id}`, { headers: { Cookie: bob } })).status).toBe(403)
    expect((await post(app, bob, `/groups/${g.id}/command`, { type: 'play' })).status).toBe(403)

    // Nonexistent group is 404; malformed create bodies are 400.
    expect((await app.request('/groups/nope', { headers: { Cookie: alice } })).status).toBe(404)
    expect((await post(app, alice, '/groups', { media_kind: 'song', media_id: 1 })).status).toBe(
      400,
    )
    expect((await post(app, alice, '/groups', { media_kind: 'movie', media_id: -1 })).status).toBe(
      400,
    )
    // seek without a position is meaningless.
    expect(
      (await post(app, alice, `/groups/${g.id}/command`, { type: 'seek' })).status,
    ).toBe(400)
  })

  it('deletes the group when the last member leaves, and prunes idle members', async () => {
    const app = appUnderTest()
    const alice = await cookieFor('alice')
    const bob = await cookieFor('bob')

    const g = (await (
      await post(app, alice, '/groups', { media_kind: 'movie', media_id: 5 })
    ).json()) as Snapshot
    await post(app, bob, `/groups/${g.id}/join`)

    await post(app, alice, `/groups/${g.id}/leave`)
    const stillThere = await app.request(`/groups/${g.id}`, { headers: { Cookie: bob } })
    expect(stillThere.status).toBe(200)

    await post(app, bob, `/groups/${g.id}/leave`)
    expect((await app.request(`/groups/${g.id}`, { headers: { Cookie: bob } })).status).toBe(404)

    // Idle prune: a fresh group whose only member never polls again vanishes
    // from the listing after the idle window.
    const g2 = (await (
      await post(app, alice, '/groups', { media_kind: 'movie', media_id: 5 })
    ).json()) as Snapshot
    expect(g2.id).not.toBe(g.id)
    vi.advanceTimersByTime(61_000)
    const listing = await app.request('/groups', { headers: { Cookie: bob } })
    expect(((await listing.json()) as { items: Snapshot[] }).items).toHaveLength(0)
  })

  it('requires authentication', async () => {
    const app = appUnderTest()
    expect((await app.request('/groups')).status).toBe(401)
  })
})
