#!/usr/bin/env node
// scripts/autoloop/signals.mjs
//
// SIGNAL-INGESTION layer — the autoloop's PROACTIVITY leg (repo-AGNOSTIC).
//
// Why this exists: the discovery forest had exactly ONE input modality — Haiku
// leaves SCAN CODE SHAPE per work-class. The top class, `signal-fix` ("a
// REPRODUCED failure that is RED right now"), had NO feed of actual failures, so
// it almost never fired and the loop fell through to `gated-test` (coverage).
// That is the structural reason the loop produces defensive coverage no matter
// how long it runs: it is blind to everything except code shape. This module
// gives the forest a feed of REAL, reproduced, evidence-bearing work items so the
// highest-merit class can actually fire — coverage becomes the floor (signal
// queue dry), not the default.
//
// AGNOSTIC BY CONSTRUCTION:
//   - Built-in adapters work in ANY git repo with zero config (CI health, git
//     regression-risk, TODO/FIXME at hotspots).
//   - Per-repo adapters are drop-in files: every `<AUTOLOOP_DIR>/signals/*.mjs`
//     exporting `export async function collect(ctx)` is loaded BLINDLY. The engine
//     never names a source — an error tracker, issue tracker, or perf budget is a
//     ~30-line adapter the repo adds without touching this file.
//   - Every adapter is best-effort: one throwing/absent adapter never aborts the
//     rest (the driver depends on this always producing a file).
//
// Usage: node scripts/autoloop/signals.mjs [repoRoot] [--json]
//   Writes <AUTOLOOP_DIR or repoRoot/.autoloop>/signals.json and prints a summary.
// Env:
//   AUTOLOOP_DIR       canonical control/state dir (default <repoRoot>/.autoloop)
//   SIGNAL_SRC_DIRS    comma list of source roots (default broad multi-stack set)
//   SIGNAL_SINCE       git window for regression-risk (default "60 days ago")
//   SIGNAL_MAX         cap on emitted signals (default 24)
//   SIGNAL_RUN_GATE    "1" => actually run ci-gate.sh to harvest live failures
//                      (highest fidelity, but a full test run — opt-in). Default
//                      off; the free CI-status adapter covers the common red-build
//                      case without the cost.
//
// Signal shape (each item):
//   { source, class, title, file, evidence, gate, severity }
//     class    — an engine work-class ('signal-fix' | 'mechanical' | 'gated-test'
//                | 'devex' | 'dep-hygiene'); the mesh seeds each class's discovery
//                leaf with the REAL signals for that class.
//     evidence — why this is real (the error line, the fix-commit count, the marker).
//     gate     — the objective red→green / measurable check that PROVES a fix.
//     severity — 0..100, used for ranking within a class.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : process.cwd();
const AUTOLOOP_DIR = process.env.AUTOLOOP_DIR || path.join(repoRoot, '.autoloop');
const SINCE = process.env.SIGNAL_SINCE || '60 days ago';
const MAX = Number(process.env.SIGNAL_MAX || 24);
// Broad default covers common layouts across stacks; a repo narrows it via env.
const SRC_DIRS = (process.env.SIGNAL_SRC_DIRS || 'src,lib,server,app,pkg,packages,crates,internal,cmd,recommender')
  .split(',').map((s) => s.trim()).filter(Boolean);
const SRC_RE = new RegExp(`^(${SRC_DIRS.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})/`);
const SKIP_RE = /(^|\/)(node_modules|dist|build|target|\.venv|venv|coverage|__pycache__|vendor)\//;
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|kt|rb|swift)$/;
const TEST_RE = /(\.test\.|\.spec\.|\.bench\.|_test\.|(^|\/)(tests?|__tests__|spec)\/)/;

function git(args, opts = {}) {
  try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...opts }); }
  catch { return ''; }
}
function sh(cmd, opts = {}) {
  try { return execFileSync('bash', ['-c', cmd], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}
function readJson(p, fallback) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } }

const hotspots = readJson(path.join(AUTOLOOP_DIR, 'hotspots.json'), { top: [] });
const hotFiles = new Set((hotspots.top || []).map((h) => h.file));
const hotTop = new Set((hotspots.top || []).slice(0, 12).map((h) => h.file));

const out = [];
const diag = [];
function emit(s) {
  if (!s || !s.title) return;
  out.push({
    source: s.source || 'unknown',
    class: s.class || 'signal-fix',
    title: String(s.title).slice(0, 200),
    file: s.file || '',
    evidence: String(s.evidence || '').slice(0, 400),
    gate: String(s.gate || '').slice(0, 300),
    severity: Math.max(0, Math.min(100, Number(s.severity ?? 50))),
  });
}

