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
 *   - the gate is green        (test.ok === true)            — PLAUSIBLE, and
 *   - the skeptic asserts VALID (skeptic.valid === true)     — semantically correct, and
 *   - the skeptic backs validity with a concrete rationale   (non-empty validityRationale).
 *
 * Note the asymmetry from the evidence: `skeptic.ok` / `plausible` alone is NOT
 * sufficient — a plausible-but-invalid change (green gate, but the skeptic finds
 * the tests rubber-stamp the code or the change is semantically wrong) must NOT
 * confirm. Missing/undefined `valid` is treated as NOT valid (default-false skew).
 *
 * @param {{ test?: { ok?: boolean }, skeptic?: { valid?: boolean, validityRationale?: string } }} [r]
 * @returns {boolean}
 */
export function isConfirmed(r = {}) {
  const { test, skeptic } = r;
  const gateGreen = test?.ok === true;
  const valid = skeptic?.valid === true;
  const rationale = hasRationale(skeptic?.validityRationale);
  return gateGreen && valid && rationale;
}

/**
 * Human-readable reason for the confirm/no-confirm decision — for the
 * iteration-log / value-ledger so a dry/abstained window is auditable.
 *
 * @param {{ test?: { ok?: boolean }, skeptic?: { plausible?: boolean, valid?: boolean, validityRationale?: string } }} [r]
 * @returns {string}
 */
export function confirmationReason(r = {}) {
  const { test, skeptic } = r;
  if (test?.ok !== true) return 'NOT confirmed: gate not green (not even plausible).';
  if (skeptic?.valid !== true) {
    return 'NOT confirmed: gate green (PLAUSIBLE) but skeptic did not assert VALIDITY — green is not correct.';
  }
  if (!hasRationale(skeptic?.validityRationale)) {
    return 'NOT confirmed: skeptic claimed valid=true without a validity rationale (unsupported assertion).';
  }
  return `CONFIRMED: gate green AND skeptic asserts validity — ${skeptic.validityRationale.trim()}`;
}
