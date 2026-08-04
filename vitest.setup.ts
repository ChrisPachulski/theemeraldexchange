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

// localStorage shim for the jsdom environment (*.dom.test.tsx).
//
// WHY: Node >= 25 exposes `localStorage`/`sessionStorage` as own globals, but
// they are unusable unless the process was started with --localstorage-file.
// Vitest's jsdom setup copies a window property onto the global only when the
// key is absent from the global OR present in its own KEYS list
// (node_modules/vitest/dist/chunks/*.js, getWindowKeys) — and that list
// predates Web Storage in Node, so it contains neither name. Node's inert
// global therefore wins the slot and jsdom's real localStorage is never
// installed: `window === globalThis`, so there is no second copy to reach.
//
// The two Node lines fail DIFFERENTLY, which is why this probes for a usable
// Storage rather than for `undefined`: on 26 the global reads back undefined,
// but on 25 it is an object whose methods are missing, so a typeof check
// passes and the first `localStorage.clear()` throws
// "localStorage.clear is not a function". Reading it can also throw outright,
// hence the try/catch.
//
// Installs an in-memory Storage — the same lifetime jsdom's own gives (fresh
// per test file, no disk). Node-environment tests are untouched: the guard
// requires a `document`, which only the jsdom environment provides.
function hasUsableLocalStorage(): boolean {
  try {
    const ls = globalThis.localStorage as Storage | undefined
    return (
      !!ls &&
      typeof ls.getItem === 'function' &&
      typeof ls.setItem === 'function' &&
      typeof ls.removeItem === 'function' &&
      typeof ls.clear === 'function'
    )
  } catch {
    return false
  }
}

if (typeof document !== 'undefined' && !hasUsableLocalStorage()) {
  const store = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return store.size
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(String(k)) ?? null,
    setItem: (k: string, v: string) => void store.set(String(k), String(v)),
    removeItem: (k: string) => void store.delete(String(k)),
    clear: () => store.clear(),
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
}
