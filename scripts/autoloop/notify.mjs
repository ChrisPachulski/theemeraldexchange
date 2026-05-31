#!/usr/bin/env node
// scripts/autoloop/notify.mjs — the loop's outbound channels.
//   email:     gws gmail +send → recipient resolved by resolveTo() below
//   osascript: macOS desktop notification (instant, no auth)
//
// Errors / issues / cancellation ALWAYS email, regardless of NOTIFY config.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Recipient is resolved WITHOUT hardcoding an address in tracked source:
//   1. $AUTOLOOP_NOTIFY_TO env var
//   2. .autoloop/notify.env (gitignored, local-only pin)
//   3. git user.email
//   4. else → email channel is skipped
function resolveTo() {
  if (process.env.AUTOLOOP_NOTIFY_TO) return process.env.AUTOLOOP_NOTIFY_TO.trim();
  try {
    const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const env = readFileSync(join(repo, '.autoloop', 'notify.env'), 'utf8');
    const m = env.match(/^\s*AUTOLOOP_NOTIFY_TO\s*=\s*(.+?)\s*$/m);
    if (m && m[1]) return m[1].trim();
  } catch { /* no local pin */ }
  try {
    return execFileSync('git', ['config', 'user.email'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const TO = resolveTo();

export function email(subject, body) {
  if (!TO) {
    process.stderr.write('notify.email skipped: no AUTOLOOP_NOTIFY_TO / git user.email set\n');
    return false;
  }
  try {
    execFileSync('gws', ['gmail', '+send', '--to', TO, '--subject', subject, '--body', body],
      { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch (e) {
    process.stderr.write(`notify.email failed: ${e.message}\n`);
    return false;
  }
}

export function desktop(title, message) {
  try {
    const safe = String(message).replace(/"/g, "'").slice(0, 400);
    execFileSync('osascript', ['-e', `display notification "${safe}" with title "${title}"`],
      { timeout: 5000, stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch { return false; }
}

// channels: array like ['osascript','email']. Errors override → always email.
export function notify({ subject, body, channels = ['osascript'], isError = false }) {
  const ch = new Set(channels);
  if (isError) ch.add('email');
  let ok = true;
  if (ch.has('email')) ok = email(subject, body) && ok;
  if (ch.has('osascript')) desktop('autoloop', subject);
  return ok;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const subject = process.argv[2] || '[autoloop] test';
  const body = process.argv[3] || 'notify.mjs test';
  const ok = notify({ subject, body, channels: ['osascript', 'email'] });
  process.stdout.write(`notified ok=${ok}\n`);
}
