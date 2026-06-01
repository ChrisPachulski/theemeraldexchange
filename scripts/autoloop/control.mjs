#!/usr/bin/env node
// scripts/autoloop/control.mjs
//
// Parse the user-owned .autoloop/CONTROL.md knobs. Tolerant of markdown: it
// reads simple `KEY: value` lines (inside or outside a fenced ```control block).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  MASTER: 'OFF',
  ALLOWED_HOURS: '00:00-23:59',
  MAX_TOKENS_PER_WINDOW: 4_000_000,
  NOTIFY: 'osascript',
  SCOPE: 'anything',
  // Seconds between windows while the guard says `go` (window healthy). The
  // driver uses the guard's nextDelaySeconds VERBATIM, so this is the hard
  // upper bound on idle time during a healthy window — no lazy 30-min gaps.
  CADENCE_SECONDS: 120,
  // Max age (seconds) of a usage read the guard will trust. Older than this and
  // it idles rather than spend on unverifiable headroom (the usage API 429s, so
  // reads can go stale). Windows move slowly, so 600s is accurate enough.
  USAGE_STALE_SECONDS: 600,
  // Claude-window ceilings (%) — stay under 100 so the loop never pushes into
  // paid overage. The guard idles until reset when a ceiling is hit.
  FIVE_HOUR_CEILING: 85,
  SEVEN_DAY_CEILING: 90,
};

const KNOWN = new Set(Object.keys(DEFAULTS));

export function readControl(autoloopDir = path.join(process.cwd(), '.autoloop')) {
  const file = path.join(autoloopDir, 'CONTROL.md');
  const cfg = { ...DEFAULTS };
  if (!existsSync(file)) return { ...cfg, _missing: true };
  const text = readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1];
    if (!KNOWN.has(key)) continue;
    let val = m[2].replace(/`/g, '').trim();
    if (key === 'MAX_TOKENS_PER_WINDOW') val = parseInt(val, 10) || DEFAULTS.MAX_TOKENS_PER_WINDOW;
    if (key === 'MASTER') val = val.toUpperCase();
    cfg[key] = val;
  }
  return cfg;
}

// Is `now` within ALLOWED_HOURS (local time)? Supports windows that wrap midnight.
export function withinAllowedHours(allowed, now = new Date()) {
  const m = String(allowed).match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return true;
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = (+m[1]) * 60 + (+m[2]);
  const end = (+m[3]) * 60 + (+m[4]);
  return start <= end ? (cur >= start && cur <= end) : (cur >= start || cur <= end);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] || path.join(process.cwd(), '.autoloop');
  const cfg = readControl(dir);
  process.stdout.write(JSON.stringify({ ...cfg, within_hours: withinAllowedHours(cfg.ALLOWED_HOURS) }, null, 2) + '\n');
}
