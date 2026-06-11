// Wrap `napi build` so the hand-authored index.d.ts survives.
//
// The napi-rs v3 CLI clobbers the file to 0 bytes when invoked against a
// napi 2.16 crate (the CLI assumes it owns the .d.ts, but napi 2.16
// doesn't emit one, so the result is an empty overwrite). This wrapper:
//
//   1. Snapshots the existing .d.ts (or restores from git if already
//      clobbered before the build starts — happens when prior runs left
//      a dirty working copy).
//   2. Invokes `napi build` with whatever args were passed through.
//   3. If the post-build file differs from the snapshot IN ANY WAY
//      (deleted, truncated, OR rewritten to different content of any
//      length), writes the snapshot back. A pure length comparison is
//      not enough: a CLI that emits its own stub .d.ts could produce a
//      LONGER file that still clobbers the hand-authored contract.
//
// Exit code matches the CLI's so CI fails honestly when the build fails.

import { spawnSync, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const CRATE_DIR = resolve(dirname(__filename), '..')
const DTS_PATH = resolve(CRATE_DIR, 'index.d.ts')

function snapshotDts() {
  if (!existsSync(DTS_PATH)) return null
  const buf = readFileSync(DTS_PATH)
  // Empty/near-empty file means a previous clobber survived — try to
  // restore from git first so we snapshot the intended contract, not
  // the corrupted current state.
  if (buf.length < 128) {
    try {
      execFileSync('git', ['checkout', '--', DTS_PATH], {
        cwd: CRATE_DIR,
        stdio: 'pipe',
      })
      return readFileSync(DTS_PATH)
    } catch {
      // Git not available or file not tracked yet — fall back to
      // whatever we have. Better than nothing.
      return buf
    }
  }
  return buf
}

const before = snapshotDts()
const beforeLen = before ? before.length : 0

const args = process.argv.slice(2)
const napiArgs = args.length > 0 ? args : ['build', '--platform', '--release']

// `napi` is the binary @napi-rs/cli exposes. npx resolves it from
// node_modules/.bin if installed (the common case — the workspace lists
// it as a devDependency); falls back to fetch when invoked from a
// hermetic build (Docker stage 1) where node_modules is absent.
const result = spawnSync('npx', ['--yes', 'napi', ...napiArgs], {
  cwd: CRATE_DIR,
  stdio: 'inherit',
})

if (before) {
  // Restore on ANY divergence from the snapshot: deletion, truncation, or a
  // same/greater-length rewrite. The hand-authored .d.ts is the contract;
  // nothing the CLI writes during a napi-2.16 build is ever an improvement.
  const after = existsSync(DTS_PATH) ? readFileSync(DTS_PATH) : null
  if (after === null || !after.equals(before)) {
    writeFileSync(DTS_PATH, before)
    console.warn(
      `[build-with-dts-guard] restored index.d.ts (${beforeLen} bytes) — ` +
        `napi-rs CLI ${after === null ? 'deleted it' : `rewrote it to ${after.length} bytes`} during build.`,
    )
  }
}

process.exit(result.status ?? 1)
