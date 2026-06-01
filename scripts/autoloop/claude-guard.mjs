#!/usr/bin/env node
// scripts/autoloop/claude-guard.mjs
//
// The window/overage guard for the PURE-CLAUDE in-session loop. The loop spends
// the interactive Max 5h/7d window, which can spill into paid extra-usage once
// exhausted — so this is the never-over-bill enforcement. Called at the top of
// every /loop iteration AND before each expensive mesh phase (law #5).
//
// Returns one of three actions:
//   stop  — halt the loop entirely (MASTER off, STOP flag, converged, OR an
//           extra_usage rise = we've spilled into paid money → freeze NOW)
//   idle  — don't spend this iteration; ScheduleWakeup to the window reset
//           (5h or 7d ceiling hit). sleepSeconds tells the driver how long.
//   go    — safe to run a bounded mesh window; includes live headroom
//
// It refreshes the cache first (usage-fetcher.js) so the read is live.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { readControl } from './control.mjs';

const HOME = homedir();
const USAGE_CACHE = path.join(HOME, '.claude', '.usage-cache.json');
const FETCHER = path.join(HOME, '.claude', 'hooks', 'usage-fetcher.js');

// Default ceilings: stay well under 100% so we never push into paid overage.
const DEFAULT_5H_CEILING = 85;
const DEFAULT_7D_CEILING = 90;
// Deterministic cadence: when the guard says `go`, this is the EXACT delay the
// driver must use for the next ScheduleWakeup — no LLM pacing judgment. Keeps
// the loop near-continuous while the window is healthy. Long sleeps only ever
// come from the `idle` branch (window genuinely tight → wait for reset).
const DEFAULT_CADENCE_SECONDS = 120;

function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }

function refreshUsage() {
  if (!existsSync(FETCHER)) return;
  try { execFileSync(process.execPath, [FETCHER], { timeout: 15000, stdio: 'ignore' }); } catch { /* best-effort */ }
}

function secsUntil(iso) {
  if (!iso) return 0;
  const ms = Date.parse(iso) - Date.now();
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}

// Record the extra_usage baseline once per campaign so any rise = paid spend.
function ensureBaseline(autoloopDir, cache) {
  const f = path.join(autoloopDir, 'claude-baseline.json');
  if (existsSync(f)) return readJson(f);
  mkdirSync(autoloopDir, { recursive: true });
  const base = {
    extra_usage_used_credits: cache?.extra_usage_used_credits ?? null,
    recorded_at: new Date().toISOString(),
  };
  writeFileSync(f, JSON.stringify(base, null, 2));
  return base;
}

export function evaluate(autoloopDir = path.join(process.cwd(), '.autoloop'), opts = {}) {
  const control = readControl(autoloopDir);
  const out = { action: 'go', reason: 'go', control };

  if (control.MASTER !== 'ON') return { ...out, action: 'stop', reason: 'master_off' };
  if (existsSync(path.join(autoloopDir, 'STOP'))) return { ...out, action: 'stop', reason: 'stop_flag' };
  if (existsSync(path.join(autoloopDir, 'GOALS-MET.md'))) return { ...out, action: 'stop', reason: 'converged' };

  refreshUsage();
  const cache = readJson(USAGE_CACHE);
  if (!cache) {
    // No telemetry → cannot prove we're safe → idle briefly and retry.
    return { ...out, action: 'idle', reason: 'no_usage_cache', sleepSeconds: 300 };
  }
  const tel = {
    five_hour_pct: cache.five_hour_pct,
    seven_day_pct: cache.seven_day_pct,
    five_hour_resets_at: cache.five_hour_resets_at,
    seven_day_resets_at: cache.seven_day_resets_at,
    extra_usage_used_credits: cache.extra_usage_used_credits,
  };
  out.telemetry = tel;

  // PRIME DIRECTIVE: any rise in paid extra-usage → freeze immediately.
  const base = ensureBaseline(autoloopDir, cache);
  if (typeof tel.extra_usage_used_credits === 'number' && typeof base?.extra_usage_used_credits === 'number'
      && tel.extra_usage_used_credits > base.extra_usage_used_credits) {
    return { ...out, action: 'stop', reason: 'overage_detected',
      delta_credits: tel.extra_usage_used_credits - base.extra_usage_used_credits, telemetry: tel };
  }

  const c5 = Number(control.FIVE_HOUR_CEILING ?? opts.fiveHourCeiling ?? DEFAULT_5H_CEILING);
  const c7 = Number(control.SEVEN_DAY_CEILING ?? opts.sevenDayCeiling ?? DEFAULT_7D_CEILING);

  if (typeof tel.seven_day_pct === 'number' && tel.seven_day_pct >= c7) {
    return { ...out, action: 'idle', reason: `7d_window_tight(${tel.seven_day_pct}%>=${c7})`,
      sleepSeconds: Math.max(300, secsUntil(tel.seven_day_resets_at)), telemetry: tel };
  }
  if (typeof tel.five_hour_pct === 'number' && tel.five_hour_pct >= c5) {
    return { ...out, action: 'idle', reason: `5h_window_tight(${tel.five_hour_pct}%>=${c5})`,
      sleepSeconds: Math.max(300, secsUntil(tel.five_hour_resets_at)), telemetry: tel };
  }

  out.headroom = { five_hour_pct: tel.five_hour_pct, seven_day_pct: tel.seven_day_pct,
    five_h_to_ceiling: c5 - (tel.five_hour_pct ?? 0), seven_d_to_ceiling: c7 - (tel.seven_day_pct ?? 0) };
  // Authoritative next-window delay. The driver uses this VERBATIM — it is not
  // a suggestion. While `go`, the window is by definition below both ceilings,
  // so a dense cadence is safe: if it ever tightens, the very next evaluate()
  // returns `idle` with sleepSeconds instead. This is what kills long idle gaps.
  out.nextDelaySeconds = Math.max(30, Number(control.CADENCE_SECONDS ?? opts.cadenceSeconds ?? DEFAULT_CADENCE_SECONDS));
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] || path.join(process.cwd(), '.autoloop');
  const r = evaluate(dir);
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exit(r.action === 'go' ? 0 : r.action === 'idle' ? 1 : 2);
}
