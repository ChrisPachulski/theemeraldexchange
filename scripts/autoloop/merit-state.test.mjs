// scripts/autoloop/merit-state.test.mjs
// Pins the done-detection rule: a DONE/CONFIRMED/LANDED marker retires the item the line
// is ABOUT (IDs left of the marker), NOT a "next item" named after it. Regression test for
// the prose-collision bug that twice falsely retired the next backlog item
// ("V1.2 — DONE … next top-open = V1.3" must NOT mark V1.3 done).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'merit-state.mjs');

function runMerit(backlog, iterlog) {
  const dir = mkdtempSync(join(tmpdir(), 'merit-'));
  try {
    writeFileSync(join(dir, 'RESEARCH-BACKLOG.md'), backlog);
    writeFileSync(join(dir, 'iteration-log.md'), iterlog);
    const out = execFileSync('node', [SCRIPT, dir], { encoding: 'utf8' });
    return JSON.parse(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BACKLOG = [
  '### Tier 1',
  '- **V1.1** first item',
  '- **V1.2** second item',
  '- **V1.3** third item',
  '- **V1.4** fourth item',
].join('\n');

test('a DONE line retires only the item it is about, not a "next item" named after the marker', () => {
  const log = '## window\n- **V1.2 — DONE / CONFIRMED.** next top-open = V1.3 Assured-improvement delta.\n';
  const r = runMerit(BACKLOG, log);
  assert.ok(r.doneIds.includes('V1.2'), 'V1.2 (before the marker) must be done');
  assert.ok(!r.doneIds.includes('V1.3'), 'V1.3 (a next-item reference after the marker) must NOT be done');
  assert.equal(r.topOpen, 'V1.3', 'topOpen should be the genuinely-next item V1.3');
});

test('a bare mention without a marker does not retire an item', () => {
  const log = '## window\n- consider working on V1.1 next, it is important\n';
  const r = runMerit(BACKLOG, log);
  assert.equal(r.doneIds.length, 0, 'no DONE marker → nothing retired');
  assert.equal(r.topOpen, 'V1.1');
});

test('multiple done items before markers on separate lines all retire', () => {
  const log = '## w\n- **V1.1** — DONE\n- **V1.2** — CONFIRMED\n';
  const r = runMerit(BACKLOG, log);
  assert.deepEqual(r.doneIds.sort(), ['V1.1', 'V1.2']);
  assert.equal(r.topOpen, 'V1.3');
});

test('empty backlog → consult to seed', () => {
  const r = runMerit('# no items here', '');
  assert.equal(r.consult, true);
});

test('open items remain → consult is false', () => {
  const r = runMerit(BACKLOG, '## w\n- **V1.1** — DONE\n');
  assert.equal(r.consult, false);
});
