#!/usr/bin/env node
// scripts/autoloop/guard.mjs
//
// The real-time self-monitor that EVERY node calls before each significant
// batch (law #5 — never outsourced; accepted sunk cost). It is cheap and
// side-effect-light: it reads telemetry and decides whether to stop/throttle.
//
// Returns: {
//   stop:        boolean   // hard halt now (STOP flag, claude tripwire)
//   throttle:    boolean   // back off (codex rate limit, human present)
//   humanActive: boolean   // a human is using Claude Code on this machine
//   reasons:     string[]  // why
//   telemetry:   {...}      // latest codex rollup telemetry
// }
//
// Three concerns, in priority order:
//   1. STOP flag (.autoloop/STOP) — fleet-wide circuit breaker any node can set.
//   2. Claude over-bill tripwire (defense in depth) — the loop runs on codex and
//      must NEVER touch the metered Claude path; if extra_usage_used_credits ever
//      rises above the recorded baseline, halt everything.
//   3. Codex rate-limit back-pressure + human presence → throttle, not halt.

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { latestRollupTelemetry } from './codex.mjs';

const HOME = homedir();
const USAGE_CACHE = path.join(HOME, '.claude', '.usage-cache.json');

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// Baseline of the Claude extra-usage meter, recorded by the supervisor at start.
// Any rise means the loop somehow spent metered Claude dollars → hard stop.
export function claudeOverageDelta(autoloopDir) {
  const cache = readJson(USAGE_CACHE);
  if (!cache || typeof cache.extra_usage_used_credits !== 'number') return { delta: 0, current: null };
  const baseFile = path.join(autoloopDir, 'claude-baseline.json');
  const base = readJson(baseFile);
  const baseline = base && typeof base.extra_usage_used_credits === 'number'
    ? base.extra_usage_used_credits
    : cache.extra_usage_used_credits; // first read: treat current as baseline
  return {
    delta: cache.extra_usage_used_credits - baseline,
    current: cache.extra_usage_used_credits,
    baseline,
  };
}

// A human is "active" if an interactive `claude` process is running (the loop
// uses codex, never claude) AND/OR a Claude bridge file was touched recently.
export function detectHumanActive() {
  let claudeProcs = 0;
  try {
    const out = execFileSync('pgrep', ['-f', 'claude'], { encoding: 'utf8', timeout: 3000 });
    // count lines that look like the interactive `claude` TUI, not our own tooling
    claudeProcs = out.split('\n').filter((l) => l.trim()).length;
  } catch { /* pgrep returns non-zero when no match */ }

  let freshBridge = false;
  try {
    const t = tmpdir();
    const now = Date.now();
    for (const f of readdirSync(t)) {
      if (f.startsWith('claude-ctx-') && f.endsWith('.json') && !f.includes('-warned')) {
        const age = now - statSync(path.join(t, f)).mtimeMs;
        if (age < 120_000) { freshBridge = true; break; } // typed within 2 min
      }
    }
  } catch { /* ignore */ }

  return { humanActive: claudeProcs > 0 || freshBridge, claudeProcs, freshBridge };
}

export function checkGuard(opts = {}) {
  const autoloopDir = opts.autoloopDir || path.join(process.cwd(), '.autoloop');
  const reasons = [];
  let stop = false;
  let throttle = false;

  // 1. STOP flag — highest priority, instant fleet-wide halt.
  const stopFile = path.join(autoloopDir, 'STOP');
  if (existsSync(stopFile)) {
    stop = true;
    let why = '';
    try { why = readFileSync(stopFile, 'utf8').trim().slice(0, 200); } catch { /* */ }
    reasons.push(`STOP flag set${why ? ': ' + why : ''}`);
  }

  // 2. Claude over-bill tripwire.
  const overage = claudeOverageDelta(autoloopDir);
  if (overage.delta > 0) {
    stop = true;
    reasons.push(`claude extra_usage rose by ${overage.delta} credit(s) (cents) — loop must not touch metered Claude`);
  }

  // 3. Codex back-pressure + human presence → throttle.
  const telemetry = latestRollupTelemetry();
  if (telemetry && telemetry.rateLimitReached != null) {
    throttle = true;
    reasons.push(`codex rate limit reached: ${telemetry.rateLimitReached}`);
  }
  const human = detectHumanActive();
  if (human.humanActive) {
    throttle = true;
    reasons.push(`human active (claudeProcs=${human.claudeProcs}, freshBridge=${human.freshBridge}) — yield resources`);
  }

  return {
    stop,
    throttle,
    humanActive: human.humanActive,
    reasons,
    telemetry,
    overage,
    human,
  };
}

// ---- CLI ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const autoloopDir = process.argv[2] || path.join(process.cwd(), '.autoloop');
  const r = checkGuard({ autoloopDir });
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exit(r.stop ? 2 : 0);
}
