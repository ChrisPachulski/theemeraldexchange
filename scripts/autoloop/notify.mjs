#!/usr/bin/env node
// scripts/autoloop/notify.mjs — the loop's outbound channels.
//   email:     gws gmail +send → pachun95@gmail.com (verified headless)
//   osascript: macOS desktop notification (instant, no auth)
//
// Errors / issues / cancellation ALWAYS email, regardless of NOTIFY config.

import { execFileSync } from 'node:child_process';

const TO = 'pachun95@gmail.com';

export function email(subject, body) {
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
