// scripts/autoloop/confirm.test.mjs
//
// Pins backlog V1.1 ("Plausible != Valid in the skeptic"): a green gate alone
// (plausible) must NOT confirm a change; confirmation requires the skeptic to
// assert VALIDITY with a rationale. Pins V1.2 (REGRESSION GUARD): PASS_TO_PASS +
// FAIL_TO_PASS are first-class gates. Pins V1.3 (MEASURED-DELTA): a green gate
// with no concrete measured improvement is speculative and does not confirm.
// Run: `node --test scripts/autoloop/confirm.test.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isConfirmed, confirmationReason } from './confirm.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const VALID = { valid: true, validityRationale: 'predicate matches the spec; tests exercise the real branch' };
const DELTA = { delta: 'test X now passes' };

// V1.3: A full-confirmation result must have gate green + regression guard (PASS_TO_PASS + FAIL_TO_PASS) + valid skeptic + rationale + measured delta
const FULL_PASS = {
  test: { ok: true, passToPass: true, failToPass: true },
  skeptic: VALID,
  fix: DELTA,
};

test('CONFIRMED (V1.3): gate green + passToPass=true + failToPass=true + valid skeptic + rationale + measured delta', () => {
  assert.equal(isConfirmed(FULL_PASS), true);
});

test('NOT confirmed: REGRESSION DETECTED (V1.2) — passToPass=false (pre-existing tests broke)', () => {
  // A change that makes the new test pass but silently breaks a pre-existing test is NOT confirmed.
  // This is the core V1.2 invariant: PASS_TO_PASS is a first-class gate.
  assert.equal(
    isConfirmed({
      test: { ok: true, passToPass: false, failToPass: true },
      skeptic: VALID,
      fix: DELTA,
    }),
    false,
  );
});

test('NOT confirmed: MISSING NEW TEST (V1.2) — failToPass=false (new test did not go red→green)', () => {
  // The change must ADD and PASS a new test; absence of FAIL_TO_PASS blocks confirmation.
  assert.equal(
    isConfirmed({
      test: { ok: true, passToPass: true, failToPass: false },
      skeptic: VALID,
      fix: DELTA,
    }),
    false,
  );
});

test('NOT confirmed: FAIL_TO_PASS as empty string (V1.2 — must be truthy)', () => {
  // failToPass must be true or a non-empty description; empty string does not pass.
  assert.equal(
    isConfirmed({
      test: { ok: true, passToPass: true, failToPass: '' },
      skeptic: VALID,
      fix: DELTA,
    }),
    false,
  );
});

test('CONFIRMED (V1.2): FAIL_TO_PASS as non-empty string (new test description)', () => {
  // failToPass can be a string description of the new test that went red→green.
  assert.equal(
    isConfirmed({
      test: { ok: true, passToPass: true, failToPass: 'regression guard test now passes' },
      skeptic: VALID,
      fix: DELTA,
    }),
    true,
  );
});

test('NOT confirmed: plausible-but-invalid (green gate, skeptic valid=false)', () => {
  // The core V1.1 invariant: a passing gate is PLAUSIBLE, not VALID.
  // Even with V1.2 regression guard passing, missing VALIDITY blocks confirmation.
  assert.equal(
    isConfirmed({
      test: { ok: true, passToPass: true, failToPass: true },
      skeptic: { plausible: true, valid: false, validityRationale: 'tests rubber-stamp the code' },
      fix: DELTA,
    }),
    false,
  );
});

test('NOT confirmed: skeptic asserts valid=true but gives NO rationale (unsupported)', () => {
  assert.equal(
    isConfirmed({
      test: { ok: true, passToPass: true, failToPass: true },
      skeptic: { valid: true },
      fix: DELTA,
    }),
    false,
  );
  assert.equal(
    isConfirmed({
      test: { ok: true, passToPass: true, failToPass: true },
      skeptic: { valid: true, validityRationale: '   ' },
      fix: DELTA,
    }),
    false,
  );
});

test('NOT confirmed: gate not green, even if skeptic says valid and regression guard passes', () => {
  assert.equal(
    isConfirmed({
      test: { ok: false, passToPass: true, failToPass: true },
      skeptic: VALID,
      fix: DELTA,
    }),
    false,
  );
});

test('NOT confirmed: legacy/old shape with only `ok` (no regression guard fields) does not confirm', () => {
  // Guards against the pre-V1.2 behavior (regression guard not checked).
  assert.equal(isConfirmed({ test: { ok: true }, skeptic: VALID, fix: DELTA }), false);
});

