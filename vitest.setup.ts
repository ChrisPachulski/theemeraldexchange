// Per-worker DB isolation for the test suite.
//
// WHY: vitest runs test files in parallel workers by default. Several backend
// tests open the sqlite singletons (server.db / media.db / iptv.db) WITHOUT
// setting their own *_DB_PATH, so they all fell back to the shared ./data/*.db
// files. Two workers running migrations against the same file at once raced on
// the migrator's `CREATE TABLE schema_migrations` / `INSERT ... version`,
// surfacing intermittently as `SqliteError: UNIQUE constraint failed:
// schema_migrations.version` (or `table schema_migrations already exists`) and
// cascading to spurious 500s on routes that touch the DB (e.g.
// radarr.test.ts "user can list movies" → expected 200, got 500).
//
// FIX: give every worker a unique temp directory for the three sqlite paths,
// BEFORE any test module imports env.ts (setupFiles run before the test files'
// own imports). Tests that set their own *_DB_PATH (invites/members/device/…)
// still win — they assign process.env in vi.hoisted, which runs even earlier.
//
// This only sets a DEFAULT when the path is otherwise unset, so it never
// overrides a test's deliberate path choice.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// VITEST_WORKER_ID is unique per worker; fall back to pid for safety. The
// mkdtemp suffix guarantees uniqueness even if two setups somehow collide.
const workerId = process.env.VITEST_WORKER_ID ?? String(process.pid)
const dir = mkdtempSync(join(tmpdir(), `eex-vitest-w${workerId}-`))

if (!process.env.SERVER_DB_PATH) process.env.SERVER_DB_PATH = join(dir, 'server.db')
if (!process.env.MEDIA_DB_PATH) process.env.MEDIA_DB_PATH = join(dir, 'media.db')
if (!process.env.IPTV_DB_PATH) process.env.IPTV_DB_PATH = join(dir, 'iptv.db')
