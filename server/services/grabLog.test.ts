import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  appendGrabEvent,
  readRecentGrabEvents,
  readEventsForItem,
  _setGrabLogPathForTests,
} from './grabLog.js'

let tmpRoot: string
let logPath: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'grablog-'))
  logPath = join(tmpRoot, 'grabs.jsonl')
  _setGrabLogPathForTests(logPath)
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('appendGrabEvent + readRecentGrabEvents', () => {
  it('writes and reads back events newest-first', async () => {
    await appendGrabEvent({ app: 'sonarr', itemId: 1, type: 'grab_started', title: 'A' })
    await appendGrabEvent({ app: 'sonarr', itemId: 1, type: 'grab_succeeded', title: 'A' })
    await appendGrabEvent({ app: 'radarr', itemId: 99, type: 'no_releases', title: 'B' })

    const events = await readRecentGrabEvents(10)
    expect(events).toHaveLength(3)
    expect(events.map((e) => e.type)).toEqual([
      'no_releases',
      'grab_succeeded',
      'grab_started',
    ])
  })

  it('returns [] when log file does not exist', async () => {
    const events = await readRecentGrabEvents(10)
    expect(events).toEqual([])
  })

  it('respects the limit', async () => {
    for (let i = 0; i < 50; i++) {
      await appendGrabEvent({ app: 'sonarr', itemId: i, type: 'grab_started' })
    }
    const events = await readRecentGrabEvents(5)
    expect(events).toHaveLength(5)
    // newest first, so itemIds 49..45
    expect(events.map((e) => e.itemId)).toEqual([49, 48, 47, 46, 45])
  })

  it('skips malformed lines silently', async () => {
    await appendGrabEvent({ app: 'sonarr', itemId: 1, type: 'grab_started' })
    // jam a bad line directly into the file
    await fs.appendFile(logPath, 'not json\n')
    await appendGrabEvent({ app: 'sonarr', itemId: 2, type: 'grab_succeeded' })

    const events = await readRecentGrabEvents(10)
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.itemId)).toEqual([2, 1])
  })

  it('survives a tail spanning multiple 64KB chunks', async () => {
    // Each event line is ~80 bytes; 2000 events ≈ 160KB which forces
    // the tail reader to walk 3+ chunks backward.
    for (let i = 0; i < 2000; i++) {
      await appendGrabEvent({
        app: 'sonarr',
        itemId: i,
        type: 'grab_started',
        title: `series-${i}`,
      })
    }
    const events = await readRecentGrabEvents(10)
    expect(events).toHaveLength(10)
    expect(events[0].itemId).toBe(1999)
    expect(events[9].itemId).toBe(1990)
  })
})

describe('readEventsForItem', () => {
  it('filters by app + itemId', async () => {
    await appendGrabEvent({ app: 'sonarr', itemId: 7, type: 'grab_started' })
    await appendGrabEvent({ app: 'sonarr', itemId: 7, type: 'no_releases' })
    await appendGrabEvent({ app: 'radarr', itemId: 7, type: 'grab_started' })
    await appendGrabEvent({ app: 'sonarr', itemId: 8, type: 'grab_started' })

    const sonarr7 = await readEventsForItem('sonarr', 7, 10)
    expect(sonarr7).toHaveLength(2)
    expect(sonarr7.every((e) => e.app === 'sonarr' && e.itemId === 7)).toBe(true)

    const radarr7 = await readEventsForItem('radarr', 7, 10)
    expect(radarr7).toHaveLength(1)
    expect(radarr7[0].type).toBe('grab_started')
  })

  it('returns [] when no events for the item', async () => {
    await appendGrabEvent({ app: 'sonarr', itemId: 1, type: 'grab_started' })
    const events = await readEventsForItem('sonarr', 999, 10)
    expect(events).toEqual([])
  })
})

describe('rotation', () => {
  it('rolls the file when it crosses the threshold and still serves old events', async () => {
    // Fabricate an over-sized primary file with a clearly-identifiable
    // event at the end, then trigger a new append to roll it.
    const oldEvent = {
      ts: '2026-01-01T00:00:00.000Z',
      app: 'sonarr',
      itemId: 42,
      type: 'grab_succeeded',
      title: 'PRE_ROLL',
    }
    const oneLine = JSON.stringify(oldEvent) + '\n'
    // Pad with arbitrary lines to push past 5MB
    const padLine =
      JSON.stringify({ ...oldEvent, title: 'X'.repeat(200) }) + '\n'
    const padCount = Math.ceil((5 * 1024 * 1024) / padLine.length) + 5
    let payload = ''
    for (let i = 0; i < padCount; i++) payload += padLine
    payload += oneLine
    await fs.mkdir(tmpRoot, { recursive: true })
    await fs.writeFile(logPath, payload)

    await appendGrabEvent({ app: 'radarr', itemId: 1, type: 'grab_started', title: 'POST_ROLL' })

    // Primary should now be just the new event
    const primaryContents = await fs.readFile(logPath, 'utf8')
    expect(primaryContents.split('\n').filter(Boolean)).toHaveLength(1)
    expect(primaryContents).toContain('POST_ROLL')

    // The rotated .1 should still exist and contain PRE_ROLL
    const rotatedContents = await fs.readFile(logPath + '.1', 'utf8')
    expect(rotatedContents).toContain('PRE_ROLL')

    // Reading recent across both files surfaces the new event AND can
    // top up from the rotated tail.
    const events = await readRecentGrabEvents(3)
    expect(events[0].title).toBe('POST_ROLL')
    // Tail of the rotated file is reachable
    expect(events.some((e) => e.title === 'PRE_ROLL' || e.title?.startsWith('X'))).toBe(true)
  })
})
