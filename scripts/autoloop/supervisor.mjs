#!/usr/bin/env node
// scripts/autoloop/supervisor.mjs
//
// The uppermost Node. launchd invokes it (~10 min). It:
//   1. asks the governor GO / NO-GO (enforces every law incl. the 24h deadline),
//   2. mirrors a live STATUS.json,
//   3. on GO, runs ONE bounded orchestrator cycle (P2: discover → worktree fix
//      → commit → push branch; never main, never deploy),
//   4. logs errors/issues to .autoloop/errors.log AND emails them,
//   5. on the 24h deadline, fires the kill-switch (belt to the killer agent).
//
// Inert while CONTROL.md has MASTER: OFF.

import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Node } from './node-state.mjs';
import { evaluate } from './governor.mjs';
import { checkGuard } from './guard.mjs';
import { runOrchestratorTick } from './orchestrator.mjs';
import { notify } from './notify.mjs';

const REPO = process.cwd();
const AUTOLOOP = process.env.AUTOLOOP_DIR || path.join(REPO, '.autoloop');
const MESH = path.join(AUTOLOOP, 'mesh');

function writeStatus(obj) {
  mkdirSync(AUTOLOOP, { recursive: true });
  writeFileSync(path.join(AUTOLOOP, 'STATUS.json'),
    JSON.stringify({ ...obj, ts: new Date().toISOString() }, null, 2));
}
function logError(line) {
  mkdirSync(AUTOLOOP, { recursive: true });
  appendFileSync(path.join(AUTOLOOP, 'errors.log'), `${new Date().toISOString()} ${line}\n`);
}
function emailIssue(subject, body) {
  logError(`${subject} :: ${body}`.replace(/\n/g, ' '));
  notify({ subject: `[autoloop] ${subject}`, body, channels: ['email'], isError: true });
}

// Actions from the orchestrator that represent an error/issue worth emailing.
const ISSUE_ACTIONS = new Set(['discovery_failed', 'worktree_failed', 'commit_failed', 'aborted']);

async function main() {
  const sup = new Node({ meshDir: MESH, tier: 'supervisor', nodeId: 'sup-main' });
  sup.init({ objective: 'govern + drive the autonomous improvement mesh (first run)' });

  const decision = evaluate(AUTOLOOP);

  // 24h hard deadline (fast path; the killer launchd agent is the guarantee).
  if (decision.reason === 'deadline_24h') {
    writeStatus({ state: 'DEADLINE — firing kill-switch' });
    try { execFileSync('/bin/bash', [path.join(REPO, 'scripts/autoloop/kill-switch.sh'), 'deadline_24h-via-supervisor'], { timeout: 60000 }); } catch { /* killer agent will still fire */ }
    process.stdout.write('DEADLINE kill-switch fired\n');
    return 0;
  }

  writeStatus({
    state: decision.go ? `running ${decision.mode}` : `idle (${decision.reason})`,
    decision: { go: decision.go, mode: decision.mode, reason: decision.reason, posture: decision.posture },
    windowTokens: decision.windowTokens ?? 0,
    telemetry: decision.guard?.telemetry ?? null,
  });

  if (!decision.go) { process.stdout.write(`NO-GO ${decision.reason}\n`); return 0; }

  // Re-check the guard immediately before doing anything (self-monitoring).
  const pre = checkGuard({ autoloopDir: AUTOLOOP });
  if (pre.stop) { process.stdout.write(`ABORT ${pre.reasons.join('; ')}\n`); return 0; }

  let result;
  try {
    result = await runOrchestratorTick({ autoloopDir: AUTOLOOP, repo: REPO, posture: decision.posture });
  } catch (e) {
    emailIssue('orchestrator threw', e.stack || e.message);
    writeStatus({ state: `error: ${e.message}` });
    return 1;
  }

  sup.update({ progress: [`tick: ${result.action}${result.branch ? ' ' + result.branch : ''}`] });
  writeStatus({ state: `tick-complete ${decision.mode}`, result, posture: decision.posture });

  // Email errors/issues; desktop-notify successful branches.
  if (ISSUE_ACTIONS.has(result.action)) {
    emailIssue(`tick issue: ${result.action}`, JSON.stringify(result, null, 2));
  } else if (result.action === 'branch_created') {
    if (!result.pushed) emailIssue('branch push failed', `${result.branch}\n${result.pushErr}`);
    else notify({ subject: `[autoloop] new branch ${result.branch}`, body: result.pick?.title || '', channels: ['osascript'] });
  }
  process.stdout.write(`TICK ${result.action}${result.branch ? ' ' + result.branch : ''}\n`);
  return 0;
}

main().then((c) => process.exit(c || 0)).catch((e) => {
  logError(`supervisor fatal: ${e.stack || e.message}`);
  notify({ subject: '[autoloop] supervisor fatal error', body: e.stack || e.message, channels: ['email'], isError: true });
  process.stderr.write(`supervisor error: ${e.stack}\n`);
  process.exit(1);
});
