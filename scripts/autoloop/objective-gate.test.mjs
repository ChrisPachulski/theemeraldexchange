// scripts/autoloop/objective-gate.test.mjs
// Proves "#1" (mesh drifts to invented trivia under a primary objective) CANNOT recur,
// and pins the mesh.workflow.mjs inline twin to objective-gate.mjs (drift guard).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isOffObjective, OBJECTIVE_ALLOWED } from './objective-gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('no objective set → any class is allowed (never off-objective)', () => {
  for (const c of ['mechanical', 'gated-test', 'devex', 'dep-hygiene', 'objective', 'signal-fix', undefined]) {
    assert.equal(isOffObjective({ objectiveMode: false, pickClass: c }), false);
  }
});

test('objective set → "objective" pick is allowed', () => {
  assert.equal(isOffObjective({ objectiveMode: true, pickClass: 'objective' }), false);
});

test('objective set → "signal-fix" preempts and is allowed', () => {
  assert.equal(isOffObjective({ objectiveMode: true, pickClass: 'signal-fix' }), false);
});

test('objective set → trivial classes are REJECTED (the #1 cure)', () => {
  for (const c of ['mechanical', 'gated-test', 'devex', 'dep-hygiene']) {
    assert.equal(isOffObjective({ objectiveMode: true, pickClass: c }), true, `${c} must be rejected`);
  }
});

test('objective set → missing/unknown class is REJECTED (default-deny)', () => {
  assert.equal(isOffObjective({ objectiveMode: true, pickClass: undefined }), true);
  assert.equal(isOffObjective({ objectiveMode: true, pickClass: 'whatever' }), true);
  assert.equal(isOffObjective({ objectiveMode: true }), true);
});

test('allowed set is exactly {objective, signal-fix}', () => {
  assert.deepEqual([...OBJECTIVE_ALLOWED].sort(), ['objective', 'signal-fix']);
});

// ---- DRIFT GUARD: the mesh's inline twin must enforce the same rule ----
test('mesh.workflow.mjs collapses classes + gates on the same allowed set', () => {
  const mesh = readFileSync(join(HERE, 'mesh.workflow.mjs'), 'utf8');
  // (1) OBJECTIVE MODE must exist and collapse the discoverable class set.
  assert.match(mesh, /OBJECTIVE_MODE/, 'mesh must define OBJECTIVE_MODE');
  assert.match(mesh, /key:\s*'objective'/, 'mesh must offer the synthetic "objective" class');
  // (2) The deterministic gate must reject anything that is not objective or signal-fix.
  assert.match(
    mesh,
    /OBJECTIVE_MODE\s*&&\s*pick\.class\s*!==\s*'objective'\s*&&\s*pick\.class\s*!==\s*'signal-fix'/,
    'mesh inline objective gate must allow ONLY objective + signal-fix (drift from objective-gate.mjs)',
  );
  // (3) A rejected pick must abstain (off_objective), never fall through to execute.
  assert.match(mesh, /action:\s*'off_objective'/, 'mesh must return off_objective on drift, not commit');
});
