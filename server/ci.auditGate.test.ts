import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Pins the supply-chain audit gate contract so a future loop iteration
// cannot silently weaken it (downgrade npm to all-deps/low, or remove a
// gate). String assertions — `yaml` is not a project dependency.
const ciPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.github',
  'workflows',
  'ci.yml',
);
const ci = readFileSync(ciPath, 'utf8');

/** Extract the `audit:` job block (from its header to the next top-level job). */
function auditJobBlock(yaml: string): string {
  const start = yaml.indexOf('\n  audit:\n');
  expect(start).toBeGreaterThan(-1);
  // Next top-level (2-space-indented) job header after the audit one.
  const rest = yaml.slice(start + 1);
  const nextJob = rest.slice(1).search(/\n {2}[a-zA-Z][\w-]*:\n/);
  return nextJob === -1 ? rest : rest.slice(0, nextJob + 1);
}

describe('CI audit gate (.github/workflows/ci.yml)', () => {
  it('(a) defines a job named `audit`', () => {
    expect(ci).toMatch(/\n {2}audit:\n/);
  });

  it('(b) runs npm audit with --omit=dev AND --audit-level=high on the same step', () => {
    const block = auditJobBlock(ci);
    const npmLine = block
      .split('\n')
      .find((l) => /run:\s*npm audit/.test(l));
    expect(npmLine, 'expected an `npm audit` run line').toBeDefined();
    expect(npmLine).toContain('--omit=dev');
    expect(npmLine).toContain('--audit-level=high');
  });

  it('(c) runs cargo audit', () => {
    expect(auditJobBlock(ci)).toMatch(/\bcargo audit\b/);
  });

  it('(d) runs pip-audit', () => {
    expect(auditJobBlock(ci)).toMatch(/\bpip-audit\b/);
  });

  it('(e) keeps the npm audit gate HARD (no continue-on-error on that step)', () => {
    const block = auditJobBlock(ci);
    // Isolate the npm-audit step: from its `- name:` to the next step.
    const steps = block.split(/\n {6}- /);
    const npmStep = steps.find((s) => s.includes('npm audit'));
    expect(npmStep, 'expected to locate the npm audit step').toBeDefined();
    expect(npmStep).not.toContain('continue-on-error: true');
  });
});
