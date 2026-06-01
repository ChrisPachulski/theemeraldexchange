import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Cross-language drift guard for the PlaySource union.
//
// The client (src/lib/api/iptv.ts) defines a `source` field in SourceUnavailableError
// with type `'plex' | 'iptv' | 'local'`. The server (server/services/sourcePrecedence.ts)
// exports PlaySource = `'local' | 'plex' | 'iptv'`. Both unions contain the same values
// but a new source type added to one side without the other would silently fail at
// runtime. This test fails loudly the moment the two unions drift.

function extractPlaySourceMembers(absPath: string): Set<string> {
  const src = readFileSync(absPath, 'utf8')
  const decl = src.match(/export type PlaySource\s*=([\s\S]*?)(?:\n\n|\nexport |\ntype |\nfunction |async |const )/)
  if (!decl) throw new Error(`PlaySource union not found in ${absPath}`)
  const members = decl[1].match(/'([a-z_]+)'/g)
  if (!members) throw new Error(`No string-literal members parsed from PlaySource in ${absPath}`)
  return new Set(members.map((m: string) => m.replace(/'/g, '')))
}

function extractSourceFieldMembers(absPath: string): Set<string> {
  const src = readFileSync(absPath, 'utf8')
  // Match the source field in SourceUnavailableError
  const decl = src.match(/source:\s*'([a-z_]+)'\s*\|\s*'([a-z_]+)'\s*\|\s*'([a-z_]+)'/)
  if (!decl) throw new Error(`source field members not found in ${absPath}`)
  return new Set([decl[1], decl[2], decl[3]])
}

describe('PlaySource client/server contract', () => {
  // vitest runs from the repo root.
  const root = process.cwd()
  const serverMembers = extractPlaySourceMembers(
    resolve(root, 'server/services/sourcePrecedence.ts'),
  )
  const clientMembers = extractSourceFieldMembers(
    resolve(root, 'src/lib/api/iptv.ts'),
  )

  it('client source field covers every server PlaySource member (no missing sources)', () => {
    const missingOnClient = [...serverMembers].filter((m: string) => !clientMembers.has(m))
    expect(missingOnClient).toEqual([])
  })

  it('client source field has no members the server does not have', () => {
    const extraOnClient = [...clientMembers].filter((m: string) => !serverMembers.has(m))
    expect(extraOnClient).toEqual([])
  })

  it('includes local, plex, and iptv on both sides (regression pin)', () => {
    expect(serverMembers.has('local')).toBe(true)
    expect(serverMembers.has('plex')).toBe(true)
    expect(serverMembers.has('iptv')).toBe(true)
    expect(clientMembers.has('local')).toBe(true)
    expect(clientMembers.has('plex')).toBe(true)
    expect(clientMembers.has('iptv')).toBe(true)
  })
})