test('NOT confirmed: empty/undefined inputs', () => {
  assert.equal(isConfirmed(), false);
  assert.equal(isConfirmed({}), false);
  assert.equal(isConfirmed({ test: {}, skeptic: {}, fix: {} }), false);
});

test('NOT confirmed: V1.3 ASSURED-IMPROVEMENT — no delta (gate green + V1.2 regression guard passed + skeptic valid)', () => {
  // V1.3: plausible + valid + regression-guard-passed is still not confirmed without a measured delta.
  // This is the gate that prevents landing speculative changes: green alone is insufficient.
  assert.equal(
    isConfirmed({
      test: { ok: true, passToPass: true, failToPass: true },
      skeptic: VALID,
      // NO fix.delta — should NOT confirm even though everything else passes
    }),
    false,
  );
});

test('NOT confirmed: V1.3 — delta is empty string (must be truthy)', () => {
  // An empty or whitespace-only delta does not count.
  assert.equal(
    isConfirmed({
      test: { ok: true, passToPass: true, failToPass: true },
      skeptic: VALID,
      fix: { delta: '' },
    }),
    false,
  );
  assert.equal(
    isConfirmed({
      test: { ok: true, passToPass: true, failToPass: true },
      skeptic: VALID,
      fix: { delta: '   ' },
    }),
    false,
  );
});

test('CONFIRMED: V1.3 ASSURED-IMPROVEMENT — all gates pass including measured delta', () => {
  // V1.3: gate green + regression guard + skeptic valid + measured delta = confirmed.
  assert.equal(
    isConfirmed({
      test: { ok: true, passToPass: true, failToPass: true },
      skeptic: VALID,
      fix: { delta: 'test X now passes red→green' },
    }),
    true,
  );
  assert.equal(
    isConfirmed({
      test: { ok: true, passToPass: true, failToPass: 'new test: coverage increased 34% → 56%' },
      skeptic: VALID,
      fix: { delta: 'coverage on hotspot-file.ts increased 22pp (34% → 56%)' },
    }),
    true,
  );
  assert.equal(
    isConfirmed({
      test: { ok: true, passToPass: true, failToPass: true },
      skeptic: VALID,
      fix: { delta: 'mutant #7 (null-deref) now killed' },
    }),
    true,
  );
});

test('confirmationReason explains each V1.2 regression-guard branch', () => {
  assert.match(confirmationReason({ test: { ok: false } }), /not green/i);
  assert.match(
    confirmationReason({ test: { ok: true, passToPass: false }, fix: DELTA }),
    /regression detected.*pre-existing/i,
  );
  assert.match(
    confirmationReason({ test: { ok: true, passToPass: true, failToPass: false }, fix: DELTA }),
    /new test.*red→green.*FAIL_TO_PASS/i,
  );
  assert.match(
    confirmationReason({
      test: { ok: true, passToPass: true, failToPass: true },
      skeptic: { valid: false },
      fix: DELTA,
    }),
    /VALIDITY|green is not correct/i,
  );
  assert.match(
    confirmationReason({
      test: { ok: true, passToPass: true, failToPass: true },
      skeptic: { valid: true },
      fix: DELTA,
    }),
    /without a validity rationale/i,
  );
  assert.match(
    confirmationReason({ test: { ok: true, passToPass: true, failToPass: true }, skeptic: VALID, fix: DELTA }),
    /^CONFIRMED:/,
  );
});

test('confirmationReason explains V1.3 measured-delta gate', () => {
  // Without a measured delta, reason should explain it's speculative.
  assert.match(
    confirmationReason({
      test: { ok: true, passToPass: true, failToPass: true },
      skeptic: VALID,
      // NO fix.delta
    }),
    /NO MEASURED DELTA.*speculative|V1\.3/i,
  );

  // With an empty delta, still not confirmed.
  assert.match(
    confirmationReason({
      test: { ok: true, passToPass: true, failToPass: true },
      skeptic: VALID,
      fix: { delta: '' },
    }),
    /NO MEASURED DELTA.*speculative|V1\.3/i,
  );

  // With a non-empty delta, confirmed.
  assert.match(
    confirmationReason({
      test: { ok: true, passToPass: true, failToPass: true },
      skeptic: VALID,
      fix: { delta: 'test now passes' },
    }),
    /^CONFIRMED:.*test now passes/,
  );
});

test('NOT confirmed: V1.3 ASSURED-IMPROVEMENT — no delta (gate green + V1.2 regression guard passed + skeptic valid)', () => {
  // V1.3: plausible + valid + regression-guard-passed is still not confirmed without a measured delta.
  // This is the gate that prevents landing speculative changes: green alone is insufficient.
  assert.equal(
    isConfirmed({
      test: { ok: true, passToPass: true, failToPass: true },
      skeptic: VALID,
      // NO fix.delta — should NOT confirm even though everything else passes
    }),
    false,
  );
});

