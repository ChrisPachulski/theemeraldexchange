import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

// Regression guard for the supply-chain dependency-audit CI job.
//
// CI YAML has no native unit-test harness, so the "test" for this
// workflow change is a runnable assertion that the gate exists and is
// wired correctly — in particular that the three ecosystem audit steps
// stay BLOCKING (no continue-on-error), the #1 way this gate silently
// rots. We also pin the Rust toolchain ('1.90') so it can't drift to a
// floating `stable`/`latest`.
//
// The `yaml` package is not a resolvable dependency in this repo, so we
// parse the raw workflow string with a tolerant indentation-aware reader
// rather than a full YAML parser. This is intentionally permissive: it
// only needs to locate jobs/steps and read a few scalar keys.

const __dirname = dirname(fileURLToPath(import.meta.url))
const CI_PATH = resolve(__dirname, '../../.github/workflows/ci.yml')
const raw = readFileSync(CI_PATH, 'utf8')

/** Indentation (in spaces) of a line, ignoring tabs (file uses spaces). */
function indentOf(line: string): number {
  const m = line.match(/^( *)/)
  return m ? m[1].length : 0
}

/**
 * Extract the lines belonging to a top-level `jobs:` entry by name,
 * i.e. everything indented deeper than the `<name>:` key until the next
 * sibling at the same indent.
 */
function extractJobBlock(name: string): string[] | null {
  const lines = raw.split('\n')
  // Find the `jobs:` section.
  const jobsIdx = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  if (jobsIdx === -1) return null
  // Job keys are indented one level under `jobs:`. Find the named job.
  let startIdx = -1
  let jobIndent = -1
  for (let i = jobsIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const ind = indentOf(line)
    if (ind === 0) break // left the jobs: section entirely
    const m = line.match(/^( +)([A-Za-z0-9_-]+):\s*$/)
    if (m && m[2] === name) {
      startIdx = i
      jobIndent = ind
      break
    }
  }
  if (startIdx === -1) return null
  const block: string[] = []
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') {
      block.push(line)
      continue
    }
    if (indentOf(line) <= jobIndent) break // next sibling job or section
    block.push(line)
  }
  return block
}

/**
 * Split a job block's `steps:` list into per-step text chunks. Each step
 * starts with a `- ` bullet at the steps-item indent level.
 */
function extractSteps(jobBlock: string[]): string[] {
  const stepsIdx = jobBlock.findIndex((l) => /^\s*steps:\s*$/.test(l))
  if (stepsIdx === -1) return []
  const stepLines = jobBlock.slice(stepsIdx + 1)
  // Determine bullet indent from the first `- ` line.
  const firstBullet = stepLines.find((l) => /^\s*- /.test(l))
  if (!firstBullet) return []
  const bulletIndent = indentOf(firstBullet)
  const steps: string[] = []
  let current: string[] = []
  for (const line of stepLines) {
    if (line.trim() === '') {
      if (current.length) current.push(line)
      continue
    }
    const ind = indentOf(line)
    if (ind < bulletIndent && line.trim() !== '') break // left the steps list
    if (ind === bulletIndent && /^\s*- /.test(line)) {
      if (current.length) steps.push(current.join('\n'))
      current = [line]
    } else {
      current.push(line)
    }
  }
  if (current.length) steps.push(current.join('\n'))
  return steps
}

const jobBlock = extractJobBlock('dependency-audit')
const steps = jobBlock ? extractSteps(jobBlock) : []

/** Find the step text whose `run:` (single or multiline) contains `needle`. */
function stepContainingRun(needle: string): string | undefined {
  return steps.find((s) => {
    const runIdx = s.indexOf('run:')
    if (runIdx === -1) return false
    // Consider the whole step text after `run:` — covers both inline and
    // block (`run: |`) scalar forms.
    return s.slice(runIdx).includes(needle)
  })
}

/** Whether a step chunk declares `continue-on-error: true`. */
function hasContinueOnError(step: string): boolean {
  return /continue-on-error:\s*true/.test(step)
}

describe('CI dependency-audit job', () => {
  it('defines a dependency-audit job', () => {
    expect(jobBlock, 'jobs[dependency-audit] missing from ci.yml').not.toBeNull()
    expect(steps.length).toBeGreaterThan(0)
  })

  it('has a blocking npm audit (high+) gating step', () => {
    const step = stepContainingRun('npm audit')
    expect(step, 'no step runs `npm audit`').toBeDefined()
    expect(step!).toContain('--audit-level=high')
    // The gating step (with --omit=dev, no --json) must stay blocking.
    const gating = steps.find(
      (s) =>
        s.includes('npm audit') &&
        s.includes('--audit-level=high') &&
        !s.includes('--json'),
    )
    expect(gating, 'gating npm audit step not found').toBeDefined()
    expect(hasContinueOnError(gating!)).toBe(false)
  })

  it('has a blocking cargo audit gating step', () => {
    const step = stepContainingRun('cargo audit')
    expect(step, 'no step runs `cargo audit`').toBeDefined()
    expect(hasContinueOnError(step!)).toBe(false)
  })

  it('has a blocking pip-audit gating step', () => {
    const step = stepContainingRun('pip-audit')
    expect(step, 'no step runs `pip-audit`').toBeDefined()
    expect(hasContinueOnError(step!)).toBe(false)
  })

  it('uploads the npm-audit.json report with if: always()', () => {
    const upload = steps.find(
      (s) => s.includes('upload-artifact') && s.includes('npm-audit.json'),
    )
    expect(upload, 'npm-audit.json artifact upload missing').toBeDefined()
    expect(upload!).toMatch(/if:\s*always\(\)/)
  })

  it('pins the cargo toolchain to 1.90 (no drift to floating stable)', () => {
    // dependency-audit cargo step pins 1.90 …
    expect(jobBlock!.join('\n')).toMatch(/toolchain:\s*'1\.90'/)
    // … and the existing `rust` job still pins the same (surviving half of
    // the Rust-pinning survivor turned into a regression guard).
    const rustJob = extractJobBlock('rust')
    expect(rustJob, 'rust job missing').not.toBeNull()
    expect(rustJob!.join('\n')).toMatch(/toolchain:\s*'1\.90'/)
  })
})
