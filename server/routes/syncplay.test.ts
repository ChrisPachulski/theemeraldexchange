import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { syncplay } from './syncplay.js'
import { createMemberSession as createSession } from '../test/authFixture.js'
import { _resetSyncplayForTests } from '../services/syncplay.js'
import type { Env } from '../middleware/auth.js'

function appUnderTest() {
  const app = new Hono<Env>()
  app.route('/', syncplay)
  return app
}

const SUBS = { alice: 'plex:1', bob: 'plex:2', carol: 'plex:3' } as const

async function cookieFor(sub: keyof typeof SUBS) {
  const t = await createSession({ sub: SUBS[sub], username: `user-${sub}`, role: 'user' })
  return `eex.session=${t}`
}

function post(app: ReturnType<typeof appUnderTest>, cookie: string, path: string, body?: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

// Sends a POST whose JSON body arrives in two chunks and runs `duringRead` in
// the gap — i.e. while the handler is parked on `await parseLimitedJson`. The
// stream cannot finish until `duringRead` has run, so the interleaving is
// deterministic rather than a timing race.
function postStreamed(
  app: ReturnType<typeof appUnderTest>,
  cookie: string,
  path: string,
  body: unknown,
  duringRead: () => unknown,
) {
  const json = new TextEncoder().encode(JSON.stringify(body))
  let sentHead = false
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentHead) {
        sentHead = true
        controller.enqueue(json.subarray(0, 1))
        return
      }
      await duringRead()
      controller.enqueue(json.subarray(1))
      controller.close()
    },
  })
  return app.request(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: stream,
      // Node requires this whenever the request body is a stream.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }),
  )
}

type Snapshot = {
  id: string
  host_sub: string | null
  media_kind: string
  media_id: number
  paused: boolean
  position_secs: number
  version: number
  members: { sub: string; username: string }[]
}

type Listing = { items: (Snapshot & { member_count: number })[] }

