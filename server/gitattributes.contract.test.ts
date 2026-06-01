// M1.5 contract §7.1 mandates EOL normalization for SQL/JSON/YAML so that
// byte-exact interop oracles (tests/vectors/*.json — the Rust ↔ TS ↔ Swift
// parity fixtures) cannot be silently corrupted by a CRLF checkout on a
// Windows contributor machine. This guard locks the repo-root .gitattributes
// so the requirement cannot regress unnoticed.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Resolve the repo root relative to this test file (server/), never a
// hardcoded absolute machine path — keeps the test portable across worktrees
// and CI runners.
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const gitattributesPath = join(repoRoot, '.gitattributes')

describe('.gitattributes EOL normalization (contract §7.1)', () => {
  const raw = readFileSync(gitattributesPath, 'utf8')
  const lines = raw.split('\n').map((l) => l.trim())

  it('contains no CRLF line endings in the file itself', () => {
    expect(raw.includes('\r')).toBe(false)
  })

  it('declares a catch-all `* text=auto` defensive default', () => {
    const hasCatchAll = lines.some(
      (l) => l.startsWith('* ') && l.includes('text=auto'),
    )
    expect(hasCatchAll).toBe(true)
  })

  for (const glob of ['*.sql', '*.json', '*.yml', '*.yaml']) {
    it(`normalizes ${glob} to eol=lf`, () => {
      const match = lines.some(
        (l) => l.startsWith(glob) && l.includes('eol=lf'),
      )
      expect(match).toBe(true)
    })
  }
})
