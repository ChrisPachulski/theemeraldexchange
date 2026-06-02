#!/usr/bin/env node
// scripts/autoloop/self-cap.mjs
//
// CONTROLLED-GAUGING CAP for an autonomous improvement run. A self-improving loop
// must not run open-ended — you gauge a SMALL batch of changes, then it HALTS for
// review before doing more. This is a CODE-enforced cap (not a prompt instruction
// the LLM could skip): the self-driver runs it FIRST each window, and when the cap
// is reached it writes a review report, trips STOP, and flips MASTER: OFF — so the
// loop stops even if the driver misbehaves (defense in depth; CLAUDE.md kill-switch
// rule; the two-gate "bounded improvement space" guardrail, arXiv:2510.04399).
//
// Caps (read from <controlDir>/CONTROL.md control block):
//   MAX_IMPROVEMENTS — confirmed commits landed since the baseline (default 3)
//   MAX_WINDOWS      — total windows run this batch (default 6)
// Whichever trips first halts the batch. Baseline = HEAD recorded on first run in
// <controlDir>/cap-baseline.txt; delete that file (or the review file) to start a
// fresh gauged batch after you've reviewed.
//
// Usage: node scripts/autoloop/self-cap.mjs <controlDir> <worktreeDir>
// Prints JSON {action:'go'|'stop', reason, improvements, windows, caps, remaining}.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const controlDir = process.argv[2] || path.join(process.cwd(), '.autoloop-self');
const worktree = process.argv[3] || process.cwd();
const CONTROL = path.join(controlDir, 'CONTROL.md');
const BASELINE = path.join(controlDir, 'cap-baseline.txt');
const ITERLOG = path.join(controlDir, 'iteration-log.md');
const REVIEW = path.join(controlDir, 'CHECKPOINT-REVIEW.md');
const STOP = path.join(controlDir, 'STOP');

function readControlNum(key, dflt) {
  try {
    const m = readFileSync(CONTROL, 'utf8').match(new RegExp(`^\\s*${key}:\\s*(\\d+)`, 'm'));
    return m ? Number(m[1]) : dflt;
  } catch { return dflt; }
}
function git(args) {
  try { return execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
}
function out(o) { process.stdout.write(JSON.stringify(o, null, 2) + '\n'); }

const MAX_IMPROVEMENTS = readControlNum('MAX_IMPROVEMENTS', 3);
const MAX_WINDOWS = readControlNum('MAX_WINDOWS', 6);

const head = git(['rev-parse', 'HEAD']);
if (!head) { out({ action: 'go', reason: 'no_git_head_skip_cap', improvements: 0, windows: 0 }); process.exit(0); }

// Lifetime window count = '## ' entries in the iteration log (one per window, ever).
const lifetimeWindows = (() => {
  try { return (readFileSync(ITERLOG, 'utf8').match(/^## /gm) || []).length; } catch { return 0; }
})();

// Baseline: record HEAD *and* the lifetime window-count on the first run of a fresh
// batch. cap-baseline.txt = two lines: "<head>\n<windowCountAtBaseline>". Both the
// improvements counter (commits since baseline HEAD) and the windows counter (## entries
// since baseline count) are batch-relative, so deleting cap-baseline.txt fully re-baselines
// BOTH. (Bug fix: windows used to be counted LIFETIME, so any batch started after the log
// had accumulated >= MAX_WINDOWS entries halted instantly at window 1.)
let baseline = '';
let baselineWindows = null;
if (existsSync(BASELINE)) {
  try {
    const lines = readFileSync(BASELINE, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    baseline = lines[0] || '';
    if (lines[1] !== undefined && /^\d+$/.test(lines[1])) baselineWindows = Number(lines[1]);
  } catch {}
}
if (!baseline) {
  baseline = head;
  baselineWindows = lifetimeWindows;
  try { writeFileSync(BASELINE, `${head}\n${lifetimeWindows}\n`); } catch {}
}
// Back-compat: an old single-line baseline file → anchor the window count now (treat the
// current batch as starting from here rather than mis-counting all historical windows).
if (baselineWindows === null) {
  baselineWindows = lifetimeWindows;
  try { writeFileSync(BASELINE, `${baseline}\n${lifetimeWindows}\n`); } catch {}
}

const improvements = Number(git(['rev-list', '--count', `${baseline}..HEAD`]) || '0');
const windows = Math.max(0, lifetimeWindows - baselineWindows);

const capImpr = improvements >= MAX_IMPROVEMENTS;
const capWin = windows >= MAX_WINDOWS;

if (capImpr || capWin) {
  // Enumerate what landed this batch so the human can GAUGE it.
  const commits = git(['log', '--no-merges', '--pretty=format:%h %s', `${baseline}..HEAD`]) || '(none)';
  const reason = capImpr ? `MAX_IMPROVEMENTS (${MAX_IMPROVEMENTS}) reached` : `MAX_WINDOWS (${MAX_WINDOWS}) reached`;
  const review = [
    `# Self-improvement checkpoint — REVIEW REQUIRED`,
    ``,
    `The capped batch is complete: **${reason}**. The loop has HALTED itself for you to gauge.`,
    ``,
    `- improvements landed: **${improvements}** / cap ${MAX_IMPROVEMENTS}`,
    `- windows run: **${windows}** / cap ${MAX_WINDOWS}`,
    `- baseline: \`${baseline.slice(0, 12)}\`  →  HEAD: \`${head.slice(0, 12)}\`  (branch: ${git(['rev-parse', '--abbrev-ref', 'HEAD'])})`,
    ``,
    `## Changes to gauge (review the diff: \`git -C ${worktree} log -p ${baseline.slice(0, 12)}..HEAD\`)`,
    '```',
    commits,
    '```',
    ``,
    `## To continue after review`,
    `1. Review/test the diff above. Promote what you like (e.g. merge \`$(git -C ${worktree} rev-parse --abbrev-ref HEAD)\`).`,
    `2. Start a fresh gauged batch: \`rm ${BASELINE} ${REVIEW}\`, set \`MASTER: ON\`, re-arm.`,
    `   (Deleting cap-baseline.txt re-baselines the cap to the new HEAD.)`,
    ``,
    `_Generated by self-cap.mjs._`,
  ].join('\n');
  try { writeFileSync(REVIEW, review); } catch {}
  try { writeFileSync(STOP, `self-cap: ${reason} @ ${new Date().toISOString()}\n`); } catch {}
  // Flip MASTER: ON -> OFF so no further window arms (defense in depth).
  try {
    const c = readFileSync(CONTROL, 'utf8');
    writeFileSync(CONTROL, c.replace(/^(\s*MASTER:\s*)ON/m, '$1OFF'));
  } catch {}
  out({ action: 'stop', reason: 'cap_reached', detail: reason, improvements, windows,
        caps: { MAX_IMPROVEMENTS, MAX_WINDOWS }, review: REVIEW });
  process.exit(0);
}

out({ action: 'go', improvements, windows, caps: { MAX_IMPROVEMENTS, MAX_WINDOWS },
      remaining: { improvements: MAX_IMPROVEMENTS - improvements, windows: MAX_WINDOWS - windows } });