async function listGroupsAs(app: ReturnType<typeof appUnderTest>, cookie: string) {
  const res = await app.request('/groups', { headers: { Cookie: cookie } })
  expect(res.status).toBe(200)
  return ((await res.json()) as Listing).items
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

  it('lists the full roster to every authenticated member, joined or not', async () => {
    const app = appUnderTest()
    const alice = await cookieFor('alice')
    const bob = await cookieFor('bob')

    const g = (await (
      await post(app, alice, '/groups', { media_kind: 'movie', media_id: 42 })
    ).json()) as Snapshot

    // Bob has not joined, and still sees the roster. Joining is an unguarded
    // POST any authenticated member can make, after which GET /groups/:id
    // hands over the same names — so redacting the listing only hid what was
    // one request away, and promised a confidentiality the code cannot keep.
    const [seenByBob] = await listGroupsAs(app, bob)
    expect(seenByBob.id).toBe(g.id)
    expect(seenByBob.media_kind).toBe('movie')
    expect(seenByBob.media_id).toBe(42)
    expect(seenByBob.paused).toBe(true)
    expect(seenByBob.member_count).toBe(1)
    expect(seenByBob.host_sub).toBe('plex:1')
    expect(seenByBob.members).toEqual([{ sub: 'plex:1', username: 'user-alice' }])

    // One shape for everyone: a member's own view is byte-identical.
    const [seenByAlice] = await listGroupsAs(app, alice)
    expect(seenByAlice).toEqual(seenByBob)

    // Joining changes the roster's CONTENTS, never its visibility.
    expect((await post(app, bob, `/groups/${g.id}/join`)).status).toBe(200)
    const [afterJoin] = await listGroupsAs(app, bob)
    expect(afterJoin.host_sub).toBe('plex:1')
    expect(afterJoin.member_count).toBe(2)
    expect(afterJoin.members.map((m) => m.username).sort()).toEqual(['user-alice', 'user-bob'])

    // ...and leaving drops him from it, still fully visible to him.
    await post(app, bob, `/groups/${g.id}/leave`)
    const [afterLeave] = await listGroupsAs(app, bob)
    expect(afterLeave.member_count).toBe(1)
    expect(afterLeave.host_sub).toBe('plex:1')
    expect(afterLeave.members).toEqual([{ sub: 'plex:1', username: 'user-alice' }])
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
    // Host left but bob remains: hosting reassigns to a surviving member
    // rather than staying pinned to a sub that's no longer in the group.
    expect(((await stillThere.json()) as Snapshot).host_sub).toBe('plex:2')

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

  it('reassigns hostSub when the host idles out silently, same as an explicit leave', async () => {
    const app = appUnderTest()
    const alice = await cookieFor('alice')
    const bob = await cookieFor('bob')

    const g = (await (
      await post(app, alice, '/groups', { media_kind: 'movie', media_id: 21 })
    ).json()) as Snapshot
    expect(g.host_sub).toBe('plex:1')
    await post(app, bob, `/groups/${g.id}/join`)

    // Bob keeps polling (the poll is the heartbeat); alice — the host — closes
    // her tab and never polls again. She never hits /leave, so the only thing
    // that removes her is the idle prune.
    vi.advanceTimersByTime(40_000)
    expect((await app.request(`/groups/${g.id}`, { headers: { Cookie: bob } })).status).toBe(200)

    // 80s since alice's last sight: past the 60s window, while bob is only 40s
    // stale and survives.
    vi.advanceTimersByTime(40_000)
    const res = await app.request(`/groups/${g.id}`, { headers: { Cookie: bob } })
    expect(res.status).toBe(200)
    const snap = (await res.json()) as Snapshot
    expect(snap.members.map((m) => m.sub)).toEqual(['plex:2'])
    // A silent timeout must hand hosting over exactly like /leave does, not
    // leave host_sub pinned to a sub that is no longer in the group.
    expect(snap.host_sub).toBe('plex:2')

    // The listing reads through the same prune, so it must agree.
    const [listed] = await listGroupsAs(app, bob)
    expect(listed.host_sub).toBe('plex:2')
  })

  it('bumps version when the idle prune drops a member, so pollers notice', async () => {
    const app = appUnderTest()
    const alice = await cookieFor('alice')
    const bob = await cookieFor('bob')

    const g = (await (
      await post(app, alice, '/groups', { media_kind: 'movie', media_id: 24 })
    ).json()) as Snapshot
    const afterJoin = (await (await post(app, bob, `/groups/${g.id}/join`)).json()) as Snapshot

    // Same shape as the silent-host-timeout case: two 40s hops with a poll in
    // between so bob's heartbeat keeps him alive while alice ages out.
    vi.advanceTimersByTime(40_000)
    expect((await app.request(`/groups/${g.id}`, { headers: { Cookie: bob } })).status).toBe(200)

    vi.advanceTimersByTime(40_000)
    const pruned = (await (
      await app.request(`/groups/${g.id}`, { headers: { Cookie: bob } })
    ).json()) as Snapshot
    expect(pruned.members.map((m) => m.sub)).toEqual(['plex:2'])
    // Bob's client diffs on version alone. A prune that silently drops the
    // host without bumping it leaves every poller rendering a stale roster.
    expect(pruned.version).toBeGreaterThan(afterJoin.version)
  })

  it('skips past members who idle out in the same sweep when rehoming the host', async () => {
    const app = appUnderTest()
    const alice = await cookieFor('alice')
    const bob = await cookieFor('bob')
    const carol = await cookieFor('carol')

    const g = (await (
      await post(app, alice, '/groups', { media_kind: 'movie', media_id: 23 })
    ).json()) as Snapshot
    await post(app, bob, `/groups/${g.id}/join`)
    await post(app, carol, `/groups/${g.id}/join`)

    // Only carol keeps the heartbeat alive; alice (host) and bob both go dark
    // in the same prune sweep. Handing the group to the next member in the map
    // would hand it to bob, who is on his way out in this very loop.
    vi.advanceTimersByTime(40_000)
    expect((await app.request(`/groups/${g.id}`, { headers: { Cookie: carol } })).status).toBe(200)

    vi.advanceTimersByTime(40_000)
    const snap = (await (
      await app.request(`/groups/${g.id}`, { headers: { Cookie: carol } })
    ).json()) as Snapshot
    expect(snap.members.map((m) => m.sub)).toEqual(['plex:3'])
    expect(snap.host_sub).toBe('plex:3')
  })

  // The command handler awaits the request body. Anything it resolved before
  // that await — the group, the membership check, the clock — is stale by the
  // time it mutates, because other requests run in the gap.
  describe('state resolved across the body-parse await', () => {
    it('403s a member who left while his command body was still in flight', async () => {
      const app = appUnderTest()
      const alice = await cookieFor('alice')
      const bob = await cookieFor('bob')

      const g = (await (
        await post(app, alice, '/groups', { media_kind: 'movie', media_id: 9 })
      ).json()) as Snapshot
      await post(app, bob, `/groups/${g.id}/join`)

      // Bob starts a play command, then leaves from another tab before the
      // body lands. Alice stays, so the group survives — only bob's membership
      // is gone, and a non-member must not drive the shared transport.
      const res = await postStreamed(
        app,
        bob,
        `/groups/${g.id}/command`,
        { type: 'play', position_secs: 99 },
        () => post(app, bob, `/groups/${g.id}/leave`),
      )
      expect(res.status).toBe(403)

      const after = (await (
        await app.request(`/groups/${g.id}`, { headers: { Cookie: alice } })
      ).json()) as Snapshot
      expect(after.paused).toBe(true)
      expect(after.position_secs).toBe(0)
      expect(after.members.map((m) => m.sub)).toEqual(['plex:1'])
    })

    it('404s instead of mutating a group deleted while the body was in flight', async () => {
      const app = appUnderTest()
      const alice = await cookieFor('alice')

      const g = (await (
        await post(app, alice, '/groups', { media_kind: 'movie', media_id: 11 })
      ).json()) as Snapshot

      // Alice is the only member: her leave deletes the group outright, so the
      // command must not report success against a detached object.
      const res = await postStreamed(
        app,
        alice,
        `/groups/${g.id}/command`,
        { type: 'seek', position_secs: 120 },
        () => post(app, alice, `/groups/${g.id}/leave`),
      )
      expect(res.status).toBe(404)
      expect(await listGroupsAs(app, alice)).toHaveLength(0)
    })

    it('404s when the body read outlasts the idle window that prunes the group', async () => {
      const app = appUnderTest()
      const alice = await cookieFor('alice')

      const g = (await (
        await post(app, alice, '/groups', { media_kind: 'movie', media_id: 13 })
      ).json()) as Snapshot

      // No concurrent request at all — just a body that dribbles past the idle
      // window. The group is pruned out from under the handler.
      const res = await postStreamed(
        app,
        alice,
        `/groups/${g.id}/command`,
        { type: 'play', position_secs: 5 },
        () => {
          vi.advanceTimersByTime(61_000)
        },
      )
      expect(res.status).toBe(404)
    })

    it('stamps the command with the clock at apply time, not at request start', async () => {
      const app = appUnderTest()
      const alice = await cookieFor('alice')

      const g = (await (
        await post(app, alice, '/groups', { media_kind: 'movie', media_id: 15 })
      ).json()) as Snapshot

      // 20s of wall clock burn while the body arrives (still inside the idle
      // window). Alice asked to play from 30s; the group must start at 30s.
      const res = await postStreamed(
        app,
        alice,
        `/groups/${g.id}/command`,
        { type: 'play', position_secs: 30 },
        () => {
          vi.advanceTimersByTime(20_000)
        },
      )
      expect(res.status).toBe(200)
      expect(((await res.json()) as Snapshot).position_secs).toBe(30)

      // The poll is the discriminator: a pre-read `atMs` makes the playhead
      // jump forward by the read's duration (30 -> 50) with no time elapsed.
      const polled = (await (
        await app.request(`/groups/${g.id}`, { headers: { Cookie: alice } })
      ).json()) as Snapshot
      expect(polled.position_secs).toBe(30)
    })

    it('still rejects a malformed streamed body before touching the group', async () => {
      const app = appUnderTest()
      const alice = await cookieFor('alice')

      const g = (await (
        await post(app, alice, '/groups', { media_kind: 'movie', media_id: 17 })
      ).json()) as Snapshot

      expect(
        (
          await postStreamed(
            app,
            alice,
            `/groups/${g.id}/command`,
            { type: 'seek' },
            () => {},
          )
        ).status,
      ).toBe(400)
      expect(
        (
          await postStreamed(
            app,
            alice,
            `/groups/${g.id}/command`,
            { type: 'play', position_secs: 'soon' },
            () => {},
          )
        ).status,
      ).toBe(400)

      const after = (await (
        await app.request(`/groups/${g.id}`, { headers: { Cookie: alice } })
      ).json()) as Snapshot
      expect(after.paused).toBe(true)
      expect(after.position_secs).toBe(0)
      expect(after.version).toBe(g.version)
    })
  })

  it('requires authentication', async () => {
    const app = appUnderTest()
    expect((await app.request('/groups')).status).toBe(401)
  })
})
