// Env-shape contract test (audit: per-route tests mock env.js wholesale,
// so nothing fails when the REAL env object renames or drops a key the
// mocks still carry — the route under test silently reads `undefined` in
// production while its test keeps passing against the stale mock shape).
//
// This test closes that drift window the cheapest honest way: it scans
// every server test file that calls `vi.mock('../env.js', …)`, extracts
// the property keys each factory puts on its fake `env` object (plain
// `key:` entries and `get key()` accessors; `...actual.env` spreads are
// skipped), and asserts every one of those keys still exists on the REAL
// `env` exported by server/env.ts. The real module is imported here
// un-mocked — vitest supplies the required vars via TEST_ENV
// (vitest.env.ts), the same way every other suite boots it.
//
// What this deliberately does NOT do:
//   - value/type equality (mock values are scenario fixtures, not specs);
//   - enforce that mocks are COMPLETE (partial mocks are fine — routes
//     only read the keys they use, and a missing key fails the route
//     test itself with a visible `undefined`).
// A renamed/removed env key is the silent failure mode; key existence is
// the contract.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'
import { env } from './env.js'

const SERVER_ROOT = __dirname

function listTestFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      out.push(...listTestFiles(p))
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      out.push(p)
    }
  }
  return out
}

/** Extract the top-level keys of the object literal that starts at
 *  `source[openBrace]` (which must be `{`). Tracks brace depth and skips
 *  string/template-literal contents so URL values etc. can't confuse the
 *  counter. Returns null when the braces never balance (parse failure —
 *  the caller turns that into a loud test failure, not a silent pass). */
function topLevelKeys(source: string, openBrace: number): string[] | null {
  if (source[openBrace] !== '{') return null
  const keys: string[] = []
  let depth = 0
  let i = openBrace
  let quote: string | null = null
  while (i < source.length) {
    const ch = source[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
    } else if (ch === '{' || ch === '(') {
      depth++
    } else if (ch === '}' || ch === ')') {
      depth--
      if (depth === 0 && ch === '}') {
        // End of the env object literal.
        return keys
      }
    } else if (depth === 1) {
      // At top level of the literal: capture `key:` and `get key(`.
      const rest = source.slice(i)
      const plain = rest.match(/^([A-Za-z_$][\w$]*)\s*:/)
      const getter = rest.match(/^get\s+([A-Za-z_$][\w$]*)\s*\(/)
      if (getter) {
        keys.push(getter[1])
        i += getter[0].length - 1
      } else if (plain && source[i - 1] !== '.') {
        // `source[i-1] !== '.'` guards against `...spread` fragments and
        // member accesses; top-level shorthand keys aren't used in these
        // factories so `key:` / `get key(` cover every real entry.
        keys.push(plain[1])
        i += plain[0].length - 1
      } else if (rest.startsWith('...')) {
        // Spread of the actual env — by definition shape-correct; skip
        // past the token so the identifier after it isn't read as a key.
        i += 2
      }
      // Skip to the end of this top-level entry: advance through the
      // value, which the depth tracking above handles naturally.
    }
    i++
  }
  return null
}

/** Find every fake-env key declared by `vi.mock('../env.js', …)` factories
 *  in the given source. A file can in principle contain several mock calls
 *  (it doesn't today, but the scan is cheap). */
function mockedEnvKeys(source: string): string[][] {
  const results: string[][] = []
  const mockCall = /vi\.mock\(\s*['"]\.\.\/(?:\.\.\/)?env\.js['"]/g
  let m: RegExpExecArray | null
  while ((m = mockCall.exec(source)) !== null) {
    // Find the `env:` property of the factory's return value. Candidates
    // are `env:` followed by an object literal or an identifier reference.
    // Type annotations inside the factory (e.g. the importActual cast
    // `as { env: Record<string, unknown> }`) also match the pattern, so we
    // walk ALL candidates in order and accept the first that yields keys —
    // `env: Record` resolves to no declaration and is skipped; the real
    // `env: { … }` literal that follows wins.
    const candidate = /env:\s*(\{|[A-Za-z_$][\w$]*)/g
    candidate.lastIndex = m.index
    let keys: string[] | null = null
    let c: RegExpExecArray | null
    while ((c = candidate.exec(source)) !== null) {
      if (c[1] === '{') {
        keys = topLevelKeys(source, c.index + c[0].length - 1)
      } else {
        // `env: someIdentifier` — the fixture object lives in a const
        // (usually vi.hoisted). Resolve its object literal in this file.
        const decl = new RegExp(
          `(?:const|let)\\s+${c[1]}\\s*=\\s*(?:vi\\.hoisted\\(\\s*\\(\\)\\s*=>\\s*\\()?\\s*\\{`,
        ).exec(source)
        keys = decl ? topLevelKeys(source, decl.index + decl[0].length - 1) : null
      }
      if (keys && keys.length > 0) break
    }
    // No candidate parsed → empty entry, which the test rejects loudly.
    results.push(keys && keys.length > 0 ? keys : [])
  }
  return results
}

describe('env mock shape contract', () => {
  const realKeys = new Set(Object.keys(env))
  const files = listTestFiles(SERVER_ROOT).filter((f) => !f.endsWith('env.contract.test.ts'))
  const mockingFiles = files
    .map((f) => ({ file: f, source: readFileSync(f, 'utf-8') }))
    .filter(({ source }) => /vi\.mock\(\s*['"]\.\.\/(?:\.\.\/)?env\.js['"]/.test(source))

  it('finds the env-mocking test files (scan is not vacuous)', () => {
    // 12 files mock env.js at the time of writing. If this drops to zero
    // the scan regex (or the file layout) rotted and the contract below
    // would pass vacuously — fail loudly instead.
    expect(mockingFiles.length).toBeGreaterThanOrEqual(5)
  })

  it('every key a test mocks onto env still exists on the real env', () => {
    const failures: string[] = []
    for (const { file, source } of mockingFiles) {
      const rel = relative(SERVER_ROOT, file)
      const perMock = mockedEnvKeys(source)
      if (perMock.length === 0) {
        failures.push(`${rel}: vi.mock('../env.js') found but no env object literal parsed`)
        continue
      }
      for (const keys of perMock) {
        if (keys.length === 0) {
          failures.push(`${rel}: env mock factory parsed to zero keys (unbalanced literal?)`)
          continue
        }
        for (const key of keys) {
          if (!realKeys.has(key)) {
            failures.push(
              `${rel}: mocks env.${key}, which no longer exists on the real env ` +
                `(renamed/removed in server/env.ts?) — update the mock or the route under test`,
            )
          }
        }
      }
    }
    expect(failures, failures.join('\n')).toEqual([])
  })
})
