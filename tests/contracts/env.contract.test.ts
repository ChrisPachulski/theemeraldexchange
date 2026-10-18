// Env-shape contract: every variable a compose file hands the backend must be
// one the Rust gateway actually reads. A renamed or dropped key otherwise
// fails silently: compose keeps passing it, the gateway keeps its default, and
// nothing says the operator's setting stopped doing anything.
//
// The gateway's env surface is crates/auth/src/config.rs (secrets, origins,
// providers, server.db) plus crates/gateway/src/config.rs (everything else).
// Every key either file reads appears there as a quoted UPPER_SNAKE literal,
// so that set is the contract.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../..')
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8')

function rustConfigKeys(): Set<string> {
  const keys = new Set<string>()
  for (const file of ['crates/auth/src/config.rs', 'crates/gateway/src/config.rs']) {
    for (const m of read(file).matchAll(/"([A-Z][A-Z0-9_]{2,})"/g)) keys.add(m[1])
  }
  return keys
}

/** Keys under `backend:` → `environment:` in a compose file. */
function backendEnvKeys(compose: string): string[] {
  const lines = compose.split('\n')
  const start = lines.findIndex((l) => /^ {2}backend:\s*$/.test(l))
  if (start === -1) return []
  const end = lines.findIndex((l, i) => i > start && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l))
  const backend = lines.slice(start + 1, end === -1 ? undefined : end)
  const envStart = backend.findIndex((l) => /^ {4}environment:\s*$/.test(l))
  if (envStart === -1) return []
  const envEnd = backend.findIndex((l, i) => i > envStart && /^ {4}\S/.test(l))
  return backend
    .slice(envStart + 1, envEnd === -1 ? undefined : envEnd)
    .map((l) => /^ {6}([A-Z][A-Z0-9_]*):/.exec(l)?.[1])
    .filter((k): k is string => k !== undefined)
}

describe('backend env contract (compose -> Rust gateway config)', () => {
  const known = rustConfigKeys()

  it('reads the Rust config (scan is not vacuous)', () => {
    for (const k of ['SESSION_SECRET', 'SONARR_URL', 'SERVER_DB_PATH', 'NODE_ENV']) {
      expect(known.has(k), k).toBe(true)
    }
  })

  it.each(['docker-compose.yml', 'selfhost/docker-compose.yml'])(
    '%s passes the backend only keys the gateway reads',
    (path) => {
      const keys = backendEnvKeys(read(path))
      expect(keys.length).toBeGreaterThan(10)
      expect(keys.filter((k) => !known.has(k))).toEqual([])
    },
  )
})