// ── Built-in adapter 1: CI health (FREE) ───────────────────────────────────
// The guard already writes ci-status.json (origin/main CI conclusion). A red
// main is a reproduced failure of the highest merit — and the loop was
// previously blind to it (the rediscovery-livelock root cause). Zero cost.
function adapterCiStatus() {
  const ci = readJson(path.join(AUTOLOOP_DIR, 'ci-status.json'), null);
  if (!ci) return;
  if (ci.healthy === false) {
    emit({
      source: 'ci-status', class: 'signal-fix', severity: 95,
      title: `main CI is ${ci.conclusion || 'failing'} — reproduce and fix the red`,
      evidence: `ci-status.json: conclusion=${ci.conclusion}, headSha=${(ci.headSha || '').slice(0, 8)}, checkedAt=${ci.checkedAtSec || ci.checkedAt || '?'}`,
      gate: 'the failing CI job goes green (reproduce locally via ci-gate.sh, fix, re-run)',
    });
    diag.push('ci-status: main RED → signal-fix emitted');
  } else {
    diag.push(`ci-status: healthy=${ci.healthy}`);
  }
}

// ── Built-in adapter 2: git regression-risk (FREE) ──────────────────────────
// Files repeatedly touched by fix/bug/revert commits are where defects actually
// recur. A hot fix-magnet WITHOUT a sibling test is a high-merit target: the
// gate (add a regression test that pins the last-fixed behavior) is objective.
function adapterRegressionRisk() {
  const log = git(['log', `--since=${SINCE}`, '--name-only', '--pretty=format:%s']);
  if (!log) { diag.push('regression-risk: no git log'); return; }
  const fixHits = new Map(); // file -> count of fix-ish commits touching it
  let curIsFix = false;
  for (const raw of log.split('\n')) {
    const line = raw.trimEnd();
    if (!line) { curIsFix = false; continue; }
    if (!line.includes('/') && !CODE_EXT.test(line)) {
      // subject line
      curIsFix = /\b(fix|bug|regress|revert|hotfix|patch|broke|crash)\b/i.test(line);
      continue;
    }
    const f = line.trim();
    if (!curIsFix || !SRC_RE.test(f) || SKIP_RE.test(f) || !CODE_EXT.test(f) || TEST_RE.test(f)) continue;
    fixHits.set(f, (fixHits.get(f) || 0) + 1);
  }
  // Rank: fix-frequency, prefer hotspots, require the file still exist + lack a test sibling.
  const ranked = [...fixHits.entries()]
    .filter(([f]) => existsSync(path.join(repoRoot, f)))
    .map(([f, n]) => ({ f, n, hot: hotFiles.has(f) }))
    .sort((a, b) => (b.hot - a.hot) || (b.n - a.n))
    .slice(0, 6);
  for (const { f, n, hot } of ranked) {
    if (n < 2) continue; // a single fix isn't a recurrence signal
    const hasTest = siblingTestExists(f);
    emit({
      source: 'git-regression-risk',
      class: hasTest ? 'signal-fix' : 'gated-test',
      severity: (hot ? 70 : 50) + Math.min(20, n * 4),
      title: hasTest
        ? `recurring-fix file ${f} (${n} fix commits) — harden the last-fixed path`
        : `recurring-fix file ${f} (${n} fix commits) has NO sibling test — pin a regression test`,
      file: f,
      evidence: `${n} fix/bug/revert commits touched ${f} since ${SINCE}${hot ? ' (hotspot)' : ''}; sibling test ${hasTest ? 'present' : 'ABSENT'}`,
      gate: hasTest
        ? 'a new assertion fails on the pre-fix behavior (mutation-survives) and passes now'
        : 'a new sibling test reproduces a past failure mode red→green and raises coverage on this file',
    });
  }
  diag.push(`regression-risk: ${ranked.length} fix-magnet file(s)`);
}

function siblingTestExists(f) {
  const dir = path.dirname(f);
  const base = path.basename(f).replace(CODE_EXT, '');
  const ext = (f.match(CODE_EXT) || ['.ts'])[0];
  const candidates = [
    path.join(dir, `${base}.test${ext}`), path.join(dir, `${base}.spec${ext}`),
    path.join(dir, '__tests__', `${base}.test${ext}`),
    path.join(dir, `${base}_test${ext}`),
  ];
  return candidates.some((c) => existsSync(path.join(repoRoot, c)));
}

// ── Built-in adapter 3: TODO/FIXME at hotspots (FREE, bounded) ───────────────
// Author-left intent markers in defect-dense files are concrete, low-speculation
// devex/mechanical work. Bounded to the top hotspots so it never floods.
function adapterTodoMarkers() {
  const targets = (hotspots.top || []).slice(0, 12).map((h) => h.file).filter((f) => existsSync(path.join(repoRoot, f)));
  if (!targets.length) { diag.push('todo-markers: no hotspot files'); return; }
  let n = 0;
  for (const f of targets) {
    let txt = '';
    try { txt = readFileSync(path.join(repoRoot, f), 'utf8'); } catch { continue; }
    const lines = txt.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/\b(TODO|FIXME|HACK|XXX|BUG)\b[:\s-]*(.+)?/);
      if (!m) continue;
      const kind = m[1].toUpperCase();
      emit({
        source: 'todo-marker',
        class: kind === 'BUG' || kind === 'FIXME' ? 'signal-fix' : 'devex',
        severity: kind === 'BUG' || kind === 'FIXME' ? 55 : 35,
        title: `${kind} at ${f}:${i + 1} — ${(m[2] || '').trim().slice(0, 80) || 'resolve author-left marker'}`,
        file: f,
        evidence: `${f}:${i + 1}  ${lines[i].trim().slice(0, 160)}`,
        gate: 'the marker is resolved (behavior change covered by a test, or mechanical change with build/lint green)',
      });
      if (++n >= 8) break; // hard cap — markers must not flood the queue
    }
    if (n >= 8) break;
  }
  diag.push(`todo-markers: ${n} marker(s) at hotspots`);
}

