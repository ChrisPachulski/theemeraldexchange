#!/usr/bin/env node
// scripts/autoloop/orchestrator.mjs
//
// P2, first-run-safe. One bounded improvement cycle per call:
//   discover (codex read-only) → worktree-isolated codex --write → commit →
//   push branch.  NEVER main, NEVER deploy, capped at FIRST_RUN_MAX_BRANCHES.
// Guard is re-checked before every codex call (law #5). Mutations happen only
// inside a dedicated git worktree (CLAUDE.md runaway rule).
//
// Returns a structured result the supervisor logs; throws are caught upstream
// and emailed.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Node } from './node-state.mjs';
import { checkGuard } from './guard.mjs';
import { runCodex } from './codex.mjs';

const FIRST_RUN_MAX_BRANCHES = parseInt(process.env.FIRST_RUN_MAX_BRANCHES || '6', 10);

function sh(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout || 120000, cwd: opts.cwd || process.cwd() });
    return { ok: true, out: out.trim() };
  } catch (e) {
    return { ok: false, out: (e.stdout || '').toString().trim(), err: (e.stderr || e.message || '').toString().trim() };
  }
}

function extractJson(text) {
  if (!text) return null;
  // strip markdown fences, then take the first balanced {...}
  const t = text.replace(/```[a-z]*\n?/gi, '');
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === '{') depth++;
    else if (t[i] === '}') { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

const slug = (s) => String(s || 'change').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'change';

function autoBranchCount(repo) {
  const r = sh('git', ['branch', '--list', 'auto/*'], { cwd: repo });
  return r.ok ? r.out.split('\n').filter((l) => l.trim()).length : 0;
}

export async function runOrchestratorTick({ autoloopDir, repo, posture = {}, channels = ['osascript'] }) {
  const mesh = path.join(autoloopDir, 'mesh');
  const orch = new Node({ meshDir: mesh, tier: 'orchestrator', nodeId: 'orch-main',
    parentDir: path.join(mesh, 'supervisor', 'sup-main') });
  orch.init({ objective: 'first-run: bounded discover→fix→test→push-branch cycles', parentId: 'sup-main' });

  // First-run cap.
  const made = autoBranchCount(repo);
  if (made >= FIRST_RUN_MAX_BRANCHES) {
    orch.update({ progress: [`first-run cap reached (${made}/${FIRST_RUN_MAX_BRANCHES} branches) — idling`] });
    orch.reportUp({ status: 'capped', summary: `first-run cap ${made}/${FIRST_RUN_MAX_BRANCHES}` });
    return { action: 'capped', made };
  }

  // Guard before discovery.
  let g = checkGuard({ autoloopDir });
  if (g.stop) return { action: 'aborted', reason: g.reasons.join('; ') };

  // 1. DISCOVERY (read-only codex).
  const doneList = (orch.state.decisions || []).map((d) => `- ${d}`).join('\n') || '(none yet)';
  const existing = sh('git', ['branch', '--list', 'auto/*'], { cwd: repo }).out || '(none)';
  const discPrompt = [
    'You are the discovery+audit stage of an autonomous improvement loop for this repo.',
    'Read docs/ROADMAP-STATUS.md and docs/PRODUCTION-READINESS-2026-05-30.md.',
    'Pick the SINGLE highest-value improvement that is ALL of: autonomous (code/tests/docs/deps only — no Apple, no hardware, no deploy, no secrets), LOW RISK, and small enough to finish in one focused change.',
    'Do NOT repeat anything already done:',
    doneList,
    `Existing auto/* branches: ${existing}`,
    'Reply with ONLY a JSON object: {"title": "...", "files": ["path", ...], "rationale": "...", "risk": "low|medium|high", "autonomous": true|false, "instructions": "precise change to make, including tests to add/strengthen"}',
    'If nothing suitable remains, reply {"title": null}.',
  ].join('\n');

  const disc = await runCodex({ prompt: discPrompt, effort: posture.throttle ? 'medium' : 'high', write: false, cwd: repo });
  if (!disc.ok) return { action: 'discovery_failed', error: disc.error || `status ${disc.status}`, raw: disc.output?.slice(0, 500) };
  const pick = extractJson(disc.output);
  if (!pick || !pick.title) { orch.update({ progress: ['discovery: nothing suitable'] }); return { action: 'nothing_to_do' }; }
  if (pick.autonomous === false || pick.risk !== 'low') {
    orch.update({ progress: [`discovery skipped non-low/non-autonomous: ${pick.title}`] });
    return { action: 'skipped_risky', pick };
  }

  // Guard before mutation.
  g = checkGuard({ autoloopDir });
  if (g.stop) return { action: 'aborted', reason: g.reasons.join('; ') };

  // 2. WORKTREE (isolation). Branch off committed main HEAD.
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const branch = `auto/${ts}-${slug(pick.title)}`;
  const wt = path.join(os.tmpdir(), `autoloop-wt-${ts}-${slug(pick.title)}`);
  const base = sh('git', ['rev-parse', 'HEAD'], { cwd: repo }).out;
  const add = sh('git', ['worktree', 'add', '-b', branch, wt, base], { cwd: repo });
  if (!add.ok) return { action: 'worktree_failed', error: add.err };

  try {
    // let codex typecheck if it wants — share node_modules read-only via symlink
    const nm = path.join(repo, 'node_modules');
    if (existsSync(nm)) { try { symlinkSync(nm, path.join(wt, 'node_modules')); } catch { /* */ } }

    // 3. EXECUTOR (codex --write inside the worktree).
    const exoPrompt = [
      `Implement this improvement in the current repo checkout. Title: ${pick.title}`,
      `Rationale: ${pick.rationale || ''}`,
      `Target files (guide, not a limit): ${(pick.files || []).join(', ') || 'as needed'}`,
      `Instructions: ${pick.instructions || pick.title}`,
      'Make a focused, correct change. ADD OR STRENGTHEN TESTS for it — tests matter more than the change itself.',
      'Do NOT touch deploy config, secrets, CI billing, or unrelated files. Keep the diff tight.',
      'When done, reply with a one-paragraph summary of what you changed and the tests you added.',
    ].join('\n');
    const exo = await runCodex({ prompt: exoPrompt, effort: posture.throttle ? 'high' : 'xhigh', write: true, cwd: wt, timeoutMs: 1_500_000 });

    const changed = sh('git', ['status', '--porcelain'], { cwd: wt }).out;
    if (!changed) { return { action: 'no_changes', pick, exoOk: exo.ok }; }

    // 4. COMMIT in the worktree (own checkout → safe to stage all of it).
    sh('git', ['add', '-A'], { cwd: wt });
    const msg = `auto: ${pick.title}\n\n${(exo.output || pick.rationale || '').slice(0, 1500)}\n\n[autoloop first-run; review before merge — not deployed]`;
    const commit = sh('git', ['commit', '-m', msg], { cwd: wt });
    if (!commit.ok) return { action: 'commit_failed', error: commit.err, pick };

    // 5. PUSH branch (CI is the independent verifier). Never main.
    const push = sh('git', ['push', '-u', 'origin', branch], { cwd: repo, timeout: 180000 });

    orch.update({
      progress: [`landed branch ${branch} (push ${push.ok ? 'ok' : 'FAILED'})`],
      decisions: [pick.title],
    });
    orch.reportUp({ status: 'active', summary: `branch ${branch} for: ${pick.title}` });
    return { action: 'branch_created', branch, pick, pushed: push.ok, pushErr: push.ok ? null : push.err, tokens: (disc.tokens?.total_tokens || 0) + (exo.tokens?.total_tokens || 0) };
  } finally {
    // 6. Tear down the worktree (keep the branch).
    sh('git', ['worktree', 'remove', '--force', wt], { cwd: repo });
    try { rmSync(wt, { recursive: true, force: true }); } catch { /* */ }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const autoloopDir = process.env.AUTOLOOP_DIR || path.join(process.cwd(), '.autoloop');
  runOrchestratorTick({ autoloopDir, repo: process.cwd(), posture: { throttle: true } })
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => { process.stderr.write(`orchestrator error: ${e.stack}\n`); process.exit(1); });
}
