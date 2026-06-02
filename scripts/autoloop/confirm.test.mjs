// scripts/autoloop/confirm.test.mjs
//
// Pins backlog V1.1 ("Plausible != Valid in the skeptic"): a green gate alone
// (plausible) must NOT confirm a change; confirmation requires the skeptic to
// assert VALIDITY with a rationale. Run: `node --test scripts/autoloop/confirm.test.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isConfirmed, confirmationReason } from './confirm.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const VALID = { valid: true, validityRationale: 'predicate matches the spec; tests exercise the real branch' };

test('CONFIRMED: green gate + valid skeptic + rationale', () => {
  assert.equal(isConfirmed({ test: { ok: true }, skeptic: VALID }), true);
});

test('NOT confirmed: plausible-but-invalid (green gate, skeptic valid=false)', () => {
  // The core V1.1 invariant: a passing gate is PLAUSIBLE, not VALID.
  assert.equal(
    isConfirmed({ test: { ok: true }, skeptic: { plausible: true, valid: false, validityRationale: 'tests rubber-stamp the code' } }),
    false,
  );
});

test('NOT confirmed: skeptic asserts valid=true but gives NO rationale (unsupported)', () => {
  assert.equal(isConfirmed({ test: { ok: true }, skeptic: { valid: true } }), false);
  assert.equal(isConfirmed({ test: { ok: true }, skeptic: { valid: true, validityRationale: '   ' } }), false);
});

test('NOT confirmed: gate not green, even if skeptic says valid', () => {
  assert.equal(isConfirmed({ test: { ok: false }, skeptic: VALID }), false);
});

test('NOT confirmed: legacy/old shape with only `ok` (no `valid`) does not confirm', () => {
  // Guards against the pre-V1.1 behavior (confirmed = test.ok && skeptic.ok).
  assert.equal(isConfirmed({ test: { ok: true }, skeptic: { ok: true } }), false);
});

test('NOT confirmed: empty/undefined inputs', () => {
  assert.equal(isConfirmed(), false);
  assert.equal(isConfirmed({}), false);
  assert.equal(isConfirmed({ test: {}, skeptic: {} }), false);
});

test('confirmationReason explains each branch', () => {
  assert.match(confirmationReason({ test: { ok: false } }), /not green/i);
  assert.match(confirmationReason({ test: { ok: true }, skeptic: { valid: false } }), /PLAUSIBLE.*not assert VALIDITY|green is not correct/i);
  assert.match(confirmationReason({ test: { ok: true }, skeptic: { valid: true } }), /without a validity rationale/i);
  assert.match(confirmationReason({ test: { ok: true }, skeptic: VALID }), /^CONFIRMED:/);
});

// --- DRIFT GUARD: the sandbox forbids `import`, so mesh.workflow.mjs carries an
// inline twin of this predicate. Pin it to the V1.1 invariant so a future edit
// cannot silently revert confirmation to the pre-V1.1 `skeptic.ok` semantics.
test('mesh.workflow.mjs inline twin gates confirmation on skeptic.valid (not skeptic.ok)', () => {
  const src = readFileSync(path.join(HERE, 'mesh.workflow.mjs'), 'utf8');
  // The confirmed computation must reference the VALIDITY field...
  assert.match(src, /skeptic\.valid/, 'mesh.workflow.mjs must gate confirmation on skeptic.valid');
  // ...and must NOT confirm on `skeptic.ok` alone (the pre-V1.1 false-green path).
  assert.doesNotMatch(
    src,
    /confirmed:\s*!!\(\s*test\s*&&\s*test\.ok\s*&&\s*skeptic\s*&&\s*skeptic\.ok\s*\)/,
    'mesh.workflow.mjs still uses the pre-V1.1 confirmed = test.ok && skeptic.ok',
  );
});