// ── Built-in adapter 4: live gate harvest (OPT-IN, expensive) ────────────────
// Highest fidelity: actually run the repo's gate and parse failing tests / type
// / lint errors into signal-fix items. A full test run, so opt-in via env.
function adapterLiveGate() {
  if (process.env.SIGNAL_RUN_GATE !== '1') { diag.push('live-gate: skipped (SIGNAL_RUN_GATE!=1)'); return; }
  const gate = path.join(repoRoot, 'scripts', 'autoloop', 'ci-gate.sh');
  const cmd = process.env.SIGNAL_TEST_CMD || (existsSync(gate) ? `bash ${JSON.stringify(gate)}` : '');
  if (!cmd) { diag.push('live-gate: no ci-gate.sh and no SIGNAL_TEST_CMD'); return; }
  const res = sh(cmd);
  // Generic failure extraction across common toolchains.
  const fails = [];
  for (const ln of res.split('\n')) {
    if (/error TS\d+/.test(ln)) fails.push(['signal-fix', 'tsc', ln.trim()]);
    else if (/^\s*(FAIL|✗|×|not ok)\b/.test(ln)) fails.push(['signal-fix', 'test', ln.trim()]);
    else if (/error\[E\d+\]/.test(ln)) fails.push(['signal-fix', 'cargo', ln.trim()]);
    else if (/\b\d+\) .+ (FAILED|Error)\b/.test(ln)) fails.push(['signal-fix', 'test', ln.trim()]);
  }
  const seen = new Set();
  for (const [cls, tool, line] of fails.slice(0, 12)) {
    const key = line.slice(0, 120);
    if (seen.has(key)) continue; seen.add(key);
    emit({
      source: `live-gate:${tool}`, class: cls, severity: 90,
      title: `${tool} failure — ${line.slice(0, 90)}`,
      evidence: line.slice(0, 300),
      gate: 'the failing command exits 0 after the fix (re-run ci-gate.sh)',
    });
  }
  diag.push(`live-gate: ${seen.size} failure(s) harvested`);
}

// ── Per-repo adapters: load <AUTOLOOP_DIR>/signals/*.mjs (drop-in, blind) ────
async function adapterPerRepo() {
  const dir = path.join(AUTOLOOP_DIR, 'signals');
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.mjs')); } catch { diag.push('per-repo: no signals/ dir'); return; }
  const ctx = { repoRoot, autoloopDir: AUTOLOOP_DIR, hotspots, hotFiles, hotTop, git, sh, readJson, SRC_RE, TEST_RE };
  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      if (typeof mod.collect !== 'function') { diag.push(`per-repo ${f}: no collect()`); continue; }
      const items = await mod.collect(ctx);
      let n = 0;
      for (const it of (items || [])) { emit({ ...it, source: it.source || `repo:${f}` }); n++; }
      diag.push(`per-repo ${f}: ${n} signal(s)`);
    } catch (e) {
      diag.push(`per-repo ${f}: ERROR ${e?.message || e}`); // never abort the rest
    }
  }
}

// ── Run all adapters (built-ins synchronous, per-repo async) ─────────────────
adapterCiStatus();
adapterRegressionRisk();
adapterTodoMarkers();
adapterLiveGate();
await adapterPerRepo();

// Rank: by class priority (engine ladder), then severity. Cap at MAX.
const CLASS_RANK = { 'signal-fix': 0, mechanical: 1, 'gated-test': 2, devex: 3, 'dep-hygiene': 4 };
out.sort((a, b) => (CLASS_RANK[a.class] ?? 9) - (CLASS_RANK[b.class] ?? 9) || b.severity - a.severity);
const signals = out.slice(0, MAX);

mkdirSync(AUTOLOOP_DIR, { recursive: true });
const payload = { collectedAt: new Date().toISOString(), repoRoot, count: signals.length, byClass: countBy(signals), signals, diag };
try { writeFileSync(path.join(AUTOLOOP_DIR, 'signals.json'), JSON.stringify(payload, null, 2)); } catch { /* best-effort */ }

function countBy(arr) { const m = {}; for (const s of arr) m[s.class] = (m[s.class] || 0) + 1; return m; }

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(signals, null, 2) + '\n');
} else {
  console.log(`signals: ${signals.length} (of ${out.length} collected) — ${JSON.stringify(payload.byClass)}`);
  for (const s of signals.slice(0, 12)) {
    console.log(`  [${s.class}|sev ${String(s.severity).padStart(2)}|${s.source}] ${s.title}`);
  }
  if (!signals.length) console.log('  (none — discovery falls back to code-scan; coverage is the floor)');
  console.log(`diag: ${diag.join(' · ')}`);
}
