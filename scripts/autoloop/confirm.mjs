// scripts/autoloop/confirm.mjs
//
// VERIFICATION predicate for the self-improvement mesh (backlog V1.1:
// "Plausible != Valid in the skeptic"). Production evidence [G1, Passerine @
// Google]: a patch that passes the bug's test is merely PLAUSIBLE; semantic
// correctness ("VALID") is a separate, strictly-lower number (78%->62% SAN,
// 25.6%->17.9% human). GREEN IS NOT CORRECT — so a window's change is only
// `confirmed` when the gate is green AND an adversarial skeptic asserts the
// change is genuinely VALID (semantically correct, tests meaningful) WITH a
// concrete rationale. A green gate alone (plausible) does not confirm.
//
// This module is the CANONICAL, unit-tested home of that predicate. The mesh
// Workflow script (mesh.workflow.mjs) runs in a restricted sandbox that forbids
// `import`, so it carries an INLINE TWIN of `isConfirmed`; confirm.test.mjs pins
// the twin to this implementation (drift guard) so the two never diverge.

/**
 * Is a finite, non-empty rationale string?
 * @param {unknown} s
 * @returns {boolean}
 */
function hasRationale(s) {
  return typeof s === 'string' && s.trim().length > 0;
}

/**
 * A change is CONFIRMED iff:
 *   - the gate is green              (test.ok === true)              — PLAUSIBLE, and
 *   - pre-existing tests stayed green (test.passToPass === true)     — REGRESSION GUARD (V1.2), and
 *   - new tests went red→green        (test.failToPass truthy)       — REGRESSION GUARD (V1.2), and
 *   - the skeptic asserts VALID       (skeptic.valid === true)       — semantically correct, and
 *   - the skeptic backs validity      (non-empty validityRationale)  — with concrete reasoning, and
 *   - a measured delta is present     (fix.delta truthy)             — ASSURED-IMPROVEMENT GATE (V1.3).
 *
 * Note the asymmetry from the evidence [O1 OpenHands/SWE-bench, S1 SWE-agent]: a patch that passes
 * the new test is PLAUSIBLE; regression-free behavior is a separate gate (V1.2 PASS_TO_PASS).
 * A change that makes the new test pass but silently breaks a pre-existing test is NOT confirmed
 * even if the gate goes green. Missing/undefined fields default to NOT confirmed (false skew).
 *
 * Per Google TestGen-LLM (Meta Cinder): land only survivors of measurable-improvement + non-regression
 * filters. A green gate with no measured delta is speculative and lands only on explicit delta assertion.
 *
 * @param {{ test?: { ok?: boolean, passToPass?: boolean, failToPass?: boolean | string }, skeptic?: { valid?: boolean, validityRationale?: string }, fix?: { delta?: string } }} [r]
 * @returns {boolean}
 */
export function isConfirmed(r = {}) {
  const { test, skeptic, fix } = r;
  const gateGreen = test?.ok === true;
  const passToPass = test?.passToPass === true; // pre-existing suite stayed green (V1.2)
  const failToPass = test?.failToPass === true || (typeof test?.failToPass === 'string' && hasRationale(test.failToPass)); // new test red→green (V1.2)
  const valid = skeptic?.valid === true;
  const rationale = hasRationale(skeptic?.validityRationale);
  const delta = hasRationale(fix?.delta); // measured improvement gate (V1.3)
  return gateGreen && passToPass && failToPass && valid && rationale && delta;
}

/**
 * Human-readable reason for the confirm/no-confirm decision — for the
 * iteration-log / value-ledger so a dry/abstained window is auditable.
 *
 * @param {{ test?: { ok?: boolean, passToPass?: boolean, failToPass?: boolean | string }, skeptic?: { plausible?: boolean, valid?: boolean, validityRationale?: string }, fix?: { delta?: string } }} [r]
 * @returns {string}
 */
export function confirmationReason(r = {}) {
  const { test, skeptic, fix } = r;
  if (test?.ok !== true) return 'NOT confirmed: gate not green (not even plausible).';
  const passToPass = test?.passToPass === true;
  const failToPass = test?.failToPass === true || (typeof test?.failToPass === 'string' && hasRationale(test.failToPass));
  if (!passToPass) {
    return 'NOT confirmed: regression detected — pre-existing test suite did not stay green (PASS_TO_PASS failed).';
  }
  if (!failToPass) {
    return 'NOT confirmed: new test did not go red→green (FAIL_TO_PASS failed or missing).';
  }
  if (skeptic?.valid !== true) {
    return 'NOT confirmed: gate green + regression guard passed but skeptic did not assert VALIDITY — green is not correct.';
  }
  if (!hasRationale(skeptic?.validityRationale)) {
    return 'NOT confirmed: skeptic claimed valid=true without a validity rationale (unsupported assertion).';
  }
  if (!hasRationale(fix?.delta)) {
    return 'NOT confirmed: gate green + regression guard passed + skeptic valid but NO MEASURED DELTA — speculative improvement, must assert concrete proof (V1.3).';
  }
  return `CONFIRMED: gate green AND regression guard passed AND skeptic asserts validity AND measured delta present — ${fix.delta.trim()}`;
}
