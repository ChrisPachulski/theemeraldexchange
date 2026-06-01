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

function nowSec() { return Math.floor(Date.now() / 1000); }

function refreshUsage(prior) {
  if (!existsSync(FETCHER)) return;
  // Throttle: the usage endpoint rate-limits (http_429), and the statusline +
  // other sessions hit it too. Don't pile on — skip if a fetch was attempted in
  // the last 90s. Lets genuine fetches through instead of guaranteeing 429s.
  const lastAttempt = Number(prior?.last_attempted_at) || 0;
  if (lastAttempt && (nowSec() - lastAttempt) < 90) return;
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

// Best-effort CI health of origin/main. Annotation ONLY — never changes the
// bill-safety action. The loop works on auto/integration, so a red main does not
// block it; the driver uses this to decide whether to auto-open a PR for a
// confirmed main-breaking fix (the structural cure for the red-main livelock).
// Throttled + cached (CI status moves slowly); degrades silently with no gh/net.
function checkMainCI(autoloopDir, repoRoot) {
  const f = path.join(autoloopDir, 'ci-status.json');
  const prev = readJson(f);
  const FRESH = 300; // 5-minute cache — don't hammer the GH API every window
  if (prev && typeof prev.checkedAtSec === 'number' && (nowSec() - prev.checkedAtSec) < FRESH) return prev;
  let result = prev || { healthy: null, conclusion: null, status: null, checkedAtSec: 0 };
  try {
    const out = execFileSync('gh',
      ['run', 'list', '--branch', 'main', '--workflow', 'CI', '--limit', '1', '--json', 'conclusion,status,headSha'],
      { cwd: repoRoot || process.cwd(), timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    const run = (JSON.parse(out) || [])[0];
    if (run) {
      const done = run.status === 'completed';
      result = {
        healthy: done ? run.conclusion === 'success' : null,
        conclusion: run.conclusion || null, status: run.status || null,
        headSha: run.headSha || null, checkedAtSec: nowSec(),
      };
      try { mkdirSync(autoloopDir, { recursive: true }); writeFileSync(f, JSON.stringify(result, null, 2)); } catch { /* best-effort */ }
    }
  } catch { /* gh/network absent or rate-limited → keep prior (best-effort, never throws) */ }
  return result;
}

export function evaluate(autoloopDir = path.join(process.cwd(), '.autoloop'), opts = {}) {
  const control = readControl(autoloopDir);
  const out = { action: 'go', reason: 'go', control };

  if (control.MASTER !== 'ON') return { ...out, action: 'stop', reason: 'master_off' };
  if (existsSync(path.join(autoloopDir, 'STOP'))) return { ...out, action: 'stop', reason: 'stop_flag' };
  if (existsSync(path.join(autoloopDir, 'GOALS-MET.md'))) return { ...out, action: 'stop', reason: 'converged' };

  let cache = readJson(USAGE_CACHE);
  refreshUsage(cache);
  cache = readJson(USAGE_CACHE) || cache;
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
    fetched_at: cache.fetched_at ?? 0,
    last_error: cache.last_error ?? null,
  };

  // FRESHNESS via OUR OWN last-good record. The fetcher zeroes fetched_at on any
  // failed refresh (e.g. http_429) while preserving the prior pcts, so fetched_at
  // can't measure true age. We persist every successful read to usage-last-good
  // and measure age from THAT — so a transient 429 doesn't blind us when we have
  // a recent good read, but a genuinely old one (>STALE_AFTER) forces idle.
  // Trusting stale numbers as live was the bug that let us claim "7d 79%" off a
  // rate-limited cache. Fail-safe, in service of never-over-bill.
  const STALE_AFTER = Number(control.USAGE_STALE_SECONDS ?? opts.staleAfter ?? 600);
  const lastGoodFile = path.join(autoloopDir, 'usage-last-good.json');
  let good = null;
  if (tel.fetched_at > 0 && typeof tel.seven_day_pct === 'number') {
    good = { ...tel, goodAtSec: tel.fetched_at };
    try { mkdirSync(autoloopDir, { recursive: true }); writeFileSync(lastGoodFile, JSON.stringify(good, null, 2)); } catch { /* best-effort */ }
  } else {
    good = readJson(lastGoodFile);
  }
  const ageSec = good && typeof good.goodAtSec === 'number' ? (nowSec() - good.goodAtSec) : Infinity;
  const fresh = !!good && ageSec <= STALE_AFTER;
  // Use the trusted (live or recent-good) values for all spend decisions below.
  const v = fresh ? good : tel;
  out.telemetry = { ...v, fetched_at: tel.fetched_at, last_error: tel.last_error };
  out.usage = { fresh, ageSeconds: ageSec === Infinity ? null : ageSec, source: tel.fetched_at > 0 ? 'live' : 'last_good', lastError: tel.last_error };

  // PRIME DIRECTIVE: any rise in paid extra-usage → freeze immediately. Checked
  // even on stale data: if the last-known value ALREADY shows a rise, stop now.
  const base = ensureBaseline(autoloopDir, cache);
  if (typeof v.extra_usage_used_credits === 'number' && typeof base?.extra_usage_used_credits === 'number'
      && v.extra_usage_used_credits > base.extra_usage_used_credits) {
    return { ...out, action: 'stop', reason: 'overage_detected',
      delta_credits: v.extra_usage_used_credits - base.extra_usage_used_credits, telemetry: out.telemetry };
  }

  // Cannot confirm fresh usage → refuse to spend on unverifiable headroom.
  if (!fresh) {
    return { ...out, action: 'idle',
      reason: `usage_stale(${tel.last_error || 'no_fresh_read'},age=${ageSec === Infinity ? 'never' : ageSec + 's'})`,
      sleepSeconds: 180, telemetry: out.telemetry };
  }

  const c5 = Number(control.FIVE_HOUR_CEILING ?? opts.fiveHourCeiling ?? DEFAULT_5H_CEILING);
  const c7 = Number(control.SEVEN_DAY_CEILING ?? opts.sevenDayCeiling ?? DEFAULT_7D_CEILING);

  if (typeof v.seven_day_pct === 'number' && v.seven_day_pct >= c7) {
    return { ...out, action: 'idle', reason: `7d_window_tight(${v.seven_day_pct}%>=${c7})`,
      sleepSeconds: Math.max(300, secsUntil(v.seven_day_resets_at)), telemetry: out.telemetry };
  }
  if (typeof v.five_hour_pct === 'number' && v.five_hour_pct >= c5) {
    return { ...out, action: 'idle', reason: `5h_window_tight(${v.five_hour_pct}%>=${c5})`,
      sleepSeconds: Math.max(300, secsUntil(v.five_hour_resets_at)), telemetry: out.telemetry };
  }

  out.headroom = { five_hour_pct: v.five_hour_pct, seven_day_pct: v.seven_day_pct,
    five_h_to_ceiling: c5 - (v.five_hour_pct ?? 0), seven_d_to_ceiling: c7 - (v.seven_day_pct ?? 0) };
  // Authoritative next-window delay. The driver uses this VERBATIM — it is not
  // a suggestion. While `go`, the window is by definition below both ceilings,
  // so a dense cadence is safe: if it ever tightens, the very next evaluate()
  // returns `idle` with sleepSeconds instead. This is what kills long idle gaps.
  out.nextDelaySeconds = Math.max(30, Number(control.CADENCE_SECONDS ?? opts.cadenceSeconds ?? DEFAULT_CADENCE_SECONDS));
  // Annotation only (does NOT gate spend): main/CI health for the driver's
  // auto-PR escalation. Computed only on the `go` path, where it's actionable.
  if (opts.checkMainCI !== false) out.mainCI = checkMainCI(autoloopDir, path.dirname(autoloopDir));
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] || path.join(process.cwd(), '.autoloop');
  const r = evaluate(dir);
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exit(r.action === 'go' ? 0 : r.action === 'idle' ? 1 : 2);
}
