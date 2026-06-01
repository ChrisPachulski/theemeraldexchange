#!/usr/bin/env node
// scripts/autoloop/hotspot.mjs
//
// Defect-HOTSPOT scorer — the autoloop's TARGETING leg. Ranks source files by
// change-frequency × size (the CodeScene/Tornhill hotspot metric). Evidence:
// VCS change-frequency out-predicts any static property of code; relative churn
// predicts fault-prone files ~89% (Nagappan & Ball, ICSE 2005); ~20% of files
// carry ~80% of defects (Walkinshaw & Minku, ESEM 2018); 1-2% of a codebase is
// ~70% of the work (Tornhill). Undirected coverage is a LOCAL OPTIMUM — the loop
// applies its gated work-classes at the TOP of this list instead of spraying
// uniformly. See project_autoloop_value_model_evidence + the lit consultation.
//
// Usage: node scripts/autoloop/hotspot.mjs [repoRoot] [--json]
//   Writes <AUTOLOOP_DIR or repo>/.autoloop/hotspots.json (top N) + prints a table.
//   Env: HOTSPOT_SINCE (default "120 days ago"), HOTSPOT_TOP (default 40).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : process.cwd();
const SINCE = process.env.HOTSPOT_SINCE || '120 days ago';
const TOP = Number(process.env.HOTSPOT_TOP || 40);

const SRC_RE = /^(server|src|crates|recommender)\//;        // where defects we must fix live
const SKIP_RE = /(^|\/)(node_modules|dist|target|\.venv|coverage|__pycache__)\//;
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|rs|py)$/;
const TEST_RE = /(\.test\.|\.spec\.|\.bench\.|(^|\/)tests?\/)/;

function git(args) {
  try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }); }
  catch { return ''; }
}

// change-frequency: # commits touching each eligible file since SINCE
const log = git(['log', `--since=${SINCE}`, '--name-only', '--pretty=format:']);
const revs = new Map();
for (const raw of log.split('\n')) {
  const f = raw.trim();
  if (!f || !SRC_RE.test(f) || SKIP_RE.test(f) || !CODE_EXT.test(f)) continue;
  revs.set(f, (revs.get(f) || 0) + 1);
}

// size (LoC) of the CURRENT file; skip files that no longer exist
const rows = [];
for (const [f, rev] of revs) {
  const abs = path.join(repoRoot, f);
  if (!existsSync(abs)) continue;
  let loc = 0;
  try { loc = readFileSync(abs, 'utf8').split('\n').length; } catch { continue; }
  if (loc < 1) continue;
  const isTest = TEST_RE.test(f);
  // Tornhill hotspot = revisions × LoC. De-weight tests to 0.25 — they are where
  // we ADD work, not where the defects we must FIX concentrate — but keep visible.
  const score = Math.round(rev * loc * (isTest ? 0.25 : 1));
  rows.push({ file: f, revisions: rev, loc, isTest, score });
}
rows.sort((a, b) => b.score - a.score);
const top = rows.slice(0, TOP);

const autoloopDir = process.env.AUTOLOOP_DIR || path.join(repoRoot, '.autoloop');
try {
  mkdirSync(autoloopDir, { recursive: true });
  writeFileSync(path.join(autoloopDir, 'hotspots.json'),
    JSON.stringify({ since: SINCE, computedAt: new Date().toISOString(), count: top.length, top }, null, 2));
} catch { /* best-effort */ }

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(top, null, 2) + '\n');
} else {
  console.log(`hotspots (rev×loc, since "${SINCE}") — top ${Math.min(15, top.length)} of ${top.length}:`);
  for (const r of top.slice(0, 15)) {
    console.log(`  ${String(r.score).padStart(7)}  rev=${String(r.revisions).padStart(3)} loc=${String(r.loc).padStart(5)} ${r.isTest ? '[test] ' : '       '}${r.file}`);
  }
}
