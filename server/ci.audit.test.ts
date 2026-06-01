import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Meta-test for the supply-chain dependency-audit gate (MEDIUM #7 / LOW #23).
//
// This test parses .github/workflows/ci.yml as TEXT and asserts the npm,
// cargo, and pip audit gates are present AND enforcing. Its job is to make
// the gate tamper-evident: if anyone deletes an audit step, downgrades the
// npm severity threshold below `high`, or slaps `continue-on-error: true` on
// an audit step to silence it, this test goes red. The highest-value
// assertion is the "enforcing" check at the bottom — it splits the workflow
// into per-step blocks and proves no audit step soft-fails.

const ciYaml = readFileSync(
  resolve(process.cwd(), '.github/workflows/ci.yml'),
  'utf8',
)

// Audit tokens we care about. A step "is an audit step" if its body
// contains any of these.
const AUDIT_TOKENS = [/npm audit/, /rustsec\/audit-check/, /cargo audit/, /pip-audit/]

// Split the YAML into step blocks on `- name:` list-item boundaries so we can
// reason about each step's body in isolation (resilient to indentation).
function stepBlocks(yaml: string): string[] {
  // Match each `- name:` and everything up to (but not including) the next one.
  const parts = yaml.split(/(?=^\s*-\s+name:)/m)
  return parts.filter((p) => /-\s+name:/.test(p))
}

describe('ci.yml — supply-chain dependency-audit gate', () => {
  it('runs npm audit at the high severity threshold', () => {
    expect(/npm audit[^\n]*--audit-level=high/.test(ciYaml)).toBe(true)
  })

  it('does not downgrade or weaken the npm audit gate below high', () => {
    // No npm audit at moderate/low — that would defeat the gate's purpose.
    expect(/npm audit[^\n]*--audit-level=(moderate|low)/.test(ciYaml)).toBe(false)
  })

  it('runs a cargo / RustSec advisory audit', () => {
    expect(/rustsec\/audit-check/.test(ciYaml) || /cargo audit/.test(ciYaml)).toBe(true)
  })

  it('runs a Python pip-audit', () => {
    expect(/pip-audit/.test(ciYaml)).toBe(true)
  })

  it('locates all three audit gates as discrete steps', () => {
    const blocks = stepBlocks(ciYaml)
    const auditBlocks = blocks.filter((b) => AUDIT_TOKENS.some((t) => t.test(b)))
    // npm, cargo, pip — three distinct audit steps.
    expect(auditBlocks.length).toBeGreaterThanOrEqual(3)
  })

  it('keeps every audit gate ENFORCING (no continue-on-error)', () => {
    const blocks = stepBlocks(ciYaml)
    const softFailedAudits = blocks.filter(
      (b) =>
        AUDIT_TOKENS.some((t) => t.test(b)) && /continue-on-error:\s*true/.test(b),
    )
    expect(softFailedAudits).toEqual([])
  })
})
