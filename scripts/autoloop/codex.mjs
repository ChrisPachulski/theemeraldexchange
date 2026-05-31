#!/usr/bin/env node
// scripts/autoloop/codex.mjs
//
// The autoloop's ONLY execution engine: a thin, robust wrapper around the
// codex-companion `task` subcommand. We use codex (flat-rate ChatGPT Business)
// and NEVER `claude -p` — see project memory `project-codex-over-claude-p`.
//
// Library API:
//   import { runCodex, latestRollupTelemetry } from './codex.mjs'
//   const r = await runCodex({ prompt, effort='xhigh', model='gpt-5.5',
//                              write=false, cwd, timeoutMs=1_500_000 })
//   r => { ok, status, threadId, output, touchedFiles, tokens, rateLimited, raw, error }
//
// CLI (for smoke tests):
//   node codex.mjs --effort xhigh "prompt"           # read-only
//   node codex.mjs --write --effort high "prompt"    # workspace-write
//
// Findings baked in (verified 2026-05-31):
//   * `task --json` emits clean JSON on stdout, progress on stderr.
//   * stdout JSON = { status, threadId, rawOutput, touchedFiles, reasoningSummary }
//     status 0 = success; rawOutput = final assistant message (can be "" on
//     `--effort minimal`, so callers must treat empty output as a soft failure).
//   * The rollout filename embeds the threadId:
//     ~/.codex/sessions/<Y>/<M>/<D>/rollout-<ts>-<threadId>.jsonl
//     → exact per-task telemetry attribution (token_count + rate_limits).

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const VALID_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

// Discover the codex-companion.mjs path (newest installed version), instead of
// pinning a version that a codex update would invalidate.
export function findCompanion() {
  const base = path.join(homedir(), '.claude', 'plugins', 'cache', 'openai-codex', 'codex');
  if (!existsSync(base)) throw new Error(`codex plugin dir not found: ${base}`);
  const versions = readdirSync(base)
    .map((v) => ({ v, p: path.join(base, v, 'scripts', 'codex-companion.mjs') }))
    .filter((x) => existsSync(x.p))
    .sort((a, b) => (a.v < b.v ? 1 : -1)); // newest version string first
  if (!versions.length) throw new Error(`no codex-companion.mjs under ${base}`);
  return versions[0].p;
}

// Find the rollout-*.jsonl for a given threadId. The id is embedded in the
// filename, so a single `find` is exact and fast.
export function rolloutPathForThread(threadId) {
  if (!threadId) return null;
  const sessions = path.join(homedir(), '.codex', 'sessions');
  if (!existsSync(sessions)) return null;
  try {
    const out = execFileSync('find', [sessions, '-name', `*${threadId}.jsonl`], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    const lines = out.split('\n').filter(Boolean);
    return lines.length ? lines[0] : null;
  } catch {
    return null;
  }
}

// Parse the last token_count event from a rollout file → usage + rate-limit.
export function parseRollupTelemetry(rolloutPath) {
  if (!rolloutPath || !existsSync(rolloutPath)) return null;
  let last = null;
  try {
    const lines = readFileSync(rolloutPath, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i];
      if (!ln.includes('"token_count"')) continue;
      try {
        const j = JSON.parse(ln);
        if (j?.payload?.type === 'token_count') { last = j.payload; break; }
      } catch { /* skip malformed line */ }
    }
  } catch { return null; }
  if (!last) return null;
  const rl = last.rate_limits || {};
  return {
    tokens: last.info?.total_token_usage || null,
    contextWindow: last.info?.model_context_window || null,
    lastUsage: last.info?.last_token_usage || null,
    rateLimitReached: rl.rate_limit_reached_type ?? null,
    planType: rl.plan_type ?? null,
    unlimited: rl.credits?.unlimited ?? null,
  };
}

// Telemetry from the single newest rollout across all sessions (used by the
// guard when there's no specific threadId in hand).
export function latestRollupTelemetry() {
  const sessions = path.join(homedir(), '.codex', 'sessions');
  if (!existsSync(sessions)) return null;
  let newest = null;
  let newestMtime = 0;
  const walk = (dir) => {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try {
          const m = statSync(p).mtimeMs;
          if (m > newestMtime) { newestMtime = m; newest = p; }
        } catch { /* ignore */ }
      }
    }
  };
  walk(sessions);
  return parseRollupTelemetry(newest);
}

export function runCodex(opts = {}) {
  const {
    prompt,
    effort = 'xhigh',
    model = 'gpt-5.5',
    write = false,
    cwd = process.cwd(),
    timeoutMs = 1_500_000, // 25 min, matches invoke_codex.sh
  } = opts;

  if (!prompt || !String(prompt).trim()) {
    return Promise.resolve({ ok: false, error: 'empty_prompt' });
  }
  if (!VALID_EFFORTS.has(effort)) {
    return Promise.resolve({ ok: false, error: `bad_effort:${effort}` });
  }

  const companion = findCompanion();
  const args = ['task', '--json', '--effort', effort, '--model', model];
  if (write) args.push('--write');
  args.push(String(prompt));

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(process.execPath, [companion, ...args], { cwd });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch { /* */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 5000);
      resolve({ ok: false, error: 'timeout', timeoutMs, stderr: stderr.slice(-2000) });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ ok: false, error: `spawn_failed:${err.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);

      let parsed = null;
      try { parsed = JSON.parse(stdout); }
      catch { return resolve({ ok: false, error: 'unparseable_json', exitCode: code, raw: stdout.slice(0, 4000), stderr: stderr.slice(-2000) }); }

      const threadId = parsed.threadId || null;
      const output = typeof parsed.rawOutput === 'string' ? parsed.rawOutput : '';
      const tel = parseRollupTelemetry(rolloutPathForThread(threadId));

      resolve({
        ok: parsed.status === 0 && output.trim().length > 0,
        status: parsed.status,
        exitCode: code,
        threadId,
        output,
        touchedFiles: parsed.touchedFiles || [],
        reasoningSummary: parsed.reasoningSummary || [],
        tokens: tel?.tokens || null,
        contextWindow: tel?.contextWindow || null,
        rateLimited: tel ? tel.rateLimitReached != null : false,
        rateLimitReached: tel?.rateLimitReached ?? null,
        telemetry: tel,
        raw: parsed,
      });
    });
  });
}

// ---- CLI ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  let write = false, effort = 'xhigh', model = 'gpt-5.5';
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--write') write = true;
    else if (argv[i] === '--effort') effort = argv[++i];
    else if (argv[i] === '--model') model = argv[++i];
    else rest.push(argv[i]);
  }
  const prompt = rest.join(' ');
  runCodex({ prompt, effort, model, write }).then((r) => {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exit(r.ok ? 0 : 1);
  });
}
