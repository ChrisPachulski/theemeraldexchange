#!/usr/bin/env node
// scripts/autoloop/governor.mjs
//
// The gate that decides GO / NO-GO for a window, enforcing every law before any
// work starts. The supervisor calls this first; every node also re-checks the
// guard continuously (law #5). Concern-scoped checks, any one of which can veto.
//
// Gate order (first failure → NO-GO):
//   1. MASTER: OFF                              → no-op kill-switch
//   2. converged (GOALS-MET.md present)         → stay done
//   3. ensure Claude over-bill baseline exists  (defense in depth)
//   4. guard.stop (STOP flag / claude tripwire) → hard halt
//   5. ALLOWED_HOURS                            → outside → wait
//   6. MAX_TOKENS_PER_WINDOW sanity             → exceeded → wait for reset
//   → GO with posture {throttle, humanActive} (human/rate-limit reduce, don't halt)

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { readControl, withinAllowedHours } from './control.mjs';
import { checkGuard } from './guard.mjs';

function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }

// Record the Claude extra_usage meter baseline once, so the guard tripwire can
// detect ANY rise (the loop must never spend metered Claude dollars).
function ensureClaudeBaseline(autoloopDir) {
  const baseFile = path.join(autoloopDir, 'claude-baseline.json');
  if (existsSync(baseFile)) return;
  const cache = readJson(path.join(homedir(), '.claude', '.usage-cache.json'));
  mkdirSync(autoloopDir, { recursive: true });
  writeFileSync(baseFile, JSON.stringify({
    extra_usage_used_credits: cache?.extra_usage_used_credits ?? null,
    recorded_at: new Date().toISOString(),
  }, null, 2));
}

// Cumulative codex tokens spent this 5h-equivalent window (from codex-spend.jsonl).
function windowTokens(autoloopDir) {
  const f = path.join(autoloopDir, 'codex-spend.jsonl');
  if (!existsSync(f)) return 0;
  try {
    const cutoff = Date.now() - 5 * 3600 * 1000;
    return readFileSync(f, 'utf8').split('\n').filter(Boolean).reduce((sum, ln) => {
      try { const r = JSON.parse(ln); return r.ts * 1000 >= cutoff ? sum + (r.tokens || 0) : sum; }
      catch { return sum; }
    }, 0);
  } catch { return 0; }
}

export function evaluate(autoloopDir = path.join(process.cwd(), '.autoloop')) {
  const control = readControl(autoloopDir);
  const decision = { go: false, mode: 'NORMAL', reason: '', posture: {}, control };

  if (control.MASTER !== 'ON') { decision.reason = 'master_off'; return decision; }

  if (existsSync(path.join(autoloopDir, 'GOALS-MET.md'))) {
    decision.reason = 'converged'; decision.mode = 'CONVERGED'; return decision;
  }

  ensureClaudeBaseline(autoloopDir);

  const guard = checkGuard({ autoloopDir });
  decision.guard = guard;
  if (guard.stop) { decision.reason = 'guard_stop: ' + guard.reasons.join('; '); return decision; }

  if (!withinAllowedHours(control.ALLOWED_HOURS)) { decision.reason = 'outside_allowed_hours'; return decision; }

  const tokens = windowTokens(autoloopDir);
  decision.windowTokens = tokens;
  if (tokens >= control.MAX_TOKENS_PER_WINDOW) { decision.reason = 'window_token_cap'; return decision; }

  // GO. Human presence / rate-limit reduce posture, they don't halt (law #7).
  decision.go = true;
  decision.reason = 'go';
  decision.posture = {
    throttle: !!guard.throttle,
    humanActive: !!guard.humanActive,
    // concurrency the orchestrator may use: trim hard when a human is active.
    maxConcurrency: guard.throttle ? (guard.humanActive ? 1 : 2) : 6,
  };
  if (existsSync(path.join(autoloopDir, 'propagation_pending'))) decision.mode = 'PROPAGATION';
  return decision;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] || path.join(process.cwd(), '.autoloop');
  const d = evaluate(dir);
  process.stdout.write(JSON.stringify(d, null, 2) + '\n');
  process.exit(d.go ? 0 : 1);
}
