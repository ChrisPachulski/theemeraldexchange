#!/usr/bin/env node
// scripts/autoloop/engine-gate.mjs
//
// SELF-MODIFICATION SAFETY GATE (backlog S0.1) — the "never-brick the next window"
// invariant for the self-improvement loop. A loop that edits its OWN running code
// is the highest-runaway-risk mode (Microsoft "defense in depth for autonomous
// agents"; Replit snapshot engine; two-gate monotone-progress guardrail,
// arXiv:2510.04399). Before any engine edit is allowed to land, it MUST parse —
// otherwise the next window loads a broken engine and the loop bricks itself.
//
// Why a dedicated gate (not ci-gate.sh): the engine is .mjs + .sh + .json + .md,
// and the Workflow scripts use TOP-LEVEL await/return that ONLY parse inside the
// runtime's async wrapper — plain `node --check` FALSE-FAILS them with "Illegal
// return statement". This gate validates each file the way it is actually loaded.
//
// Usage:
//   node scripts/autoloop/engine-gate.mjs [dir]          # scan dir (default scripts/autoloop)
//   node scripts/autoloop/engine-gate.mjs --files a b c  # validate an explicit set
// Exit 0 iff every checked file parses; non-zero with a report otherwise.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const argv = process.argv.slice(2);
// --committed = AUTHORITATIVE LAND-GATE mode (run by the driver AFTER it commits): on top
// of the parse check, reject uncommitted scope changes (a partial commit — impl left in the
// working tree while only the test landed — is the failure that shipped a broken HEAD whose
// tests fail) AND run the test suite (a green parse is not a green suite; the old gate only
// parsed, so a test-breaking commit sailed through). Plain mode (no flag) is the mid-window
// tester gate: parse only, dirty tree is expected there.
const COMMITTED = argv.includes('--committed');
let files = [];
let scopeDir = 'scripts/autoloop';
const fi = argv.indexOf('--files');
if (fi !== -1) {
  files = argv.slice(fi + 1).filter((a) => !a.startsWith('--'));
} else {
  scopeDir = argv.find((a) => !a.startsWith('--')) || 'scripts/autoloop';
  files = walk(scopeDir);
}

function walk(dir) {
  const out = [];
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { out.push(...walk(p)); continue; }
    if (/\.(mjs|sh|json)$/.test(e)) out.push(p);
  }
  return out;
}

// A Workflow script is one the mesh loads via the Workflow tool: it legally uses
// top-level await/return + the injected sandbox globals. Detect by the runtime's
// own marker (`export const meta`) rather than by filename, so it's robust.
function isWorkflowScript(src) {
  return /^\s*export\s+const\s+meta\s*=/m.test(src);
}

const SANDBOX_GLOBALS = ['args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow', 'budget'];

const failures = [];
let checked = 0;

for (const f of files) {
  if (!existsSync(f)) continue;
  let src = '';
  try { src = readFileSync(f, 'utf8'); } catch (e) { failures.push([f, `unreadable: ${e.message}`]); continue; }
  checked++;
  const ext = path.extname(f);
  try {
    if (ext === '.json') {
      JSON.parse(src);
    } else if (ext === '.sh') {
      // bash -n = parse without executing.
      execFileSync('bash', ['-n', f], { stdio: 'pipe' });
    } else if (ext === '.mjs') {
      if (isWorkflowScript(src)) {
        // Parse the way the Workflow runtime wraps it: an async fn with the
        // sandbox globals in scope. `new Function` parses without executing.
        const body = src.replace(/^export\s+const\s+meta/m, 'const meta');
         
        new Function(`return (async function(${SANDBOX_GLOBALS.join(',')}){\n${body}\n})`);
      } else {
        // A normal ESM module — node --check is the right parser.
        execFileSync('node', ['--check', f], { stdio: 'pipe' });
      }
    }
  } catch (e) {
    const msg = (e.stderr ? e.stderr.toString() : '') || e.message || String(e);
    failures.push([f, msg.split('\n').slice(0, 4).join(' ').slice(0, 300)]);
  }
}

if (failures.length) {
  console.error(`engine-gate: FAIL — ${failures.length}/${checked} file(s) do not parse:`);
  for (const [f, msg] of failures) console.error(`  ✗ ${f}\n      ${msg}`);
  console.error('engine-gate: an engine edit that fails this gate MUST NOT land (never-brick invariant).');
  process.exit(1);
}
console.log(`engine-gate: OK — ${checked} engine file(s) parse clean (workflow-wrap + node --check + bash -n + json).`);

if (COMMITTED) {
  // (1) No uncommitted changes in scope — the committed state IS what gets tested. A
  //     partial commit (impl left dirty while only the test landed) is rejected here.
  let dirty = '';
  try { dirty = execFileSync('git', ['status', '--porcelain', '--', scopeDir], { encoding: 'utf8' }).trim(); }
  catch (e) { console.error(`engine-gate --committed: cannot read git status: ${e.message}`); process.exit(1); }
  if (dirty) {
    console.error('engine-gate --committed: FAIL — uncommitted changes in scope (the commit is INCOMPLETE):');
    for (const l of dirty.split('\n')) console.error(`  ${l}`);
    console.error('  A green self-report against a dirty tree is not a green COMMIT. Commit (or revert) these, then re-gate.');
    process.exit(1);
  }
  // (2) The test suite must pass on the committed tree — a parse is not a pass.
  const tests = walk(scopeDir).filter((f) => /\.test\.mjs$/.test(f));
  if (tests.length) {
    try {
      execFileSync('node', ['--test', ...tests], { stdio: 'pipe' });
    } catch (e) {
      const out = ((e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : ''));
      const fails = out.split('\n').filter((l) => /^not ok|✖|# fail/.test(l)).slice(0, 8).join('\n');
      console.error(`engine-gate --committed: FAIL — ${tests.length} test file(s) ran, suite is RED on the committed tree:`);
      console.error(fails || out.slice(-600));
      console.error('  The committed state does not pass its own tests. This commit MUST NOT stand.');
      process.exit(1);
    }
    console.log(`engine-gate --committed: OK — clean tree + ${tests.length} test file(s) GREEN on the committed state.`);
  } else {
    console.log('engine-gate --committed: OK — clean tree (no test files in scope to run).');
  }
}
