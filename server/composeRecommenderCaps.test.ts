// 2026-10-16 review item 13: the recommender entrypoint chowns /data and drops
// to its user with gosu, so a cap_drop: ALL service needs CHOWN, SETUID and
// SETGID back. The self-host compose dropped them all and crash-looped; the
// prod compose had them. Both files must agree.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')

function serviceBlock(composePath: string, service: string): string {
  const lines = readFileSync(resolve(ROOT, composePath), 'utf8').split('\n')
  const start = lines.findIndex((line) => line === `  ${service}:`)
  const end = lines.findIndex((line, i) => i > start && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line))
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n')
}

describe('recommender capabilities match its gosu entrypoint', () => {
  it.each(['docker-compose.yml', 'selfhost/docker-compose.yml'])('%s', (composePath) => {
    const block = serviceBlock(composePath, 'recommender')
    expect(block).toMatch(/cap_drop:\s*\n\s*- ALL/)
    const added = /cap_add:\s*\n((?:\s*- [A-Z_]+\s*\n?)+)/.exec(block)?.[1] ?? ''
    for (const cap of ['CHOWN', 'SETUID', 'SETGID']) expect(added).toContain(cap)
  })
})
