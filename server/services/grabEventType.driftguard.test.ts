import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Cross-language drift guard for the hand-synced GrabEventType union.
//
// The client (src/lib/api/grabs.ts) re-declares GrabEventType to mirror this
// server type (server/services/grabLog.ts). GrabActivityPanel.tsx builds
// exhaustive `Record<GrabEventType, ...>` label + tone maps — TypeScript enforces
// those maps match the CLIENT union, but nothing compile-checks the client union
// against the SERVER union. When the server gained 'planned_size_exceeds_free_space'
// the client union lagged, so that event silently resolved to `undefined` in both
// maps at runtime. This test fails loudly the next time the two unions drift.
//
// Lives server-side (not under src/) because it reads files via node fs/path,
// which are not typed under the frontend tsconfig.app.json project.

function extractGrabEventTypeMembers(absPath: string): Set<string> {
  const src = readFileSync(absPath, 'utf8')
  const decl = src.match(/export type GrabEventType\s*=([\s\S]*?)(?:\n\n|\nexport |\ntype |\n[A-Za-z])/)
  if (!decl) throw new Error(`GrabEventType union not found in ${absPath}`)
  const members = decl[1].match(/'([a-z_]+)'/g)
  if (!members) throw new Error(`No string-literal members parsed from GrabEventType in ${absPath}`)
  return new Set(members.map((m: string) => m.replace(/'/g, '')))
}

describe('GrabEventType client/server contract', () => {
  // vitest runs from the repo root.
  const root = process.cwd()
  const serverMembers = extractGrabEventTypeMembers(
    resolve(root, 'server/services/grabLog.ts'),
  )
  const clientMembers = extractGrabEventTypeMembers(
    resolve(root, 'src/lib/api/grabs.ts'),
  )

  it('client union covers every server GrabEventType member (no silent-undefined drift)', () => {
    const missingOnClient = [...serverMembers].filter((m: string) => !clientMembers.has(m))
    expect(missingOnClient).toEqual([])
  })

  it('client union has no members the server does not emit', () => {
    const extraOnClient = [...clientMembers].filter((m: string) => !serverMembers.has(m))
    expect(extraOnClient).toEqual([])
  })

  it('includes planned_size_exceeds_free_space on both sides (regression pin)', () => {
    expect(serverMembers.has('planned_size_exceeds_free_space')).toBe(true)
    expect(clientMembers.has('planned_size_exceeds_free_space')).toBe(true)
  })
})
