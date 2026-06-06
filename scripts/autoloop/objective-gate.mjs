// scripts/autoloop/objective-gate.mjs
//
// Pure predicate for the mesh's DETERMINISTIC OBJECTIVE GATE.
//
// Problem it kills ("#1"): when the driver hands the mesh a specific backlog item
// (PRIMARY_OBJECTIVE / merit-state topOpen), free-roam discovery has twice ignored the
// prose steer and returned invented trivia (mechanical lint cleanup), forcing the driver
// to rescue the window by hand. Prose steering is advisory; an LLM synth has ignored it.
//
// The structural cure is two-part and BOTH live deterministically in mesh.workflow.mjs:
//   1. In OBJECTIVE MODE the discoverable classes collapse to {signal-fix, objective} —
//      so the forest has no trivial candidate to surface in the first place.
//   2. This gate is the belt-and-suspenders: even if the synth schema lets a stray
//      class through, a landed pick MUST be 'objective' (implements the assigned item)
//      or 'signal-fix' (a reproduced red preempts — always higher-merit). Anything else
//      abstains to a dry window. With an objective set, the mesh implements it or does
//      nothing; it can NEVER hand back busywork.
//
// mesh.workflow.mjs runs in a restricted sandbox that forbids `import`, so it carries an
// INLINE TWIN of this rule; objective-gate.test.mjs pins the twin to this module (drift
// guard) so the two never diverge — same discipline as confirm.mjs / isConfirmed.

// The only classes that may LAND when a primary objective is set.
export const OBJECTIVE_ALLOWED = ['objective', 'signal-fix'];

/**
 * Should this pick be REJECTED (abstain to dry) because it drifted off the objective?
 *
 *   - objectiveMode === false  → no objective set; any class is fine → never off-objective.
 *   - objectiveMode === true   → only 'objective' or 'signal-fix' may land; everything
 *                                else (mechanical/gated-test/devex/dep-hygiene/unknown/
 *                                missing) is OFF-OBJECTIVE and must NOT commit.
 *
 * @param {{ objectiveMode?: boolean, pickClass?: string }} [r]
 * @returns {boolean} true ⇒ reject the pick (drift); false ⇒ allowed to proceed.
 */
export function isOffObjective(r = {}) {
  const { objectiveMode, pickClass } = r;
  if (!objectiveMode) return false;
  return !OBJECTIVE_ALLOWED.includes(pickClass);
}
