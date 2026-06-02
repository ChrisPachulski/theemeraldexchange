#!/usr/bin/env node
// merit-state.mjs — decide WHETHER this window should re-ground on the literature,
// and WHICH backlog item is the next impactful pick.
//
// The rule (user-set): literature-consultation is EXPENSIVE (reads PDFs, burns
// context). Do NOT run it every window. Run it only when the loop has EXHAUSTED its
// impactful work and would otherwise drop to low-level invented busywork (ad-hoc lint
// cleanup, coverage padding). That degradation is the signal to go find fresh
// high-value targets. While open backlog items remain, just work them.
//
// "Impactful work" = an un-done item in RESEARCH-BACKLOG.md (every backlog item is, by
// construction, the high-value work; a reproduced signal-fix always outranks it but is
// detected separately by the mesh). "Low-level bullshit" = anything NOT in the backlog
// that the mesh invents because the ladder's bottom rung is always non-empty.
//
// Output (JSON on stdout):
//   { backlogTotal, doneIds, openIds, topOpen, consult, reason }
//   consult=true  -> the driver MUST invoke the literature-consultation Skill this window
//                    to refill the backlog (impactful work is exhausted, or no backlog yet).
//   consult=false -> skip consultation; steer the mesh to work `topOpen` (or a reproduced
//                    signal-fix if discovery surfaces one — that outranks backlog grooming).
//
// Deterministic: the driver "judging merit" is exactly what drifts to trivia, so the
// trigger is code, not vibes — same philosophy as engine-gate / self-cap / the scope gate.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const AUTOLOOP_DIR = process.argv[2] || process.env.AUTOLOOP_DIR;
if (!AUTOLOOP_DIR) {
  console.error('merit-state: AUTOLOOP_DIR required (argv[2] or env)');
  process.exit(2);
}

const read = (name) => {
  const p = join(AUTOLOOP_DIR, name);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

const backlog = read('RESEARCH-BACKLOG.md');
// done-ness is observed from the loop's own record: an item ID that the loop has
// already worked appears in the iteration log (and/or value ledger). Permissive by
// design — if it was attempted-and-failed it lives in dead-ends and we don't re-pick it
// blindly either.
const ledger = read('iteration-log.md') + '\n' + read('value-ledger.md') + '\n' + read('dead-ends.md');

// Backlog item IDs look like **S0.1**, **V1.3**, **P2.2**, **E3.1**, **C4.2**.
const ID_RE = /\*\*([SVPEC]\d+\.\d+)\b/g;
const TIER_ORDER = { S: 0, V: 1, P: 2, E: 3, C: 4 }; // T0 safety → T4 capability

const ids = [];
const seen = new Set();
let m;
while ((m = ID_RE.exec(backlog))) {
  const id = m[1];
  if (!seen.has(id)) { seen.add(id); ids.push(id); }
}

// An ID is "done" ONLY if it appears on a line that ALSO carries an explicit
// completion marker (DONE / CONFIRMED / LANDED). A bare mention does NOT count —
// otherwise prose that merely NAMES the next item to do ("next: V1.1 …") would
// falsely retire it (the claude-guard prose-collision class of bug). Line-scoped,
// word-boundary match so V1.1 doesn't swallow V1.10.
const DONE_MARK = /\b(DONE|CONFIRMED|LANDED)\b/i;
const ledgerLines = ledger.split('\n');
const isDone = (id) => {
  const idRe = new RegExp(`\\b${id.replace('.', '\\.')}\\b`);
  return ledgerLines.some((line) => idRe.test(line) && DONE_MARK.test(line));
};

const doneIds = ids.filter(isDone);
const openIds = ids.filter((id) => !isDone(id));

// Top open item by tier order, then by lexical ID within the tier.
const sortKey = (id) => {
  const tier = TIER_ORDER[id[0]] ?? 9;
  const [maj, min] = id.slice(1).split('.').map(Number);
  return tier * 1e6 + maj * 1e3 + min;
};
const topOpen = openIds.slice().sort((a, b) => sortKey(a) - sortKey(b))[0] || null;

let consult, reason;
if (ids.length === 0) {
  consult = true;
  reason = 'no backlog yet — consult to seed it';
} else if (openIds.length === 0) {
  consult = true;
  reason = `impactful work EXHAUSTED (${doneIds.length}/${ids.length} backlog items done) — re-ground before dropping to invented low-level work`;
} else {
  consult = false;
  reason = `${openIds.length} impactful backlog item(s) still open — work the top one (${topOpen}); do NOT consult, do NOT invent trivia`;
}

console.log(JSON.stringify({
  backlogTotal: ids.length,
  doneIds,
  openIds,
  topOpen,
  consult,
  reason,
}, null, 2));
