// SyncPlay group state: watch-together sessions that keep every member's
// playhead in lockstep. A group pins one library item and one transport
// state (paused? position? as-of when?); members poll the snapshot and any
// member may issue play/pause/seek commands, which bump `version` so pollers
// can detect change cheaply.
//
// ponytail: in-memory Map, single-process store — groups are ephemeral
// (they die with the box, which is fine for a living-room feature). Move to
// server.db if groups ever need to survive a restart.

import { randomUUID } from 'crypto'

export type SyncMediaKind = 'movie' | 'episode'

export type SyncCommandType = 'play' | 'pause' | 'seek'

type GroupMember = {
  sub: string
  username: string
  lastSeenMs: number
}

export type SyncGroup = {
  id: string
  hostSub: string
  media_kind: SyncMediaKind
  media_id: number
  paused: boolean
  /** Playhead at the moment `atMs` was stamped. */
  positionSecs: number
  atMs: number
  version: number
  createdAtMs: number
  members: Map<string, GroupMember>
}

// A member that hasn't polled for this long is presumed gone (tab closed,
// app killed). Client polls every few seconds, so 60s is generous.
const MEMBER_IDLE_MS = 60_000

const groups = new Map<string, SyncGroup>()

export function _resetSyncplayForTests(): void {
  groups.clear()
}

/** Current playhead: frozen while paused, wall-clock-advanced while playing. */
export function currentPosition(group: SyncGroup, nowMs: number): number {
  if (group.paused) return group.positionSecs
  return Math.max(0, group.positionSecs + (nowMs - group.atMs) / 1000)
}

/** Drop idle members; drop groups with no members left. */
export function pruneIdle(nowMs: number): void {
  for (const [id, group] of groups) {
    for (const [sub, m] of group.members) {
      if (nowMs - m.lastSeenMs > MEMBER_IDLE_MS) group.members.delete(sub)
    }
    if (group.members.size === 0) groups.delete(id)
  }
}

export function listGroups(nowMs: number): SyncGroup[] {
  pruneIdle(nowMs)
  return [...groups.values()]
}

export function getGroup(id: string, nowMs: number): SyncGroup | undefined {
  pruneIdle(nowMs)
  return groups.get(id)
}

export function createGroup(
  host: { sub: string; username: string },
  media_kind: SyncMediaKind,
  media_id: number,
  nowMs: number,
): SyncGroup {
  const group: SyncGroup = {
    id: randomUUID(),
    hostSub: host.sub,
    media_kind,
    media_id,
    paused: true,
    positionSecs: 0,
    atMs: nowMs,
    version: 1,
    createdAtMs: nowMs,
    members: new Map([[host.sub, { ...host, lastSeenMs: nowMs }]]),
  }
  groups.set(group.id, group)
  return group
}

export function joinGroup(
  group: SyncGroup,
  member: { sub: string; username: string },
  nowMs: number,
): void {
  group.members.set(member.sub, { ...member, lastSeenMs: nowMs })
  group.version += 1
}

/** Returns true if the group still exists after the leave. */
export function leaveGroup(group: SyncGroup, sub: string): boolean {
  group.members.delete(sub)
  if (group.members.size === 0) {
    groups.delete(group.id)
    return false
  }
  group.version += 1
  return true
}

export function touchMember(group: SyncGroup, sub: string, nowMs: number): void {
  const m = group.members.get(sub)
  if (m) m.lastSeenMs = nowMs
}

/**
 * Apply a transport command from a member. `seek` requires positionSecs;
 * `play`/`pause` accept an optional one (client sends its playhead so the
 * group adopts the commander's exact position, not the server's estimate).
 */
export function applyCommand(
  group: SyncGroup,
  type: SyncCommandType,
  positionSecs: number | undefined,
  nowMs: number,
): void {
  const at = positionSecs ?? currentPosition(group, nowMs)
  group.positionSecs = Math.max(0, at)
  group.atMs = nowMs
  if (type === 'play') group.paused = false
  else if (type === 'pause') group.paused = true
  // seek keeps the current paused/playing state.
  group.version += 1
}

/** JSON view for pollers: computed position plus member roster. */
export function snapshot(group: SyncGroup, nowMs: number) {
  return {
    id: group.id,
    host_sub: group.hostSub,
    media_kind: group.media_kind,
    media_id: group.media_id,
    paused: group.paused,
    position_secs: Math.round(currentPosition(group, nowMs) * 1000) / 1000,
    version: group.version,
    members: [...group.members.values()].map((m) => ({
      sub: m.sub,
      username: m.username,
    })),
  }
}
