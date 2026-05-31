#!/usr/bin/env node
// scripts/autoloop/supervisor.mjs
//
// The uppermost Node. launchd invokes it (~10 min). It:
//   1. asks the governor GO / NO-GO (enforces every law),
//   2. mirrors a live STATUS.json (so you can see what it's doing),
//   3. on GO, runs ONE guarded codex tick (re-checking the guard right before
//      the call — self-monitoring, never outsourced), logging codex token spend.
//
// P1 scope: this proves the governed pipeline end-to-end (governor → guard →
// codex → telemetry) with the orchestrator/team mesh (P2+) not yet wired. The
// tick is a cheap heartbeat; real discovery/execution lands in later phases.
// Everything stays inert while CONTROL.md has MASTER: OFF.

import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Node } from './node-state.mjs';
import { evaluate } from './governor.mjs';
import { checkGuard } from './guard.mjs';
import { runCodex } from './codex.mjs';

const AUTOLOOP = process.env.AUTOLOOP_DIR || path.join(process.cwd(), '.autoloop');
const MESH = path.join(AUTOLOOP, 'mesh');

function writeStatus(obj) {
  mkdirSync(AUTOLOOP, { recursive: true });
  writeFileSync(path.join(AUTOLOOP, 'STATUS.json'),
    JSON.stringify({ ...obj, ts: new Date().toISOString() }, null, 2));
}

function logSpend(tokens) {
  if (!tokens?.total_tokens) return;
  appendFileSync(path.join(AUTOLOOP, 'codex-spend.jsonl'),
    JSON.stringify({ ts: Math.floor(Date.now() / 1000), tokens: tokens.total_tokens }) + '\n');
}

async function main() {
  const sup = new Node({ meshDir: MESH, tier: 'supervisor', nodeId: 'sup-main' });
  sup.init({ objective: 'govern + drive the autonomous improvement mesh' });

  const decision = evaluate(AUTOLOOP);
  writeStatus({
    state: decision.go ? `running ${decision.mode}` : `idle (${decision.reason})`,
    decision: { go: decision.go, mode: decision.mode, reason: decision.reason, posture: decision.posture },
    windowTokens: decision.windowTokens ?? 0,
    telemetry: decision.guard?.telemetry ?? null,
  });

  if (!decision.go) {
    sup.update({ progress: [`NO-GO: ${decision.reason}`] });
    process.stdout.write(`NO-GO ${decision.reason}\n`);
    return 0;
  }

  // GUARDED TICK — re-check the guard immediately before spending anything.
  const pre = checkGuard({ autoloopDir: AUTOLOOP });
  if (pre.stop) {
    sup.update({ progress: [`aborted pre-tick: ${pre.reasons.join('; ')}`] });
    process.stdout.write(`ABORT ${pre.reasons.join('; ')}\n`);
    return 0;
  }

  // P1 heartbeat tick (cheap, read-only). Effort scales down under throttle.
  const effort = decision.posture.throttle ? 'low' : 'high';
  const r = await runCodex({
    prompt: 'Autoloop liveness check. Reply with exactly: AUTOLOOP_TICK_OK',
    effort,
    write: false,
  });
  logSpend(r.tokens);

  sup.update({
    progress: [`tick: codex ok=${r.ok} effort=${effort} tokens=${r.tokens?.total_tokens ?? '?'} rateLimited=${r.rateLimited}`],
  });
  writeStatus({
    state: `tick-complete ${decision.mode}`,
    tick: { ok: r.ok, output: r.output, effort, tokens: r.tokens, rateLimited: r.rateLimited },
    posture: decision.posture,
  });
  process.stdout.write(`TICK ok=${r.ok} output=${JSON.stringify(r.output)} tokens=${r.tokens?.total_tokens ?? '?'}\n`);
  return 0;
}

main().then((c) => process.exit(c || 0)).catch((e) => {
  writeStatus({ state: `error: ${e.message}` });
  process.stderr.write(`supervisor error: ${e.stack}\n`);
  process.exit(1);
});