test('NOT confirmed: V1.3 — delta is empty string (must be truthy)', () => {
  // An empty or whitespace-only delta does not count.
  assert.equal(
    isConfirmed({
      test: { ok: true, passToPass: true, failToPass: true },
      skeptic: VALID,
      fix: { delta: '' },
    }),
    false,
  );
  assert.equal(
    isConfirmed({
      test: { ok: true, passToPass: true, failToPass: true },
      skeptic: VALID,
      fix: { delta: '   ' },
    }),
    false,
  );
});

test('CONFIRMED: V1.3 ASSURED-IMPROVEMENT — all gates pass including measured delta', () => {
  // V1.3: gate green + regression guard + skeptic valid + measured delta = confirmed.
  assert.equal(
    isConfirmed({
      test: { ok: true, passToPass: true, failToPass: true },
      skeptic: VALID,
      fix: { delta: 'test X now passes red→green' },
    }),
    true,
  );
  assert.equal(
    isConfirmed({
      test: { ok: true, passToPass: true, failToPass: 'new test: coverage increased 34% → 56%' },
      skeptic: VALID,
      fix: { delta: 'coverage on hotspot-file.ts increased 22pp (34% → 56%)' },
    }),
    true,
  );
  assert.equal(
    isConfirmed({
      test: { ok: true, passToPass: true, failToPass: true },
      skeptic: VALID,
      fix: { delta: 'mutant #7 (null-deref) now killed' },
    }),
    true,
  );
});

test('confirmationReason explains V1.3 measured-delta gate', () => {
  // Without a measured delta, reason should explain it's speculative.
  assert.match(
    confirmationReason({
      test: { ok: true, passToPass: true, failToPass: true },
      skeptic: VALID,
      // NO fix.delta
    }),
    /NO MEASURED DELTA.*speculative|V1\.3/i,
  );

  // With an empty delta, still not confirmed.
  assert.match(
    confirmationReason({
      test: { ok: true, passToPass: true, failToPass: true },
      skeptic: VALID,
      fix: { delta: '' },
    }),
    /NO MEASURED DELTA.*speculative|V1\.3/i,
  );

  // With a non-empty delta, confirmed.
  assert.match(
    confirmationReason({
      test: { ok: true, passToPass: true, failToPass: true },
      skeptic: VALID,
      fix: { delta: 'test now passes' },
    }),
    /^CONFIRMED:.*test now passes/,
  );
});


// --- DRIFT GUARD: the sandbox forbids `import`, so mesh.workflow.mjs carries an
// inline twin of this predicate. Pin it to the V1.2 and V1.3 invariants so a future edit
// cannot silently revert confirmation to pre-V1.2 (missing regression guard checks) or
// pre-V1.3 (missing measured-delta gate).
test('mesh.workflow.mjs inline twin gates confirmation on V1.2+V1.3 (regression guard + measured delta)', () => {
  const src = readFileSync(path.join(HERE, 'mesh.workflow.mjs'), 'utf8');
  // The confirmed computation must reference BOTH regression-guard dimensions...
  assert.match(src, /test\.passToPass/, 'mesh.workflow.mjs must gate confirmation on test.passToPass (V1.2)');
  assert.match(src, /test\.failToPass/, 'mesh.workflow.mjs must gate confirmation on test.failToPass (V1.2)');
  // ...and must also check skeptic.valid (the V1.1 dimension)...
  assert.match(src, /skeptic\.valid/, 'mesh.workflow.mjs must gate confirmation on skeptic.valid (V1.1)');
  // ...and must also check fix.delta (the V1.3 assured-improvement dimension)...
  assert.match(src, /fix\.delta/, 'mesh.workflow.mjs must gate confirmation on fix.delta (V1.3)');
  // ...and must also check fix.delta (the V1.3 assured-improvement dimension)...
  assert.match(src, /fix\.delta/, 'mesh.workflow.mjs must gate confirmation on fix.delta (V1.3)');
  // ...and must NOT confirm with only test.ok (the pre-V1.2 false-green path).
  assert.doesNotMatch(
    src,
    /confirmed:\s*!!\(\s*test\s*&&\s*test\.ok\s*&&\s*skeptic\s*&&\s*skeptic\.valid\s*\)/,
    'mesh.workflow.mjs must include regression-guard checks (not just test.ok && skeptic.valid)',
  );
});
