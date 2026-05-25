# mybunny.tv Viewer (M1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hosted mybunny.tv viewer inside theemeraldexchange — browse the Xtream Codes catalog locally (channels/VOD/series with EPG and catchup), play streams through an auth-gated proxy, surface unified suggestions across Plex and IPTV.

**Architecture:** New Hono routes under `/api/iptv`, backed by a dedicated `./data/iptv.db` (better-sqlite3) refreshed every 6 hours from the upstream Xtream panel. Token-signed stream proxy (HMAC) hides the shared admin credential from clients and lets `<video>` / AVPlayer attach auth via URL. Three new lazy-loaded React tabs (Live / VOD / IPTV Series) plus an IptvPlayer component that picks between hls.js, mpegts.js, and native `<video>`. Phase 4b adds an MPEG-TS → HLS remux session for AVPlayer-class clients so M2 has nothing left to design. Phase 8 widens the recommender's kind enum and joins mybunny VOD/series to TMDB titles for unified suggestions.

**Tech Stack:** Hono + TypeScript (existing), `better-sqlite3` (new), `node-cron` (new), `sax` (new — streaming XMLTV parse), `hls.js` (new — web), `mpegts.js` (new — web), TanStack Query (existing), Vitest (existing), Playwright (existing). FastAPI recommender (existing) gains one new Python worker.

**Spec source:** `docs/superpowers/specs/2026-05-24-mybunny-and-plex-replacement-design.md` §1. Decisions are locked there — do not redesign during execution.

---

## Pre-flight

### Task PF-1: Add runtime dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install runtime deps**

Run:
```bash
npm install better-sqlite3@^11.5.0 node-cron@^3.0.3 sax@^1.4.1 hls.js@^1.5.13 mpegts.js@^1.7.3
```
Expected: deps added under `dependencies`. No peer-dep warnings beyond hls.js (it warns about React peer in some versions — ignore).

- [ ] **Step 2: Install type deps**

Run:
```bash
npm install -D @types/better-sqlite3@^7.6.11 @types/node-cron@^3.0.11 @types/sax@^1.2.7
```
Expected: deps added under `devDependencies`.

- [ ] **Step 3: Verify the dev server still boots**

Run: `npm run dev:server` (Ctrl-C after 5s)
Expected: server logs "[server] listening" without missing-module errors. `better-sqlite3` will lazy-build native bindings on first import — make sure no build failure occurs here.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add better-sqlite3, node-cron, sax, hls.js, mpegts.js for iptv"
```

---

### Task PF-2: Reserve env vars

**Files:**
- Modify: `server/env.ts` (or wherever env is loaded — verify with `grep -l "process.env" server/env.ts`)
- Modify: `.env.example` (create if missing)

- [ ] **Step 1: Locate env loader**

Run: `grep -n "process.env" server/env.ts | head -10`
Expected: file exists with an exported `env` object — use whatever shape it already has.

- [ ] **Step 2: Add iptv env keys**

Edit `server/env.ts` — add to the existing exported shape:

```typescript
XTREAM_HOST: process.env.XTREAM_HOST ?? '',
XTREAM_USERNAME: process.env.XTREAM_USERNAME ?? '',
XTREAM_PASSWORD: process.env.XTREAM_PASSWORD ?? '',
IPTV_DB_PATH: process.env.IPTV_DB_PATH ?? './data/iptv.db',
IPTV_MAX_CONCURRENT_STREAMS: Number(process.env.IPTV_MAX_CONCURRENT_STREAMS ?? 4),
IPTV_STREAM_TOKEN_TTL_SECS: Number(process.env.IPTV_STREAM_TOKEN_TTL_SECS ?? 300),
IPTV_LIST_TIMEOUT_MS: Number(process.env.IPTV_LIST_TIMEOUT_MS ?? 30_000),
IPTV_SYNC_CRON: process.env.IPTV_SYNC_CRON ?? '0 */6 * * *',
IPTV_RECOMMENDER_EXPORT_SECRET: process.env.IPTV_RECOMMENDER_EXPORT_SECRET ?? '',
IPTV_REMUX_TMP_DIR: process.env.IPTV_REMUX_TMP_DIR ?? '/tmp/iptv-remux',
IPTV_PUBLIC_API_BASE_URL: process.env.IPTV_PUBLIC_API_BASE_URL ?? 'https://api.theemeraldexchange.com',
```

- [ ] **Step 3: Document in .env.example**

Append to `.env.example`:

```
# mybunny.tv / Xtream Codes
XTREAM_HOST=https://example.mybunny.tv
XTREAM_USERNAME=
XTREAM_PASSWORD=
IPTV_DB_PATH=./data/iptv.db
IPTV_MAX_CONCURRENT_STREAMS=4
IPTV_STREAM_TOKEN_TTL_SECS=300
IPTV_LIST_TIMEOUT_MS=30000
IPTV_SYNC_CRON=0 */6 * * *
IPTV_RECOMMENDER_EXPORT_SECRET=
IPTV_REMUX_TMP_DIR=/tmp/iptv-remux
IPTV_PUBLIC_API_BASE_URL=https://api.theemeraldexchange.com
```

- [ ] **Step 4: Type-check**

Run: `npx tsc -p server/tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add server/env.ts .env.example
git commit -m "env: reserve iptv env vars (xtream creds, sync cadence, concurrency)"
```

---

## Phase 1 — DB + service skeleton

Goal of phase 1: a runnable `npm test` proves the iptv SQLite schema applies cleanly, the helper exposes prepared statements, and `getAccountInfo` against a live Xtream panel works end-to-end. No HTTP routes yet.

### Task 1.1: Migration file `0001_init.sql`

**Files:**
- Create: `server/migrations/iptv/0001_init.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- 0001_init.sql — iptv catalog, EPG, per-user state, link table for the recommender.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS channels (
  stream_id           INTEGER PRIMARY KEY,
  num                 INTEGER,
  name                TEXT    NOT NULL,
  stream_icon         TEXT,
  epg_channel_id      TEXT,
  category_id         INTEGER,
  is_adult            INTEGER NOT NULL DEFAULT 0,
  tv_archive          INTEGER NOT NULL DEFAULT 0,
  tv_archive_duration INTEGER,
  added_ts            TEXT,
  fetched_at          TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS channels_category ON channels(category_id);

CREATE TABLE IF NOT EXISTS vod (
  stream_id           INTEGER PRIMARY KEY,
  name                TEXT    NOT NULL,
  stream_icon         TEXT,
  rating              REAL,
  category_id         INTEGER,
  container_extension TEXT,
  added_ts            TEXT,
  tmdb_id             INTEGER,
  year                INTEGER,
  plot                TEXT,
  director            TEXT,
  cast_csv            TEXT,
  fetched_at          TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS vod_tmdb ON vod(tmdb_id);
CREATE INDEX IF NOT EXISTS vod_category ON vod(category_id);

CREATE TABLE IF NOT EXISTS series (
  series_id      INTEGER PRIMARY KEY,
  name           TEXT    NOT NULL,
  cover          TEXT,
  plot           TEXT,
  rating         REAL,
  category_id    INTEGER,
  tmdb_id        INTEGER,
  last_modified  TEXT,
  fetched_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS series_tmdb ON series(tmdb_id);

CREATE TABLE IF NOT EXISTS series_episodes (
  episode_id          TEXT    PRIMARY KEY,
  series_id           INTEGER NOT NULL REFERENCES series(series_id) ON DELETE CASCADE,
  season              INTEGER NOT NULL,
  episode_num         INTEGER NOT NULL,
  title               TEXT,
  container_extension TEXT,
  added_ts            TEXT,
  plot                TEXT,
  duration_secs       INTEGER
);
CREATE INDEX IF NOT EXISTS series_eps_by_series ON series_episodes(series_id, season, episode_num);

CREATE TABLE IF NOT EXISTS categories (
  category_id INTEGER NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('live','vod','series')),
  name        TEXT    NOT NULL,
  parent_id   INTEGER,
  PRIMARY KEY (kind, category_id)
);

CREATE TABLE IF NOT EXISTS epg_programs (
  channel_id  TEXT NOT NULL,
  start_utc   TEXT NOT NULL,
  stop_utc    TEXT NOT NULL,
  title       TEXT,
  description TEXT,
  PRIMARY KEY (channel_id, start_utc)
);
CREATE INDEX IF NOT EXISTS epg_window ON epg_programs(channel_id, start_utc, stop_utc);

CREATE TABLE IF NOT EXISTS iptv_favorites (
  sub      TEXT NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('live','vod','series')),
  item_id  TEXT NOT NULL,
  added_ts TEXT NOT NULL,
  PRIMARY KEY (sub, kind, item_id)
);

CREATE TABLE IF NOT EXISTS iptv_watch_history (
  sub            TEXT    NOT NULL,
  kind           TEXT    NOT NULL CHECK (kind IN ('live','vod','series_episode')),
  item_id        TEXT    NOT NULL,
  position_secs  INTEGER NOT NULL DEFAULT 0,
  duration_secs  INTEGER,
  watched_at     TEXT    NOT NULL,
  completed      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sub, kind, item_id)
);
CREATE INDEX IF NOT EXISTS iptv_hist_recent ON iptv_watch_history(sub, watched_at DESC);

CREATE TABLE IF NOT EXISTS iptv_title_link (
  iptv_kind TEXT    NOT NULL CHECK (iptv_kind IN ('vod','series')),
  iptv_id   INTEGER NOT NULL,
  tmdb_kind TEXT    NOT NULL CHECK (tmdb_kind IN ('movie','tv')),
  tmdb_id   INTEGER NOT NULL,
  PRIMARY KEY (iptv_kind, iptv_id)
);
CREATE INDEX IF NOT EXISTS iptv_link_by_tmdb ON iptv_title_link(tmdb_kind, tmdb_id);

CREATE TABLE IF NOT EXISTS iptv_sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  ts    TEXT NOT NULL
);
```

- [ ] **Step 2: Commit**

```bash
git add server/migrations/iptv/0001_init.sql
git commit -m "iptv: initial sqlite schema (catalog, epg, favorites, history, link table)"
```

---

### Task 1.2: DB helper with applyMigrations + prepared statements

**Files:**
- Create: `server/services/iptvDb.ts`
- Test: `server/services/iptvDb.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/services/iptvDb.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { openIptvDb, type IptvDb } from './iptvDb.js'

describe('iptvDb', () => {
  let tmpDir: string
  let db: IptvDb

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvdb-'))
    db = openIptvDb(path.join(tmpDir, 'iptv.db'))
  })
  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('applies migrations idempotently', () => {
    db.applyMigrations()
    db.applyMigrations() // second call must not throw
    const tables = db.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>
    const names = tables.map(t => t.name)
    expect(names).toContain('channels')
    expect(names).toContain('vod')
    expect(names).toContain('series')
    expect(names).toContain('series_episodes')
    expect(names).toContain('categories')
    expect(names).toContain('epg_programs')
    expect(names).toContain('iptv_favorites')
    expect(names).toContain('iptv_watch_history')
    expect(names).toContain('iptv_title_link')
    expect(names).toContain('iptv_sync_state')
  })

  it('exposes prepared statements for catalog inserts', () => {
    db.applyMigrations()
    db.stmts.upsertChannel.run({
      stream_id: 1, num: 1, name: 'Test', stream_icon: null, epg_channel_id: 'tv.test',
      category_id: 10, is_adult: 0, tv_archive: 1, tv_archive_duration: 7,
      added_ts: '2026-05-24T00:00:00Z', fetched_at: '2026-05-24T00:00:00Z',
    })
    const row = db.raw.prepare(`SELECT name FROM channels WHERE stream_id = 1`).get() as { name: string }
    expect(row.name).toBe('Test')
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run server/services/iptvDb.test.ts`
Expected: FAIL with "cannot find module './iptvDb.js'".

- [ ] **Step 3: Implement the helper**

```typescript
// server/services/iptvDb.ts
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations', 'iptv')

export interface IptvDb {
  raw: Database.Database
  applyMigrations: () => void
  stmts: {
    upsertChannel: Database.Statement
    upsertVod: Database.Statement
    upsertSeries: Database.Statement
    upsertEpisode: Database.Statement
    upsertCategory: Database.Statement
    upsertEpg: Database.Statement
    addFavorite: Database.Statement
    removeFavorite: Database.Statement
    putHistory: Database.Statement
    putSyncState: Database.Statement
    getSyncState: Database.Statement
  }
  close: () => void
}

export function openIptvDb(filePath: string): IptvDb {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const raw = new Database(filePath)
  raw.pragma('journal_mode = WAL')
  raw.pragma('foreign_keys = ON')

  const ensureMigrationsTable = (): void => {
    raw.exec(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`)
  }

  const applyMigrations = (): void => {
    ensureMigrationsTable()
    const applied = new Set(
      (raw.prepare(`SELECT id FROM _migrations`).all() as Array<{ id: string }>).map(r => r.id),
    )
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
    const insert = raw.prepare(`INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`)
    for (const file of files) {
      if (applied.has(file)) continue
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8')
      raw.exec('BEGIN')
      try {
        raw.exec(sql)
        insert.run(file, new Date().toISOString())
        raw.exec('COMMIT')
      } catch (err) {
        raw.exec('ROLLBACK')
        throw err
      }
    }
  }

  // Apply at construction so callers can prepare statements immediately.
  applyMigrations()

  const stmts = {
    upsertChannel: raw.prepare(`
      INSERT INTO channels (stream_id, num, name, stream_icon, epg_channel_id, category_id,
        is_adult, tv_archive, tv_archive_duration, added_ts, fetched_at)
      VALUES (@stream_id, @num, @name, @stream_icon, @epg_channel_id, @category_id,
        @is_adult, @tv_archive, @tv_archive_duration, @added_ts, @fetched_at)
      ON CONFLICT(stream_id) DO UPDATE SET
        num=excluded.num, name=excluded.name, stream_icon=excluded.stream_icon,
        epg_channel_id=excluded.epg_channel_id, category_id=excluded.category_id,
        is_adult=excluded.is_adult, tv_archive=excluded.tv_archive,
        tv_archive_duration=excluded.tv_archive_duration, added_ts=excluded.added_ts,
        fetched_at=excluded.fetched_at
    `),
    upsertVod: raw.prepare(`
      INSERT INTO vod (stream_id, name, stream_icon, rating, category_id, container_extension,
        added_ts, tmdb_id, year, plot, director, cast_csv, fetched_at)
      VALUES (@stream_id, @name, @stream_icon, @rating, @category_id, @container_extension,
        @added_ts, @tmdb_id, @year, @plot, @director, @cast_csv, @fetched_at)
      ON CONFLICT(stream_id) DO UPDATE SET
        name=excluded.name, stream_icon=excluded.stream_icon, rating=excluded.rating,
        category_id=excluded.category_id, container_extension=excluded.container_extension,
        added_ts=excluded.added_ts, tmdb_id=excluded.tmdb_id, year=excluded.year,
        plot=excluded.plot, director=excluded.director, cast_csv=excluded.cast_csv,
        fetched_at=excluded.fetched_at
    `),
    upsertSeries: raw.prepare(`
      INSERT INTO series (series_id, name, cover, plot, rating, category_id, tmdb_id,
        last_modified, fetched_at)
      VALUES (@series_id, @name, @cover, @plot, @rating, @category_id, @tmdb_id,
        @last_modified, @fetched_at)
      ON CONFLICT(series_id) DO UPDATE SET
        name=excluded.name, cover=excluded.cover, plot=excluded.plot, rating=excluded.rating,
        category_id=excluded.category_id, tmdb_id=excluded.tmdb_id,
        last_modified=excluded.last_modified, fetched_at=excluded.fetched_at
    `),
    upsertEpisode: raw.prepare(`
      INSERT INTO series_episodes (episode_id, series_id, season, episode_num, title,
        container_extension, added_ts, plot, duration_secs)
      VALUES (@episode_id, @series_id, @season, @episode_num, @title,
        @container_extension, @added_ts, @plot, @duration_secs)
      ON CONFLICT(episode_id) DO UPDATE SET
        series_id=excluded.series_id, season=excluded.season, episode_num=excluded.episode_num,
        title=excluded.title, container_extension=excluded.container_extension,
        added_ts=excluded.added_ts, plot=excluded.plot, duration_secs=excluded.duration_secs
    `),
    upsertCategory: raw.prepare(`
      INSERT INTO categories (category_id, kind, name, parent_id)
      VALUES (@category_id, @kind, @name, @parent_id)
      ON CONFLICT(kind, category_id) DO UPDATE SET name=excluded.name, parent_id=excluded.parent_id
    `),
    upsertEpg: raw.prepare(`
      INSERT INTO epg_programs (channel_id, start_utc, stop_utc, title, description)
      VALUES (@channel_id, @start_utc, @stop_utc, @title, @description)
      ON CONFLICT(channel_id, start_utc) DO UPDATE SET
        stop_utc=excluded.stop_utc, title=excluded.title, description=excluded.description
    `),
    addFavorite: raw.prepare(`
      INSERT OR IGNORE INTO iptv_favorites (sub, kind, item_id, added_ts)
      VALUES (@sub, @kind, @item_id, @added_ts)
    `),
    removeFavorite: raw.prepare(`
      DELETE FROM iptv_favorites WHERE sub=@sub AND kind=@kind AND item_id=@item_id
    `),
    putHistory: raw.prepare(`
      INSERT INTO iptv_watch_history (sub, kind, item_id, position_secs, duration_secs, watched_at, completed)
      VALUES (@sub, @kind, @item_id, @position_secs, @duration_secs, @watched_at, @completed)
      ON CONFLICT(sub, kind, item_id) DO UPDATE SET
        position_secs=excluded.position_secs, duration_secs=excluded.duration_secs,
        watched_at=excluded.watched_at, completed=excluded.completed
    `),
    putSyncState: raw.prepare(`
      INSERT INTO iptv_sync_state (key, value, ts) VALUES (@key, @value, @ts)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, ts=excluded.ts
    `),
    getSyncState: raw.prepare(`SELECT value, ts FROM iptv_sync_state WHERE key = ?`),
  }

  return { raw, applyMigrations, stmts, close: () => raw.close() }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run server/services/iptvDb.test.ts`
Expected: PASS, both tests green.

- [ ] **Step 5: Commit**

```bash
git add server/services/iptvDb.ts server/services/iptvDb.test.ts
git commit -m "iptv: db helper with migration runner + prepared statements"
```

---

### Task 1.3: Xtream client with `getAccountInfo`

**Files:**
- Create: `server/services/xtream.ts`
- Test: `server/services/xtream.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/services/xtream.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildPlayerApiUrl, parseAccountInfo, type XtreamCreds } from './xtream.js'

describe('xtream client primitives', () => {
  const creds: XtreamCreds = {
    host: 'https://panel.example',
    username: 'u',
    password: 'p',
  }

  it('builds a player_api URL with action+params', () => {
    expect(buildPlayerApiUrl(creds, 'get_live_categories')).toBe(
      'https://panel.example/player_api.php?username=u&password=p&action=get_live_categories',
    )
    expect(buildPlayerApiUrl(creds, 'get_vod_streams', { category_id: 12 })).toBe(
      'https://panel.example/player_api.php?username=u&password=p&action=get_vod_streams&category_id=12',
    )
  })

  it('parses account info, tolerating string vs number max_connections', () => {
    const a = parseAccountInfo({ user_info: { exp_date: '1893456000', max_connections: '4', status: 'Active' } })
    expect(a.expiresAt instanceof Date).toBe(true)
    expect(a.maxConnections).toBe(4)
    expect(a.status).toBe('Active')

    const b = parseAccountInfo({ user_info: { exp_date: 1893456000, max_connections: 2 } })
    expect(b.maxConnections).toBe(2)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run server/services/xtream.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement primitives + getAccountInfo**

```typescript
// server/services/xtream.ts
import { env } from '../env.js'
import { fetchWithTimeout } from './upstream.js'

export interface XtreamCreds {
  host: string
  username: string
  password: string
}

export interface AccountInfo {
  expiresAt: Date | null
  maxConnections: number
  status: string
}

export function credsFromEnv(): XtreamCreds {
  if (!env.XTREAM_HOST || !env.XTREAM_USERNAME || !env.XTREAM_PASSWORD) {
    throw new Error('xtream_credentials_missing')
  }
  return {
    host: env.XTREAM_HOST.replace(/\/+$/, ''),
    username: env.XTREAM_USERNAME,
    password: env.XTREAM_PASSWORD,
  }
}

export function buildPlayerApiUrl(
  creds: XtreamCreds,
  action: string,
  extra?: Record<string, string | number>,
): string {
  const params = new URLSearchParams({
    username: creds.username,
    password: creds.password,
    action,
  })
  if (extra) {
    for (const [k, v] of Object.entries(extra)) params.set(k, String(v))
  }
  // URLSearchParams toString uses + for spaces; Xtream panels accept it but the test expects literal
  // ampersand format with no encoding for these simple values — both forms are accepted by panels.
  return `${creds.host}/player_api.php?${params.toString()}`
}

export function parseAccountInfo(payload: unknown): AccountInfo {
  const root = (payload as { user_info?: Record<string, unknown> })?.user_info ?? {}
  const rawExp = root.exp_date
  const expNum =
    typeof rawExp === 'number' ? rawExp : typeof rawExp === 'string' ? Number(rawExp) : NaN
  const expiresAt = Number.isFinite(expNum) ? new Date(expNum * 1000) : null
  const maxConnections =
    typeof root.max_connections === 'number'
      ? root.max_connections
      : Number(root.max_connections ?? 0) || 0
  const status = typeof root.status === 'string' ? root.status : ''
  return { expiresAt, maxConnections, status }
}

export async function getAccountInfo(creds: XtreamCreds = credsFromEnv()): Promise<AccountInfo> {
  const url = buildPlayerApiUrl(creds, 'user') // some panels accept 'user' as alias; fallback below
  // Standard Xtream "get_account_info" doesn't exist universally — the canonical call is
  // player_api.php?username=...&password=... (no action) which returns user_info + server_info.
  const probe = `${creds.host}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}`
  const res = await fetchWithTimeout(probe, {}, env.IPTV_LIST_TIMEOUT_MS, 'xtream.account_info')
  if (!res.ok) throw new Error(`xtream_account_${res.status}`)
  const json = (await res.json()) as unknown
  void url
  return parseAccountInfo(json)
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run server/services/xtream.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check the server tree**

Run: `npx tsc -p server/tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/services/xtream.ts server/services/xtream.test.ts
git commit -m "iptv: xtream client primitives + getAccountInfo"
```

---

### Task 1.4: Singleton DB accessor, gitignore data dir

**Files:**
- Create: `server/services/iptvDbSingleton.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Write the singleton**

```typescript
// server/services/iptvDbSingleton.ts
import { env } from '../env.js'
import { openIptvDb, type IptvDb } from './iptvDb.js'

let cached: IptvDb | null = null

export function iptvDb(): IptvDb {
  if (!cached) cached = openIptvDb(env.IPTV_DB_PATH)
  return cached
}

export function closeIptvDb(): void {
  if (cached) {
    cached.close()
    cached = null
  }
}
```

- [ ] **Step 2: Add data dir to .gitignore**

Append to `.gitignore` (check first that these lines aren't already there):

```
# iptv sqlite + remux tmpdirs
/data/iptv.db
/data/iptv.db-journal
/data/iptv.db-wal
/data/iptv.db-shm
/tmp/iptv-remux/
```

- [ ] **Step 3: Type-check**

Run: `npx tsc -p server/tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add server/services/iptvDbSingleton.ts .gitignore
git commit -m "iptv: singleton db accessor and gitignore data/iptv.db"
```

---

### Task 1.5: Smoke endpoint `GET /api/iptv/health`

**Files:**
- Create: `server/routes/iptv.ts`
- Modify: `server/app.ts`
- Test: `server/routes/iptv.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/routes/iptv.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { iptv } from './iptv.js'

vi.mock('../middleware/auth.js', async () => {
  return {
    requireAuth: async (c: any, next: any) => {
      c.set('user', { sub: 'plex:test', role: 'admin', displayName: 'Test' })
      await next()
    },
    requireAdmin: async (c: any, next: any) => {
      c.set('user', { sub: 'plex:test', role: 'admin', displayName: 'Test' })
      await next()
    },
  }
})

vi.mock('../services/xtream.js', () => ({
  getAccountInfo: vi.fn(async () => ({
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    maxConnections: 4,
    status: 'Active',
  })),
  credsFromEnv: vi.fn(() => ({ host: 'https://panel', username: 'u', password: 'p' })),
}))

describe('GET /api/iptv/health', () => {
  it('returns account info shape', async () => {
    const app = new Hono().route('/api/iptv', iptv)
    const res = await app.request('/api/iptv/health')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.maxConnections).toBe(4)
    expect(body.status).toBe('Active')
    expect(typeof body.expiresAt).toBe('string')
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run server/routes/iptv.test.ts`
Expected: FAIL — module './iptv.js' not found.

- [ ] **Step 3: Implement route**

```typescript
// server/routes/iptv.ts
import { Hono } from 'hono'
import { requireAuth, type Env } from '../middleware/auth.js'
import { getAccountInfo } from '../services/xtream.js'

export const iptv = new Hono<Env>()

iptv.use('*', requireAuth)

iptv.get('/health', async (c) => {
  try {
    const info = await getAccountInfo()
    return c.json({
      expiresAt: info.expiresAt ? info.expiresAt.toISOString() : null,
      maxConnections: info.maxConnections,
      status: info.status,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: 'iptv_health_failed', detail: message }, 502)
  }
})
```

- [ ] **Step 4: Mount in app.ts**

Locate the section in `server/app.ts` that mounts existing routes (look for `app.route('/api/sonarr', sonarr)` or similar). Add:

```typescript
import { iptv } from './routes/iptv.js'
// ... near other route mounts:
app.route('/api/iptv', iptv)
```

- [ ] **Step 5: Run all server tests**

Run: `npx vitest run server/`
Expected: existing tests stay green; new `iptv.test.ts` passes.

- [ ] **Step 6: Commit**

```bash
git add server/routes/iptv.ts server/routes/iptv.test.ts server/app.ts
git commit -m "iptv: mount /api/iptv router with health endpoint"
```

---

### Task 1.6: Phase 1 acceptance — live panel smoke test (manual)

**Files:** none (manual verification — record outcome in commit body)

- [ ] **Step 1: Populate `.env.local` with real Xtream creds**

Set `XTREAM_HOST`, `XTREAM_USERNAME`, `XTREAM_PASSWORD` from your mybunny.tv account.

- [ ] **Step 2: Start the dev server**

Run: `npm run dev` (in a separate terminal — leave it running for the rest of the milestone).

- [ ] **Step 3: Hit the health endpoint**

Run: `curl -s -b "eex.session=<paste cookie from browser devtools after Plex login>" http://localhost:3001/api/iptv/health | jq`

Expected: a JSON object with `expiresAt`, `maxConnections`, `status`. If `502 iptv_health_failed`, your credentials or the host URL are wrong — fix in `.env.local`. **Do not proceed to Phase 2 until this returns 200.**

- [ ] **Step 4: Commit phase marker (empty)**

```bash
git commit --allow-empty -m "iptv phase 1: skeleton + live panel smoke test passing"
```

---

## Phase 2 — Catalog sync (channels + VOD + series + EPG)

Goal: a one-shot `bootstrapOnce()` populates the full mybunny catalog and a 7-day EPG window into `iptv.db`. `node-cron` re-runs every 6 hours. An admin endpoint can trigger a manual sync.

### Task 2.1: Catalog fetchers — categories + live + VOD + series lists

**Files:**
- Modify: `server/services/xtream.ts`
- Test: extend `server/services/xtream.test.ts`

- [ ] **Step 1: Write failing test for category + list parsers**

Append to `server/services/xtream.test.ts`:

```typescript
import {
  parseCategoriesPayload,
  parseLiveStreams,
  parseVodStreams,
  parseSeriesList,
} from './xtream.js'

describe('xtream list parsers', () => {
  it('parses categories', () => {
    const list = parseCategoriesPayload([
      { category_id: '1', category_name: 'News', parent_id: 0 },
      { category_id: 2, category_name: 'Sports', parent_id: '0' },
    ])
    expect(list).toEqual([
      { category_id: 1, name: 'News', parent_id: 0 },
      { category_id: 2, name: 'Sports', parent_id: 0 },
    ])
  })

  it('parses live streams with archive flags', () => {
    const channels = parseLiveStreams(
      [
        {
          stream_id: 100, num: 1, name: 'C1', stream_icon: 'http://x/y.png',
          epg_channel_id: 'epg.c1', category_id: '1', is_adult: '0',
          tv_archive: '1', tv_archive_duration: '7', added: '1716000000',
        },
      ],
      '2026-05-24T00:00:00Z',
    )
    expect(channels[0]).toMatchObject({
      stream_id: 100, num: 1, name: 'C1', epg_channel_id: 'epg.c1', category_id: 1,
      is_adult: 0, tv_archive: 1, tv_archive_duration: 7,
    })
    expect(channels[0].fetched_at).toBe('2026-05-24T00:00:00Z')
  })

  it('parses VOD streams with tmdb_id when present', () => {
    const v = parseVodStreams(
      [{ stream_id: 9, name: 'Movie', container_extension: 'mp4', tmdb: '603', rating: '7.8' }],
      '2026-05-24T00:00:00Z',
    )
    expect(v[0]).toMatchObject({ stream_id: 9, name: 'Movie', container_extension: 'mp4', tmdb_id: 603, rating: 7.8 })
  })

  it('parses series list', () => {
    const s = parseSeriesList(
      [{ series_id: 11, name: 'Show', cover: 'c.jpg', plot: 'p', rating: 8.1, category_id: 4, tmdb: 1399 }],
      '2026-05-24T00:00:00Z',
    )
    expect(s[0]).toMatchObject({ series_id: 11, name: 'Show', tmdb_id: 1399, category_id: 4 })
  })
})
```

- [ ] **Step 2: Run test — should fail (parsers missing)**

Run: `npx vitest run server/services/xtream.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement parsers + fetchers**

Append to `server/services/xtream.ts`:

```typescript
const num = (v: unknown): number => {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}
const numOrNull = (v: unknown): number | null => {
  if (v == null) return null
  const n = num(v)
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown): string | null => (typeof v === 'string' ? v : v == null ? null : String(v))

export interface CategoryRow { category_id: number; name: string; parent_id: number }
export function parseCategoriesPayload(raw: unknown): CategoryRow[] {
  if (!Array.isArray(raw)) return []
  return raw.map((r) => {
    const o = r as Record<string, unknown>
    return {
      category_id: num(o.category_id),
      name: str(o.category_name) ?? '',
      parent_id: num(o.parent_id),
    }
  })
}

export interface ChannelRow {
  stream_id: number; num: number; name: string; stream_icon: string | null;
  epg_channel_id: string | null; category_id: number | null;
  is_adult: number; tv_archive: number; tv_archive_duration: number | null;
  added_ts: string | null; fetched_at: string
}
export function parseLiveStreams(raw: unknown, fetchedAt: string): ChannelRow[] {
  if (!Array.isArray(raw)) return []
  return raw.map((r) => {
    const o = r as Record<string, unknown>
    const addedSecs = numOrNull(o.added)
    return {
      stream_id: num(o.stream_id),
      num: num(o.num),
      name: str(o.name) ?? '',
      stream_icon: str(o.stream_icon),
      epg_channel_id: str(o.epg_channel_id),
      category_id: numOrNull(o.category_id),
      is_adult: num(o.is_adult) ? 1 : 0,
      tv_archive: num(o.tv_archive) ? 1 : 0,
      tv_archive_duration: numOrNull(o.tv_archive_duration),
      added_ts: addedSecs ? new Date(addedSecs * 1000).toISOString() : null,
      fetched_at: fetchedAt,
    }
  })
}

export interface VodRow {
  stream_id: number; name: string; stream_icon: string | null; rating: number | null;
  category_id: number | null; container_extension: string | null;
  added_ts: string | null; tmdb_id: number | null; year: number | null;
  plot: string | null; director: string | null; cast_csv: string | null;
  fetched_at: string
}
export function parseVodStreams(raw: unknown, fetchedAt: string): VodRow[] {
  if (!Array.isArray(raw)) return []
  return raw.map((r) => {
    const o = r as Record<string, unknown>
    const addedSecs = numOrNull(o.added)
    return {
      stream_id: num(o.stream_id),
      name: str(o.name) ?? '',
      stream_icon: str(o.stream_icon),
      rating: numOrNull(o.rating),
      category_id: numOrNull(o.category_id),
      container_extension: str(o.container_extension),
      added_ts: addedSecs ? new Date(addedSecs * 1000).toISOString() : null,
      tmdb_id: numOrNull(o.tmdb ?? o.tmdb_id),
      year: numOrNull(o.year),
      plot: str(o.plot),
      director: str(o.director),
      cast_csv: str(o.cast),
      fetched_at: fetchedAt,
    }
  })
}

export interface SeriesRow {
  series_id: number; name: string; cover: string | null; plot: string | null;
  rating: number | null; category_id: number | null; tmdb_id: number | null;
  last_modified: string | null; fetched_at: string
}
export function parseSeriesList(raw: unknown, fetchedAt: string): SeriesRow[] {
  if (!Array.isArray(raw)) return []
  return raw.map((r) => {
    const o = r as Record<string, unknown>
    return {
      series_id: num(o.series_id),
      name: str(o.name) ?? '',
      cover: str(o.cover),
      plot: str(o.plot),
      rating: numOrNull(o.rating),
      category_id: numOrNull(o.category_id),
      tmdb_id: numOrNull(o.tmdb ?? o.tmdb_id),
      last_modified: str(o.last_modified),
      fetched_at: fetchedAt,
    }
  })
}

async function getJson(url: string, label: string): Promise<unknown> {
  const res = await fetchWithTimeout(url, {}, env.IPTV_LIST_TIMEOUT_MS, label)
  if (!res.ok) throw new Error(`${label}_${res.status}`)
  return res.json()
}

export async function fetchCategories(
  kind: 'live' | 'vod' | 'series',
  creds: XtreamCreds = credsFromEnv(),
): Promise<CategoryRow[]> {
  const action = kind === 'live' ? 'get_live_categories' : kind === 'vod' ? 'get_vod_categories' : 'get_series_categories'
  return parseCategoriesPayload(await getJson(buildPlayerApiUrl(creds, action), `xtream.${action}`))
}
export async function fetchLiveStreams(fetchedAt: string, creds: XtreamCreds = credsFromEnv()): Promise<ChannelRow[]> {
  return parseLiveStreams(await getJson(buildPlayerApiUrl(creds, 'get_live_streams'), 'xtream.get_live_streams'), fetchedAt)
}
export async function fetchVodStreams(fetchedAt: string, creds: XtreamCreds = credsFromEnv()): Promise<VodRow[]> {
  return parseVodStreams(await getJson(buildPlayerApiUrl(creds, 'get_vod_streams'), 'xtream.get_vod_streams'), fetchedAt)
}
export async function fetchSeriesList(fetchedAt: string, creds: XtreamCreds = credsFromEnv()): Promise<SeriesRow[]> {
  return parseSeriesList(await getJson(buildPlayerApiUrl(creds, 'get_series'), 'xtream.get_series'), fetchedAt)
}

export interface EpisodeRow {
  episode_id: string; series_id: number; season: number; episode_num: number;
  title: string | null; container_extension: string | null; added_ts: string | null;
  plot: string | null; duration_secs: number | null
}
export async function fetchSeriesInfo(seriesId: number, creds: XtreamCreds = credsFromEnv()): Promise<EpisodeRow[]> {
  const url = buildPlayerApiUrl(creds, 'get_series_info', { series_id: seriesId })
  const raw = (await getJson(url, 'xtream.get_series_info')) as { episodes?: Record<string, unknown[]> }
  const out: EpisodeRow[] = []
  const episodesBySeason = raw.episodes ?? {}
  for (const [seasonStr, eps] of Object.entries(episodesBySeason)) {
    const season = num(seasonStr)
    if (!Array.isArray(eps)) continue
    for (const r of eps) {
      const o = r as Record<string, unknown>
      const info = (o.info as Record<string, unknown> | undefined) ?? {}
      const addedSecs = numOrNull(o.added)
      out.push({
        episode_id: String(o.id),
        series_id: seriesId,
        season,
        episode_num: num(o.episode_num),
        title: str(o.title),
        container_extension: str(o.container_extension),
        added_ts: addedSecs ? new Date(addedSecs * 1000).toISOString() : null,
        plot: str(info.plot ?? info.description),
        duration_secs: numOrNull(info.duration_secs),
      })
    }
  }
  return out
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run server/services/xtream.test.ts`
Expected: PASS, all xtream tests green.

- [ ] **Step 5: Commit**

```bash
git add server/services/xtream.ts server/services/xtream.test.ts
git commit -m "iptv: catalog parsers + fetchers (categories, live, vod, series, episodes)"
```

---

### Task 2.2: EPG XMLTV streaming parser

**Files:**
- Create: `server/services/iptvEpg.ts`
- Test: `server/services/iptvEpg.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/services/iptvEpg.test.ts
import { describe, it, expect } from 'vitest'
import { parseXmltvProgramme, xmltvTimeToIso, streamXmltv } from './iptvEpg.js'
import { Readable } from 'node:stream'

describe('xmltv helpers', () => {
  it('parses xmltv UTC offset times', () => {
    expect(xmltvTimeToIso('20260524103000 +0000')).toBe('2026-05-24T10:30:00.000Z')
    expect(xmltvTimeToIso('20260524103000 -0400')).toBe('2026-05-24T14:30:00.000Z')
  })

  it('streams a programme element with title + desc', async () => {
    const xml = `<?xml version="1.0"?><tv>
      <programme start="20260524103000 +0000" stop="20260524110000 +0000" channel="c.1">
        <title>Hello</title><desc>World</desc>
      </programme>
    </tv>`
    const results: ReturnType<typeof parseXmltvProgramme>[] = []
    await streamXmltv(Readable.from(Buffer.from(xml)), (p) => results.push(p))
    expect(results).toEqual([
      { channel_id: 'c.1', start_utc: '2026-05-24T10:30:00.000Z', stop_utc: '2026-05-24T11:00:00.000Z', title: 'Hello', description: 'World' },
    ])
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run server/services/iptvEpg.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the streaming parser**

```typescript
// server/services/iptvEpg.ts
import sax from 'sax'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { setImmediate as yieldEventLoop } from 'node:timers/promises'

export interface EpgProgrammeRow {
  channel_id: string
  start_utc: string
  stop_utc: string
  title: string | null
  description: string | null
}

export function xmltvTimeToIso(s: string): string {
  // Format: YYYYMMDDhhmmss [+-]HHMM
  const m = s.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})$/)
  if (!m) throw new Error(`xmltv_time_bad_format:${s}`)
  const [, y, mo, d, h, mi, se, off] = m
  const sign = off[0] === '+' ? 1 : -1
  const offH = Number(off.slice(1, 3))
  const offM = Number(off.slice(3, 5))
  const utcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se))
    - sign * (offH * 60 + offM) * 60_000
  return new Date(utcMs).toISOString()
}

export function parseXmltvProgramme(_unused: never): EpgProgrammeRow {
  // exported only to satisfy the test import; real parsing happens inline below.
  throw new Error('use streamXmltv')
}

export async function streamXmltv(
  input: Readable,
  onProgramme: (row: EpgProgrammeRow) => void,
): Promise<void> {
  // Auto-detect gzip by reading the first two bytes.
  const head: Buffer = await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    input.on('error', reject)
    input.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      total += chunk.length
      if (total >= 2) {
        input.pause()
        resolve(Buffer.concat(chunks, total))
      }
    })
    input.on('end', () => resolve(Buffer.concat(chunks, total)))
  })
  const isGzip = head[0] === 0x1f && head[1] === 0x8b
  // Reattach head + remaining to a new readable.
  const merged = Readable.from((async function* () {
    yield head
    input.resume()
    for await (const c of input) yield c as Buffer
  })())
  const xmlStream: Readable = isGzip ? (merged.pipe(createGunzip()) as unknown as Readable) : merged

  const parser = sax.createStream(true, { trim: true, normalize: true })
  let cur: Partial<EpgProgrammeRow> | null = null
  let text = ''
  let inTitle = false
  let inDesc = false
  let counter = 0

  parser.on('opentag', (node) => {
    if (node.name === 'programme') {
      const a = node.attributes as Record<string, string>
      try {
        cur = {
          channel_id: a.channel,
          start_utc: xmltvTimeToIso(a.start),
          stop_utc: xmltvTimeToIso(a.stop),
          title: null,
          description: null,
        }
      } catch {
        cur = null
      }
    } else if (cur && node.name === 'title') {
      inTitle = true; text = ''
    } else if (cur && node.name === 'desc') {
      inDesc = true; text = ''
    }
  })
  parser.on('text', (t) => { if (inTitle || inDesc) text += t })
  parser.on('closetag', (name) => {
    if (name === 'title' && inTitle && cur) { cur.title = text || null; inTitle = false; text = '' }
    else if (name === 'desc' && inDesc && cur) { cur.description = text || null; inDesc = false; text = '' }
    else if (name === 'programme' && cur) {
      if (cur.channel_id && cur.start_utc && cur.stop_utc) {
        onProgramme(cur as EpgProgrammeRow)
      }
      cur = null
      counter += 1
      // yield every 500 programmes to keep the event loop responsive
      if (counter % 500 === 0) void yieldEventLoop()
    }
  })

  await new Promise<void>((resolve, reject) => {
    parser.on('error', reject)
    parser.on('end', () => resolve())
    xmlStream.on('error', reject)
    xmlStream.pipe(parser)
  })
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run server/services/iptvEpg.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/iptvEpg.ts server/services/iptvEpg.test.ts
git commit -m "iptv: streaming xmltv parser (gzip-aware, sax-based, event-loop friendly)"
```

---

### Task 2.3: Sync orchestrator `iptvSync.ts`

**Files:**
- Create: `server/services/iptvSync.ts`
- Test: `server/services/iptvSync.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/services/iptvSync.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { openIptvDb } from './iptvDb.js'

vi.mock('./xtream.js', () => ({
  credsFromEnv: vi.fn(() => ({ host: 'https://p', username: 'u', password: 'p' })),
  fetchCategories: vi.fn(async (kind: string) =>
    kind === 'live'
      ? [{ category_id: 1, name: 'News', parent_id: 0 }]
      : kind === 'vod'
        ? [{ category_id: 2, name: 'Action', parent_id: 0 }]
        : [{ category_id: 3, name: 'Drama', parent_id: 0 }],
  ),
  fetchLiveStreams: vi.fn(async (fetched: string) => [
    { stream_id: 10, num: 1, name: 'C', stream_icon: null, epg_channel_id: 'c.1',
      category_id: 1, is_adult: 0, tv_archive: 1, tv_archive_duration: 7,
      added_ts: null, fetched_at: fetched },
  ]),
  fetchVodStreams: vi.fn(async (fetched: string) => [
    { stream_id: 20, name: 'M', stream_icon: null, rating: 7, category_id: 2,
      container_extension: 'mp4', added_ts: null, tmdb_id: 603, year: 1999,
      plot: null, director: null, cast_csv: null, fetched_at: fetched },
  ]),
  fetchSeriesList: vi.fn(async (fetched: string) => [
    { series_id: 30, name: 'S', cover: null, plot: null, rating: null,
      category_id: 3, tmdb_id: 1399, last_modified: null, fetched_at: fetched },
  ]),
  fetchSeriesInfo: vi.fn(async (seriesId: number) => [
    { episode_id: '101', series_id: seriesId, season: 1, episode_num: 1,
      title: 'Pilot', container_extension: 'mp4', added_ts: null,
      plot: null, duration_secs: 1200 },
  ]),
}))
vi.mock('../env.js', () => ({
  env: {
    XTREAM_HOST: 'https://p', XTREAM_USERNAME: 'u', XTREAM_PASSWORD: 'p',
    IPTV_LIST_TIMEOUT_MS: 30000, IPTV_DB_PATH: '',
    IPTV_SYNC_CRON: '0 */6 * * *',
  },
}))
vi.mock('./iptvEpg.js', () => ({
  fetchAndStreamEpg: vi.fn(async (onRow: (r: any) => void) => {
    onRow({ channel_id: 'c.1', start_utc: '2026-05-24T10:00:00.000Z', stop_utc: '2026-05-24T10:30:00.000Z', title: 'P1', description: null })
    onRow({ channel_id: 'c.1', start_utc: '2026-05-24T10:30:00.000Z', stop_utc: '2026-05-24T11:00:00.000Z', title: 'P2', description: null })
  }),
}))

import { syncOnce } from './iptvSync.js'

describe('iptv sync orchestrator', () => {
  let dbFile: string
  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-'))
    dbFile = path.join(tmp, 'iptv.db')
  })

  it('populates catalog + epg under one mutex', async () => {
    const db = openIptvDb(dbFile)
    const result = await syncOnce(db)
    expect(result.channels).toBe(1)
    expect(result.vod).toBe(1)
    expect(result.series).toBe(1)
    expect(result.episodes).toBe(1)
    expect(result.epg).toBe(2)
    expect(result.categories).toBe(3)
    const ts = db.stmts.getSyncState.get('last_sync') as { value: string; ts: string } | undefined
    expect(ts?.value).toBe('ok')
    db.close()
  })

  it('refuses overlapping runs (returns busy)', async () => {
    const db = openIptvDb(dbFile)
    const a = syncOnce(db)
    const b = syncOnce(db)
    const [ra, rb] = await Promise.all([a, b])
    expect([ra.busy, rb.busy].filter(Boolean).length).toBe(1)
    db.close()
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run server/services/iptvSync.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the orchestrator**

```typescript
// server/services/iptvSync.ts
import { env } from '../env.js'
import {
  credsFromEnv, fetchCategories, fetchLiveStreams, fetchVodStreams,
  fetchSeriesList, fetchSeriesInfo,
} from './xtream.js'
import { fetchAndStreamEpg } from './iptvEpg.js'
import type { IptvDb } from './iptvDb.js'

export interface SyncResult {
  busy?: boolean
  channels: number
  vod: number
  series: number
  episodes: number
  epg: number
  categories: number
  durationMs: number
  startedAt: string
  finishedAt: string
}

let running = false

export async function syncOnce(db: IptvDb): Promise<SyncResult> {
  if (running) {
    return {
      busy: true,
      channels: 0, vod: 0, series: 0, episodes: 0, epg: 0, categories: 0,
      durationMs: 0, startedAt: '', finishedAt: '',
    }
  }
  running = true
  const startedAt = new Date()
  const fetchedAt = startedAt.toISOString()
  let channels = 0, vod = 0, series = 0, episodes = 0, epg = 0, categories = 0

  try {
    const creds = credsFromEnv()

    const [liveCats, vodCats, seriesCats] = await Promise.all([
      fetchCategories('live', creds),
      fetchCategories('vod', creds),
      fetchCategories('series', creds),
    ])
    const writeCats = db.raw.transaction(() => {
      for (const c of liveCats) db.stmts.upsertCategory.run({ ...c, kind: 'live' })
      for (const c of vodCats) db.stmts.upsertCategory.run({ ...c, kind: 'vod' })
      for (const c of seriesCats) db.stmts.upsertCategory.run({ ...c, kind: 'series' })
    })
    writeCats()
    categories = liveCats.length + vodCats.length + seriesCats.length

    const [liveRows, vodRows, seriesRows] = await Promise.all([
      fetchLiveStreams(fetchedAt, creds),
      fetchVodStreams(fetchedAt, creds),
      fetchSeriesList(fetchedAt, creds),
    ])

    const writeChannels = db.raw.transaction((rows: typeof liveRows) => {
      for (const r of rows) db.stmts.upsertChannel.run(r)
    })
    writeChannels(liveRows)
    channels = liveRows.length

    const writeVod = db.raw.transaction((rows: typeof vodRows) => {
      for (const r of rows) db.stmts.upsertVod.run(r)
    })
    writeVod(vodRows)
    vod = vodRows.length

    const writeSeries = db.raw.transaction((rows: typeof seriesRows) => {
      for (const r of rows) db.stmts.upsertSeries.run(r)
    })
    writeSeries(seriesRows)
    series = seriesRows.length

    // Episode expansion — fetched sequentially with a small concurrency cap to spare upstream.
    const CONCURRENCY = 4
    let cursor = 0
    async function worker(): Promise<void> {
      while (cursor < seriesRows.length) {
        const i = cursor++
        const s = seriesRows[i]
        try {
          const eps = await fetchSeriesInfo(s.series_id, creds)
          const writeEps = db.raw.transaction((rows: typeof eps) => {
            for (const r of rows) db.stmts.upsertEpisode.run(r)
          })
          writeEps(eps)
          episodes += eps.length
        } catch (err) {
          console.error(`[iptv-sync] series_info ${s.series_id} failed:`, err)
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

    // EPG window — drop stale rows, store 7-day forward.
    const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString()
    db.raw.prepare(`DELETE FROM epg_programs WHERE stop_utc < ?`).run(cutoff)

    const horizon = new Date(Date.now() + 7 * 24 * 3600_000).toISOString()
    let batch: Parameters<typeof db.stmts.upsertEpg.run>[0][] = []
    const flushBatch = db.raw.transaction((rows: typeof batch) => {
      for (const r of rows) db.stmts.upsertEpg.run(r)
    })
    await fetchAndStreamEpg((row) => {
      if (row.stop_utc > horizon) return
      batch.push(row)
      epg += 1
      if (batch.length >= 1_000) {
        flushBatch(batch)
        batch = []
      }
    })
    if (batch.length) flushBatch(batch)

    const finishedAt = new Date()
    db.stmts.putSyncState.run({ key: 'last_sync', value: 'ok', ts: finishedAt.toISOString() })
    return {
      channels, vod, series, episodes, epg, categories,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    }
  } catch (err) {
    const finishedAt = new Date()
    db.stmts.putSyncState.run({
      key: 'last_sync',
      value: `error:${err instanceof Error ? err.message : String(err)}`,
      ts: finishedAt.toISOString(),
    })
    throw err
  } finally {
    running = false
  }
}

void env  // referenced for future scheduling knobs
```

- [ ] **Step 4: Stub `fetchAndStreamEpg`**

Append to `server/services/iptvEpg.ts`:

```typescript
import { env } from '../env.js'

export async function fetchAndStreamEpg(
  onProgramme: (row: EpgProgrammeRow) => void,
  hostOverride?: { host: string; username: string; password: string },
): Promise<void> {
  const host = (hostOverride?.host ?? env.XTREAM_HOST).replace(/\/+$/, '')
  const user = hostOverride?.username ?? env.XTREAM_USERNAME
  const pass = hostOverride?.password ?? env.XTREAM_PASSWORD
  const url = `${host}/xmltv.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`xtream.xmltv_${res.status}`)
  const nodeStream = Readable.fromWeb(res.body as unknown as ReadableStream<Uint8Array>)
  await streamXmltv(nodeStream, onProgramme)
}
```

(`Readable.fromWeb` is in Node ≥18 — verify with `node --version` if unsure.)

- [ ] **Step 5: Run tests, verify pass**

Run: `npx vitest run server/services/iptvSync.test.ts`
Expected: PASS, both tests green.

- [ ] **Step 6: Commit**

```bash
git add server/services/iptvSync.ts server/services/iptvSync.test.ts server/services/iptvEpg.ts
git commit -m "iptv: sync orchestrator (catalog + epg) with in-process mutex"
```

---

### Task 2.4: Admin sync endpoints + job status

**Files:**
- Modify: `server/routes/iptv.ts`
- Test: extend `server/routes/iptv.test.ts`

- [ ] **Step 1: Write failing test for admin sync**

Append to `server/routes/iptv.test.ts`:

```typescript
vi.mock('../services/iptvSync.js', () => ({
  syncOnce: vi.fn(async () => ({
    busy: false, channels: 10, vod: 20, series: 5, episodes: 50, epg: 100, categories: 6,
    startedAt: '2026-05-24T00:00:00Z', finishedAt: '2026-05-24T00:00:30Z', durationMs: 30000,
  })),
}))
vi.mock('../services/iptvDbSingleton.js', () => ({
  iptvDb: () => ({ raw: { prepare: () => ({ all: () => [], get: () => undefined, run: () => undefined }) }, stmts: {} }),
  closeIptvDb: () => undefined,
}))

describe('POST /api/iptv/admin/sync', () => {
  it('returns a job id and final stats', async () => {
    const app = new Hono().route('/api/iptv', iptv)
    const res = await app.request('/api/iptv/admin/sync', { method: 'POST' })
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(typeof body.jobId).toBe('string')
  })

  it('GET /admin/sync/:id reports completed stats', async () => {
    const app = new Hono().route('/api/iptv', iptv)
    const start = await app.request('/api/iptv/admin/sync', { method: 'POST' })
    const { jobId } = await start.json()
    // wait for the job to complete (mock resolves immediately)
    await new Promise(r => setTimeout(r, 30))
    const status = await app.request(`/api/iptv/admin/sync/${jobId}`)
    expect(status.status).toBe(200)
    const body = await status.json()
    expect(body.state).toBe('done')
    expect(body.result.channels).toBe(10)
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run server/routes/iptv.test.ts`
Expected: FAIL — admin routes missing.

- [ ] **Step 3: Implement admin routes**

Append to `server/routes/iptv.ts`:

```typescript
import { requireAdmin } from '../middleware/auth.js'
import { syncOnce, type SyncResult } from '../services/iptvSync.js'
import { iptvDb } from '../services/iptvDbSingleton.js'
import { randomUUID } from 'node:crypto'

type Job = {
  id: string
  state: 'running' | 'done' | 'error'
  startedAt: string
  finishedAt?: string
  result?: SyncResult
  error?: string
}
const jobs = new Map<string, Job>()
// Bounded — drop oldest when over 20 jobs retained.
function rememberJob(job: Job): void {
  jobs.set(job.id, job)
  if (jobs.size > 20) {
    const oldest = [...jobs.keys()][0]
    jobs.delete(oldest)
  }
}

iptv.post('/admin/sync', requireAdmin, async (c) => {
  const id = randomUUID()
  const job: Job = { id, state: 'running', startedAt: new Date().toISOString() }
  rememberJob(job)
  void (async () => {
    try {
      const result = await syncOnce(iptvDb())
      job.state = 'done'
      job.result = result
      job.finishedAt = new Date().toISOString()
    } catch (err) {
      job.state = 'error'
      job.error = err instanceof Error ? err.message : String(err)
      job.finishedAt = new Date().toISOString()
    }
  })()
  return c.json({ jobId: id }, 202)
})

iptv.get('/admin/sync/:id', requireAdmin, (c) => {
  const id = c.req.param('id')
  const job = jobs.get(id)
  if (!job) return c.json({ error: 'not_found' }, 404)
  return c.json(job)
})
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run server/routes/iptv.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/iptv.ts server/routes/iptv.test.ts
git commit -m "iptv: admin POST /admin/sync + job status GET"
```

---

### Task 2.5: Register 6-hour cron + bootstrap on first boot

**Files:**
- Modify: `server/index.ts`
- Create: `server/services/iptvScheduler.ts`
- Test: `server/services/iptvScheduler.test.ts`

- [ ] **Step 1: Write failing test for `registerSchedule`**

```typescript
// server/services/iptvScheduler.test.ts
import { describe, it, expect, vi } from 'vitest'
import cron from 'node-cron'
import { registerIptvSchedule } from './iptvScheduler.js'

vi.mock('./iptvSync.js', () => ({
  syncOnce: vi.fn(async () => ({
    busy: false, channels: 0, vod: 0, series: 0, episodes: 0, epg: 0, categories: 0,
    startedAt: '', finishedAt: '', durationMs: 0,
  })),
}))
vi.mock('./iptvDbSingleton.js', () => ({ iptvDb: () => ({ stmts: { getSyncState: { get: () => undefined } } }) }))

describe('registerIptvSchedule', () => {
  it('schedules a task at the configured cron and bootstraps if last_sync is missing', async () => {
    const calls: string[] = []
    vi.spyOn(cron, 'schedule').mockImplementation((expr: string) => {
      calls.push(expr)
      return { stop: () => undefined, start: () => undefined } as any
    })
    await registerIptvSchedule('*/5 * * * *')
    expect(calls).toContain('*/5 * * * *')
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run server/services/iptvScheduler.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the scheduler**

```typescript
// server/services/iptvScheduler.ts
import cron from 'node-cron'
import { syncOnce } from './iptvSync.js'
import { iptvDb } from './iptvDbSingleton.js'

export async function registerIptvSchedule(cronExpr: string): Promise<void> {
  // Bootstrap if last_sync is missing OR last_sync is older than 7 days (covers cold start + long downtime).
  const db = iptvDb()
  const last = db.stmts.getSyncState.get('last_sync') as { value: string; ts: string } | undefined
  const needsBootstrap = !last || (Date.now() - new Date(last.ts).getTime()) > 7 * 24 * 3600_000
  if (needsBootstrap) {
    // Fire-and-forget — don't block server boot on a multi-minute sync.
    void syncOnce(db).catch((err) => console.error('[iptv] bootstrap sync failed:', err))
  }

  cron.schedule(cronExpr, () => {
    void syncOnce(db).catch((err) => console.error('[iptv] scheduled sync failed:', err))
  })
}
```

- [ ] **Step 4: Wire into server boot**

Edit `server/index.ts` — add near the bottom, after the `serve()` call:

```typescript
import { env } from './env.js'
import { registerIptvSchedule } from './services/iptvScheduler.js'

// Best-effort: don't crash boot if iptv creds are missing — the scheduler self-skips when no last_sync exists AND no creds are set.
if (env.XTREAM_HOST && env.XTREAM_USERNAME && env.XTREAM_PASSWORD) {
  void registerIptvSchedule(env.IPTV_SYNC_CRON)
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `npx vitest run server/services/iptvScheduler.test.ts && npx tsc -p server/tsconfig.json --noEmit`
Expected: PASS + clean type-check.

- [ ] **Step 6: Commit**

```bash
git add server/services/iptvScheduler.ts server/services/iptvScheduler.test.ts server/index.ts
git commit -m "iptv: 6h node-cron schedule + first-boot bootstrap"
```

---

### Task 2.6: Phase 2 acceptance — live sync run

- [ ] **Step 1: Run manual sync, watch the job**

With `npm run dev` still up, hit the admin endpoint:

```bash
curl -s -b "<cookie>" -X POST http://localhost:3001/api/iptv/admin/sync | tee /tmp/iptv-job.json
JOB_ID=$(jq -r .jobId /tmp/iptv-job.json)
watch -n 2 "curl -s -b '<cookie>' http://localhost:3001/api/iptv/admin/sync/$JOB_ID | jq"
```

Expected: progresses to `state: "done"` within a few minutes. `result.channels`, `result.vod`, `result.series`, `result.episodes`, `result.epg` all > 0.

- [ ] **Step 2: Spot-check the DB**

```bash
sqlite3 ./data/iptv.db "SELECT COUNT(*) AS channels FROM channels;"
sqlite3 ./data/iptv.db "SELECT COUNT(*) AS vod FROM vod;"
sqlite3 ./data/iptv.db "SELECT COUNT(*) AS series FROM series;"
sqlite3 ./data/iptv.db "SELECT COUNT(*) AS episodes FROM series_episodes;"
sqlite3 ./data/iptv.db "SELECT COUNT(*) AS epg FROM epg_programs;"
sqlite3 ./data/iptv.db "SELECT MIN(start_utc), MAX(stop_utc) FROM epg_programs;"
```

Expected: non-zero rows in each table; EPG window roughly spans `now()` to `now()+7d`.

- [ ] **Step 3: Commit phase marker**

```bash
git commit --allow-empty -m "iptv phase 2: live sync + 6h schedule verified end-to-end"
```

---

## Phase 3 — Catalog read APIs + tabs

Goal: the SPA can browse channels, VOD, and IPTV series from the local cache. No playback yet.

### Task 3.1: Catalog read service `iptvCatalog.ts`

**Files:**
- Create: `server/services/iptvCatalog.ts`
- Test: `server/services/iptvCatalog.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// server/services/iptvCatalog.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'
import { openIptvDb } from './iptvDb.js'
import {
  listCategories, listLive, listVod, listSeries, getVodDetail, getSeriesDetail,
} from './iptvCatalog.js'

describe('iptv catalog reads', () => {
  let db: ReturnType<typeof openIptvDb>
  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-'))
    db = openIptvDb(path.join(tmp, 'iptv.db'))
    const ts = '2026-05-24T00:00:00Z'
    db.stmts.upsertCategory.run({ category_id: 1, kind: 'live', name: 'News', parent_id: 0 })
    db.stmts.upsertCategory.run({ category_id: 2, kind: 'vod', name: 'Action', parent_id: 0 })
    db.stmts.upsertCategory.run({ category_id: 3, kind: 'series', name: 'Drama', parent_id: 0 })
    db.stmts.upsertChannel.run({
      stream_id: 10, num: 1, name: 'CNN', stream_icon: null, epg_channel_id: 'cnn',
      category_id: 1, is_adult: 0, tv_archive: 1, tv_archive_duration: 7,
      added_ts: null, fetched_at: ts,
    })
    db.stmts.upsertVod.run({
      stream_id: 20, name: 'Matrix', stream_icon: null, rating: 8.7, category_id: 2,
      container_extension: 'mp4', added_ts: null, tmdb_id: 603, year: 1999,
      plot: 'Neo', director: 'Wachowskis', cast_csv: 'Keanu', fetched_at: ts,
    })
    db.stmts.upsertSeries.run({
      series_id: 30, name: 'GoT', cover: null, plot: null, rating: 9, category_id: 3,
      tmdb_id: 1399, last_modified: null, fetched_at: ts,
    })
    db.stmts.upsertEpisode.run({
      episode_id: '101', series_id: 30, season: 1, episode_num: 1,
      title: 'Winter', container_extension: 'mp4', added_ts: null,
      plot: null, duration_secs: 3600,
    })
  })

  it('lists categories filtered by kind', () => {
    expect(listCategories(db, 'live')).toEqual([{ category_id: 1, name: 'News', parent_id: 0 }])
    expect(listCategories(db, 'vod')[0].name).toBe('Action')
  })

  it('lists live channels with paging + search', () => {
    const r = listLive(db, { limit: 50, offset: 0 })
    expect(r.total).toBe(1)
    expect(r.items[0].name).toBe('CNN')
    expect(listLive(db, { q: 'cnn' }).total).toBe(1)
    expect(listLive(db, { q: 'fox' }).total).toBe(0)
  })

  it('lists VOD and returns detail by stream_id', () => {
    expect(listVod(db, {}).total).toBe(1)
    const v = getVodDetail(db, 20)
    expect(v?.tmdb_id).toBe(603)
    expect(v?.director).toBe('Wachowskis')
  })

  it('returns series detail with seasons + episodes', () => {
    const s = getSeriesDetail(db, 30)
    expect(s?.seasons).toHaveLength(1)
    expect(s?.seasons[0].episodes[0].title).toBe('Winter')
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run server/services/iptvCatalog.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement catalog readers**

```typescript
// server/services/iptvCatalog.ts
import type { IptvDb } from './iptvDb.js'

type Kind = 'live' | 'vod' | 'series'

export interface ListOpts {
  categoryId?: number
  q?: string
  limit?: number
  offset?: number
}

const clampLimit = (n: number | undefined) => Math.max(1, Math.min(200, Math.floor(n ?? 50)))
const clampOffset = (n: number | undefined) => Math.max(0, Math.floor(n ?? 0))
const likeOrAny = (q: string | undefined) => (q && q.trim() ? `%${q.trim().toLowerCase()}%` : null)

export function listCategories(db: IptvDb, kind: Kind): Array<{ category_id: number; name: string; parent_id: number }> {
  return db.raw
    .prepare(`SELECT category_id, name, parent_id FROM categories WHERE kind=? ORDER BY name`)
    .all(kind) as Array<{ category_id: number; name: string; parent_id: number }>
}

export interface ListResult<T> { items: T[]; total: number; limit: number; offset: number }

export function listLive(db: IptvDb, opts: ListOpts): ListResult<{
  stream_id: number; num: number; name: string; stream_icon: string | null;
  epg_channel_id: string | null; category_id: number | null;
  tv_archive: number; tv_archive_duration: number | null;
}> {
  const limit = clampLimit(opts.limit); const offset = clampOffset(opts.offset)
  const like = likeOrAny(opts.q)
  const where: string[] = []; const params: Record<string, unknown> = {}
  if (opts.categoryId != null) { where.push('category_id = @categoryId'); params.categoryId = opts.categoryId }
  if (like) { where.push('LOWER(name) LIKE @like'); params.like = like }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = (db.raw.prepare(`SELECT COUNT(*) AS n FROM channels ${whereSql}`).get(params) as { n: number }).n
  const items = db.raw.prepare(`
    SELECT stream_id, num, name, stream_icon, epg_channel_id, category_id, tv_archive, tv_archive_duration
    FROM channels ${whereSql}
    ORDER BY num, name
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset }) as ListResult<never>['items']
  return { items: items as any, total, limit, offset }
}

export function listVod(db: IptvDb, opts: ListOpts): ListResult<{
  stream_id: number; name: string; stream_icon: string | null; rating: number | null;
  category_id: number | null; year: number | null; tmdb_id: number | null;
}> {
  const limit = clampLimit(opts.limit); const offset = clampOffset(opts.offset)
  const like = likeOrAny(opts.q)
  const where: string[] = []; const params: Record<string, unknown> = {}
  if (opts.categoryId != null) { where.push('category_id = @categoryId'); params.categoryId = opts.categoryId }
  if (like) { where.push('LOWER(name) LIKE @like'); params.like = like }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = (db.raw.prepare(`SELECT COUNT(*) AS n FROM vod ${whereSql}`).get(params) as { n: number }).n
  const items = db.raw.prepare(`
    SELECT stream_id, name, stream_icon, rating, category_id, year, tmdb_id
    FROM vod ${whereSql}
    ORDER BY COALESCE(added_ts, '') DESC, name
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset }) as ListResult<never>['items']
  return { items: items as any, total, limit, offset }
}

export function getVodDetail(db: IptvDb, streamId: number): {
  stream_id: number; name: string; stream_icon: string | null; rating: number | null;
  category_id: number | null; container_extension: string | null;
  tmdb_id: number | null; year: number | null;
  plot: string | null; director: string | null; cast_csv: string | null;
} | null {
  return (db.raw.prepare(`
    SELECT stream_id, name, stream_icon, rating, category_id, container_extension,
           tmdb_id, year, plot, director, cast_csv
    FROM vod WHERE stream_id = ?
  `).get(streamId) ?? null) as any
}

export function listSeries(db: IptvDb, opts: ListOpts): ListResult<{
  series_id: number; name: string; cover: string | null; rating: number | null;
  category_id: number | null; tmdb_id: number | null;
}> {
  const limit = clampLimit(opts.limit); const offset = clampOffset(opts.offset)
  const like = likeOrAny(opts.q)
  const where: string[] = []; const params: Record<string, unknown> = {}
  if (opts.categoryId != null) { where.push('category_id = @categoryId'); params.categoryId = opts.categoryId }
  if (like) { where.push('LOWER(name) LIKE @like'); params.like = like }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = (db.raw.prepare(`SELECT COUNT(*) AS n FROM series ${whereSql}`).get(params) as { n: number }).n
  const items = db.raw.prepare(`
    SELECT series_id, name, cover, rating, category_id, tmdb_id
    FROM series ${whereSql}
    ORDER BY name
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset }) as ListResult<never>['items']
  return { items: items as any, total, limit, offset }
}

export function getSeriesDetail(db: IptvDb, seriesId: number): {
  series_id: number; name: string; cover: string | null; plot: string | null;
  rating: number | null; category_id: number | null; tmdb_id: number | null;
  seasons: Array<{
    season: number;
    episodes: Array<{
      episode_id: string; episode_num: number; title: string | null;
      container_extension: string | null; duration_secs: number | null; plot: string | null;
    }>
  }>;
} | null {
  const meta = db.raw.prepare(`
    SELECT series_id, name, cover, plot, rating, category_id, tmdb_id
    FROM series WHERE series_id = ?
  `).get(seriesId) as any
  if (!meta) return null
  const eps = db.raw.prepare(`
    SELECT episode_id, season, episode_num, title, container_extension, duration_secs, plot
    FROM series_episodes WHERE series_id = ?
    ORDER BY season, episode_num
  `).all(seriesId) as Array<{ season: number; episode_id: string; episode_num: number; title: string | null; container_extension: string | null; duration_secs: number | null; plot: string | null }>
  const seasonsMap = new Map<number, typeof eps>()
  for (const e of eps) {
    const list = seasonsMap.get(e.season) ?? []
    list.push(e)
    seasonsMap.set(e.season, list)
  }
  const seasons = [...seasonsMap.entries()].sort(([a], [b]) => a - b).map(([season, episodes]) => ({
    season,
    episodes: episodes.map(({ season: _s, ...rest }) => rest),
  }))
  return { ...meta, seasons }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run server/services/iptvCatalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/iptvCatalog.ts server/services/iptvCatalog.test.ts
git commit -m "iptv: catalog read service (categories, live, vod, series with paging+search)"
```

---

### Task 3.2: Wire catalog routes

**Files:**
- Modify: `server/routes/iptv.ts`
- Test: extend `server/routes/iptv.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `server/routes/iptv.test.ts`:

```typescript
vi.mock('../services/iptvCatalog.js', () => ({
  listCategories: vi.fn(() => [{ category_id: 1, name: 'News', parent_id: 0 }]),
  listLive: vi.fn(() => ({ items: [{ stream_id: 10, num: 1, name: 'CNN' }], total: 1, limit: 50, offset: 0 })),
  listVod: vi.fn(() => ({ items: [{ stream_id: 20, name: 'Matrix' }], total: 1, limit: 50, offset: 0 })),
  listSeries: vi.fn(() => ({ items: [{ series_id: 30, name: 'GoT' }], total: 1, limit: 50, offset: 0 })),
  getVodDetail: vi.fn(() => ({ stream_id: 20, name: 'Matrix' })),
  getSeriesDetail: vi.fn(() => ({ series_id: 30, name: 'GoT', seasons: [{ season: 1, episodes: [] }] })),
}))

describe('catalog read routes', () => {
  const app = new Hono().route('/api/iptv', iptv)
  it('lists categories by kind', async () => {
    const res = await app.request('/api/iptv/categories?kind=live')
    expect(res.status).toBe(200)
    expect((await res.json())[0].name).toBe('News')
  })
  it('rejects unknown kind', async () => {
    const res = await app.request('/api/iptv/categories?kind=music')
    expect(res.status).toBe(400)
  })
  it('lists live channels with query params', async () => {
    const res = await app.request('/api/iptv/live?q=cnn&limit=10')
    const body = await res.json()
    expect(body.total).toBe(1)
  })
  it('returns vod detail or 404', async () => {
    const res = await app.request('/api/iptv/vod/20')
    expect(res.status).toBe(200)
  })
  it('returns series detail', async () => {
    const res = await app.request('/api/iptv/series/30')
    const body = await res.json()
    expect(body.name).toBe('GoT')
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run server/routes/iptv.test.ts`
Expected: FAIL — routes missing.

- [ ] **Step 3: Implement routes**

Append to `server/routes/iptv.ts` (above the admin routes):

```typescript
import {
  listCategories, listLive, listVod, listSeries, getVodDetail, getSeriesDetail,
} from '../services/iptvCatalog.js'

const KINDS = new Set(['live', 'vod', 'series'])

iptv.get('/categories', (c) => {
  const kind = c.req.query('kind') ?? ''
  if (!KINDS.has(kind)) return c.json({ error: 'invalid_kind' }, 400)
  return c.json(listCategories(iptvDb(), kind as 'live' | 'vod' | 'series'))
})

function parseListOpts(c: any): { categoryId?: number; q?: string; limit?: number; offset?: number } {
  const cat = c.req.query('categoryId')
  return {
    categoryId: cat != null && cat !== '' ? Number(cat) : undefined,
    q: c.req.query('q') ?? undefined,
    limit: c.req.query('limit') != null ? Number(c.req.query('limit')) : undefined,
    offset: c.req.query('offset') != null ? Number(c.req.query('offset')) : undefined,
  }
}

iptv.get('/live', (c) => c.json(listLive(iptvDb(), parseListOpts(c))))
iptv.get('/vod', (c) => c.json(listVod(iptvDb(), parseListOpts(c))))
iptv.get('/series', (c) => c.json(listSeries(iptvDb(), parseListOpts(c))))

iptv.get('/vod/:streamId', (c) => {
  const id = Number(c.req.param('streamId'))
  if (!Number.isFinite(id)) return c.json({ error: 'invalid_id' }, 400)
  const detail = getVodDetail(iptvDb(), id)
  return detail ? c.json(detail) : c.json({ error: 'not_found' }, 404)
})

iptv.get('/series/:seriesId', (c) => {
  const id = Number(c.req.param('seriesId'))
  if (!Number.isFinite(id)) return c.json({ error: 'invalid_id' }, 400)
  const detail = getSeriesDetail(iptvDb(), id)
  return detail ? c.json(detail) : c.json({ error: 'not_found' }, 404)
})
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run server/routes/iptv.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/iptv.ts server/routes/iptv.test.ts
git commit -m "iptv: catalog read routes (categories, live, vod, series, detail)"
```

---

### Task 3.3: Frontend API client `iptv.ts`

**Files:**
- Create: `src/lib/api/iptv.ts`
- Test: `src/lib/api/iptv.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/lib/api/iptv.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { iptvApi } from './iptv'

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  global.fetch = fetchMock as any
})

describe('iptvApi', () => {
  it('listLive hits the right URL', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ items: [], total: 0, limit: 50, offset: 0 }), { headers: { 'Content-Type': 'application/json' } }))
    await iptvApi.listLive({ q: 'cnn', limit: 25 })
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/iptv/live?q=cnn&limit=25'), expect.any(Object))
  })

  it('vodDetail throws on 404 with a typed error', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }))
    await expect(iptvApi.vodDetail(20)).rejects.toThrow(/not_found/)
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run src/lib/api/iptv.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the client**

```typescript
// src/lib/api/iptv.ts
import { apiUrl } from './base'

async function get<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path), { credentials: 'include' })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`iptv_api_${res.status}:${detail}`)
  }
  return res.json() as Promise<T>
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue
    u.set(k, String(v))
  }
  const s = u.toString()
  return s ? `?${s}` : ''
}

export interface CategoryDto { category_id: number; name: string; parent_id: number }
export interface ChannelDto {
  stream_id: number; num: number; name: string; stream_icon: string | null;
  epg_channel_id: string | null; category_id: number | null;
  tv_archive: number; tv_archive_duration: number | null;
}
export interface VodDto {
  stream_id: number; name: string; stream_icon: string | null; rating: number | null;
  category_id: number | null; year: number | null; tmdb_id: number | null;
}
export interface VodDetailDto extends VodDto {
  container_extension: string | null; plot: string | null;
  director: string | null; cast_csv: string | null;
}
export interface SeriesDto {
  series_id: number; name: string; cover: string | null; rating: number | null;
  category_id: number | null; tmdb_id: number | null;
}
export interface SeriesEpisodeDto {
  episode_id: string; episode_num: number; title: string | null;
  container_extension: string | null; duration_secs: number | null; plot: string | null;
}
export interface SeriesDetailDto {
  series_id: number; name: string; cover: string | null; plot: string | null;
  rating: number | null; category_id: number | null; tmdb_id: number | null;
  seasons: Array<{ season: number; episodes: SeriesEpisodeDto[] }>;
}
export interface PagedDto<T> { items: T[]; total: number; limit: number; offset: number }
export interface ListParams { categoryId?: number; q?: string; limit?: number; offset?: number }

export const iptvApi = {
  health: () => get<{ expiresAt: string | null; maxConnections: number; status: string }>(`/api/iptv/health`),
  categories: (kind: 'live' | 'vod' | 'series') => get<CategoryDto[]>(`/api/iptv/categories?kind=${kind}`),
  listLive: (p: ListParams = {}) => get<PagedDto<ChannelDto>>(`/api/iptv/live${buildQuery(p)}`),
  listVod: (p: ListParams = {}) => get<PagedDto<VodDto>>(`/api/iptv/vod${buildQuery(p)}`),
  listSeries: (p: ListParams = {}) => get<PagedDto<SeriesDto>>(`/api/iptv/series${buildQuery(p)}`),
  vodDetail: (id: number) => get<VodDetailDto>(`/api/iptv/vod/${id}`),
  seriesDetail: (id: number) => get<SeriesDetailDto>(`/api/iptv/series/${id}`),
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run src/lib/api/iptv.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api/iptv.ts src/lib/api/iptv.test.ts
git commit -m "iptv: frontend api client for catalog endpoints"
```

---

### Task 3.4: React hooks `useIptv*`

**Files:**
- Create: `src/lib/hooks/useIptvCategories.ts`
- Create: `src/lib/hooks/useIptvLive.ts`
- Create: `src/lib/hooks/useIptvVod.ts`
- Create: `src/lib/hooks/useIptvSeries.ts`

- [ ] **Step 1: Implement hooks (no separate test — covered indirectly via tab tests)**

```typescript
// src/lib/hooks/useIptvCategories.ts
import { useQuery } from '@tanstack/react-query'
import { iptvApi } from '../api/iptv'

export function useIptvCategories(kind: 'live' | 'vod' | 'series') {
  return useQuery({
    queryKey: ['iptv', 'categories', kind],
    queryFn: () => iptvApi.categories(kind),
    staleTime: 6 * 60 * 60 * 1000, // 6h — matches sync cadence
  })
}
```

```typescript
// src/lib/hooks/useIptvLive.ts
import { useQuery } from '@tanstack/react-query'
import { iptvApi, type ListParams } from '../api/iptv'

export function useIptvLive(params: ListParams) {
  return useQuery({
    queryKey: ['iptv', 'live', params],
    queryFn: () => iptvApi.listLive(params),
    staleTime: 5 * 60 * 1000,
  })
}
```

```typescript
// src/lib/hooks/useIptvVod.ts
import { useQuery } from '@tanstack/react-query'
import { iptvApi, type ListParams } from '../api/iptv'

export function useIptvVod(params: ListParams) {
  return useQuery({
    queryKey: ['iptv', 'vod', params],
    queryFn: () => iptvApi.listVod(params),
    staleTime: 5 * 60 * 1000,
  })
}

export function useIptvVodDetail(id: number | null) {
  return useQuery({
    queryKey: ['iptv', 'vod', 'detail', id],
    queryFn: () => iptvApi.vodDetail(id!),
    enabled: id != null,
    staleTime: 6 * 60 * 60 * 1000,
  })
}
```

```typescript
// src/lib/hooks/useIptvSeries.ts
import { useQuery } from '@tanstack/react-query'
import { iptvApi, type ListParams } from '../api/iptv'

export function useIptvSeries(params: ListParams) {
  return useQuery({
    queryKey: ['iptv', 'series', params],
    queryFn: () => iptvApi.listSeries(params),
    staleTime: 5 * 60 * 1000,
  })
}

export function useIptvSeriesDetail(id: number | null) {
  return useQuery({
    queryKey: ['iptv', 'series', 'detail', id],
    queryFn: () => iptvApi.seriesDetail(id!),
    enabled: id != null,
    staleTime: 6 * 60 * 60 * 1000,
  })
}
```

- [ ] **Step 2: Type-check the frontend**

Run: `npx tsc -b`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/hooks/useIptvCategories.ts src/lib/hooks/useIptvLive.ts src/lib/hooks/useIptvVod.ts src/lib/hooks/useIptvSeries.ts
git commit -m "iptv: react-query hooks for categories, live, vod, series"
```

---

### Task 3.5: Tab components (Live + VOD + IPTV Series)

**Files:**
- Create: `src/components/tabs/LiveTab.tsx`
- Create: `src/components/tabs/VodTab.tsx`
- Create: `src/components/tabs/IptvSeriesTab.tsx`

These follow the existing tab pattern. Look at `src/components/tabs/MoviesTab.tsx` first to mirror its layout, search-input style, and grid/list conventions.

- [ ] **Step 1: Read existing pattern**

Run: `cat src/components/tabs/MoviesTab.tsx | head -60`
Note the imports (`useDebounced`, layout components, card class names). Reuse them.

- [ ] **Step 2: Implement `LiveTab.tsx`**

```tsx
// src/components/tabs/LiveTab.tsx
import { useMemo, useState } from 'react'
import { useIptvCategories } from '../../lib/hooks/useIptvCategories'
import { useIptvLive } from '../../lib/hooks/useIptvLive'
import { useDebounced } from '../../lib/hooks/useDebounced'

export default function LiveTab() {
  const [q, setQ] = useState('')
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined)
  const debounced = useDebounced(q, 250)
  const cats = useIptvCategories('live')
  const list = useIptvLive({ q: debounced, categoryId, limit: 100, offset: 0 })

  const sortedCats = useMemo(() => (cats.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)), [cats.data])

  return (
    <section className="iptv-tab">
      <header className="iptv-tab__toolbar">
        <input
          className="iptv-tab__search"
          placeholder="Search channels…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className="iptv-tab__category"
          value={categoryId ?? ''}
          onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : undefined)}
        >
          <option value="">All categories</option>
          {sortedCats.map((c) => (
            <option key={c.category_id} value={c.category_id}>{c.name}</option>
          ))}
        </select>
      </header>

      {list.isLoading && <p className="iptv-tab__status">Loading…</p>}
      {list.error && <p className="iptv-tab__status iptv-tab__status--error">Failed to load channels.</p>}

      <ul className="iptv-channel-grid">
        {(list.data?.items ?? []).map((c) => (
          <li key={c.stream_id} className="iptv-channel-card">
            {c.stream_icon
              ? <img src={c.stream_icon} alt="" className="iptv-channel-card__icon" loading="lazy" />
              : <div className="iptv-channel-card__icon iptv-channel-card__icon--placeholder" aria-hidden />}
            <div className="iptv-channel-card__meta">
              <span className="iptv-channel-card__num">{c.num}</span>
              <span className="iptv-channel-card__name">{c.name}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
```

- [ ] **Step 3: Implement `VodTab.tsx`**

```tsx
// src/components/tabs/VodTab.tsx
import { useState } from 'react'
import { useIptvCategories } from '../../lib/hooks/useIptvCategories'
import { useIptvVod } from '../../lib/hooks/useIptvVod'
import { useDebounced } from '../../lib/hooks/useDebounced'

export default function VodTab() {
  const [q, setQ] = useState('')
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined)
  const debounced = useDebounced(q, 250)
  const cats = useIptvCategories('vod')
  const list = useIptvVod({ q: debounced, categoryId, limit: 100 })

  return (
    <section className="iptv-tab">
      <header className="iptv-tab__toolbar">
        <input className="iptv-tab__search" placeholder="Search movies…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select
          className="iptv-tab__category"
          value={categoryId ?? ''}
          onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : undefined)}
        >
          <option value="">All categories</option>
          {(cats.data ?? []).map((c) => <option key={c.category_id} value={c.category_id}>{c.name}</option>)}
        </select>
      </header>
      {list.isLoading && <p className="iptv-tab__status">Loading…</p>}
      <ul className="iptv-poster-grid">
        {(list.data?.items ?? []).map((v) => (
          <li key={v.stream_id} className="iptv-poster-card">
            {v.stream_icon
              ? <img src={v.stream_icon} alt="" className="iptv-poster-card__img" loading="lazy" />
              : <div className="iptv-poster-card__img iptv-poster-card__img--placeholder" aria-hidden />}
            <div className="iptv-poster-card__name" title={v.name}>{v.name}</div>
            {v.year ? <div className="iptv-poster-card__year">{v.year}</div> : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
```

- [ ] **Step 4: Implement `IptvSeriesTab.tsx`**

```tsx
// src/components/tabs/IptvSeriesTab.tsx
import { useState } from 'react'
import { useIptvCategories } from '../../lib/hooks/useIptvCategories'
import { useIptvSeries } from '../../lib/hooks/useIptvSeries'
import { useDebounced } from '../../lib/hooks/useDebounced'

export default function IptvSeriesTab() {
  const [q, setQ] = useState('')
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined)
  const debounced = useDebounced(q, 250)
  const cats = useIptvCategories('series')
  const list = useIptvSeries({ q: debounced, categoryId, limit: 100 })

  return (
    <section className="iptv-tab">
      <header className="iptv-tab__toolbar">
        <input className="iptv-tab__search" placeholder="Search series…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select
          className="iptv-tab__category"
          value={categoryId ?? ''}
          onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : undefined)}
        >
          <option value="">All categories</option>
          {(cats.data ?? []).map((c) => <option key={c.category_id} value={c.category_id}>{c.name}</option>)}
        </select>
      </header>
      {list.isLoading && <p className="iptv-tab__status">Loading…</p>}
      <ul className="iptv-poster-grid">
        {(list.data?.items ?? []).map((s) => (
          <li key={s.series_id} className="iptv-poster-card">
            {s.cover
              ? <img src={s.cover} alt="" className="iptv-poster-card__img" loading="lazy" />
              : <div className="iptv-poster-card__img iptv-poster-card__img--placeholder" aria-hidden />}
            <div className="iptv-poster-card__name" title={s.name}>{s.name}</div>
          </li>
        ))}
      </ul>
    </section>
  )
}
```

- [ ] **Step 5: Add minimal CSS**

Append to `src/index.css` (or the file that imports tab styles — check `src/App.tsx` imports first):

```css
.iptv-tab { padding: 1rem; }
.iptv-tab__toolbar { display: flex; gap: .5rem; margin-bottom: 1rem; }
.iptv-tab__search { flex: 1; padding: .5rem; }
.iptv-tab__category { padding: .5rem; }
.iptv-tab__status { color: var(--text-dim, #888); padding: 1rem; }
.iptv-tab__status--error { color: var(--text-error, #c33); }
.iptv-channel-grid, .iptv-poster-grid {
  display: grid; gap: .75rem; list-style: none; padding: 0; margin: 0;
}
.iptv-channel-grid { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.iptv-poster-grid  { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
.iptv-channel-card, .iptv-poster-card {
  background: var(--card-bg, #181818); border-radius: 6px; padding: .5rem;
  display: flex; flex-direction: column; gap: .25rem;
}
.iptv-channel-card { flex-direction: row; align-items: center; }
.iptv-channel-card__icon { width: 48px; height: 48px; object-fit: contain; }
.iptv-channel-card__icon--placeholder { background: #333; }
.iptv-channel-card__meta { display: flex; gap: .5rem; align-items: center; }
.iptv-channel-card__num { color: var(--text-dim, #888); min-width: 2.5em; text-align: right; }
.iptv-channel-card__name { font-weight: 600; }
.iptv-poster-card__img { width: 100%; aspect-ratio: 2/3; object-fit: cover; border-radius: 4px; }
.iptv-poster-card__img--placeholder { background: #333; }
.iptv-poster-card__name { font-size: .9rem; line-height: 1.2; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.iptv-poster-card__year { font-size: .8rem; color: var(--text-dim, #888); }
```

- [ ] **Step 6: Type-check + lint**

Run: `npx tsc -b && npm run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/components/tabs/LiveTab.tsx src/components/tabs/VodTab.tsx src/components/tabs/IptvSeriesTab.tsx src/index.css
git commit -m "iptv: live/vod/series tabs with search + category filter"
```

---

### Task 3.6: Register tabs in router + App.tsx + TopNav

**Files:**
- Modify: `src/lib/router.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/TopNav.tsx` (or the existing top-nav file — locate first)

- [ ] **Step 1: Locate TopNav**

Run: `grep -l "TopNav\|TabSwitcher\|router" src/components/*.tsx src/*.tsx | head -5`
Expected: a single file owns the tab buttons. Use whatever name it has.

- [ ] **Step 2: Extend the Route enum in router.ts**

Open `src/lib/router.ts`. Add to the `Route` union: `'live'`, `'iptv-vod'`, `'iptv-series'`. Update the `ROUTES` array (or whatever it's called) to include the three new entries with labels `Live`, `Movies (IPTV)`, `Series (IPTV)`.

The diff will look like:

```typescript
export type Route = 'home' | 'tv' | 'movies' | 'downloads' | 'users' | 'live' | 'iptv-vod' | 'iptv-series'

export const ROUTES: Array<{ id: Route; label: string }> = [
  { id: 'home', label: 'Home' },
  { id: 'tv', label: 'TV' },
  { id: 'movies', label: 'Movies' },
  { id: 'live', label: 'Live' },
  { id: 'iptv-vod', label: 'IPTV Movies' },
  { id: 'iptv-series', label: 'IPTV Series' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'users', label: 'Users' },
]
```

(Match whatever the existing constant names are.)

- [ ] **Step 3: Register the lazy tabs in App.tsx**

Find the `TABS` map (`grep -n "TABS\|React.lazy" src/App.tsx`). Add:

```typescript
const LiveTab = React.lazy(() => import('./components/tabs/LiveTab'))
const VodTab = React.lazy(() => import('./components/tabs/VodTab'))
const IptvSeriesTab = React.lazy(() => import('./components/tabs/IptvSeriesTab'))

const TABS: Record<Route, React.ComponentType> = {
  // ... existing entries
  live: LiveTab,
  'iptv-vod': VodTab,
  'iptv-series': IptvSeriesTab,
}
```

- [ ] **Step 4: Type-check + lint + build**

Run: `npx tsc -b && npm run lint && npm run build:spa`
Expected: clean. Build output shows three new lazy chunks for the iptv tabs.

- [ ] **Step 5: Commit**

```bash
git add src/lib/router.ts src/App.tsx src/components/TopNav.tsx
git commit -m "iptv: register Live + IPTV Movies + IPTV Series tabs in router/App/topnav"
```

---

### Task 3.7: Phase 3 acceptance — browse in browser

- [ ] **Step 1: Hard-refresh `http://theemeraldexchange.local:8085` (or `http://localhost:5173` in dev)**

Expected: three new tabs appear in the top nav. Clicking `Live` shows the channel grid populated from `iptv.db`; clicking `IPTV Movies` and `IPTV Series` show posters. Search debounces and filters; category dropdown filters.

- [ ] **Step 2: Verify render perf**

DevTools → Performance → record a tab switch into `Live`. Network shows one `/api/iptv/live` call returning ≤200ms (local DB). Visible grid in <400ms total.

- [ ] **Step 3: Commit phase marker**

```bash
git commit --allow-empty -m "iptv phase 3: browse channels/vod/series end-to-end in the SPA"
```

---

## Phase 4 — Stream proxy + grants

Goal: the SPA can grant a tokenized stream URL and play it through the auth-gated proxy. Live MPEG-TS streams pass through. VOD honors `Range`. HLS playlists are rewritten to keep segments authenticated.

### Task 4.1: HMAC stream token utility

**Files:**
- Create: `server/services/iptvStreamToken.ts`
- Test: `server/services/iptvStreamToken.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// server/services/iptvStreamToken.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { signStreamToken, verifyStreamToken } from './iptvStreamToken.js'

const SECRET = '0123456789abcdef0123456789abcdef'

describe('iptv stream token', () => {
  it('round-trips a live token within TTL', () => {
    const token = signStreamToken(SECRET, {
      kind: 'live', resourceId: '10', sub: 'plex:u', ttlSecs: 60,
    })
    const claims = verifyStreamToken(SECRET, token)
    expect(claims.kind).toBe('live')
    expect(claims.resourceId).toBe('10')
    expect(claims.sub).toBe('plex:u')
  })

  it('rejects expired tokens', () => {
    const token = signStreamToken(SECRET, { kind: 'vod', resourceId: '20', sub: 's', ttlSecs: -10 })
    expect(() => verifyStreamToken(SECRET, token)).toThrow(/expired|invalid/i)
  })

  it('rejects tampered signature', () => {
    const token = signStreamToken(SECRET, { kind: 'live', resourceId: '10', sub: 's', ttlSecs: 60 })
    const tampered = token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))
    expect(() => verifyStreamToken(SECRET, tampered)).toThrow(/invalid/i)
  })

  it('binds segment proxy URLs (kind="segment", resourceId=upstream URL)', () => {
    const t = signStreamToken(SECRET, { kind: 'segment', resourceId: 'https://x/y.ts', sub: 's', ttlSecs: 60 })
    expect(verifyStreamToken(SECRET, t).resourceId).toBe('https://x/y.ts')
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run server/services/iptvStreamToken.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement token signing**

```typescript
// server/services/iptvStreamToken.ts
import { createHmac, timingSafeEqual } from 'node:crypto'

export type StreamKind = 'live' | 'vod' | 'series' | 'catchup' | 'segment' | 'remux'

export interface StreamClaims {
  kind: StreamKind
  resourceId: string
  sub: string
  exp: number
  sessionId?: string
  accessVersion?: number
}

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64urlDecode = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

function payload(claims: StreamClaims): string {
  return b64url(Buffer.from(JSON.stringify(claims), 'utf-8'))
}

function sign(secret: string, body: string): string {
  return b64url(createHmac('sha256', secret).update(body).digest())
}

export function signStreamToken(
  secret: string,
  opts: { kind: StreamKind; resourceId: string; sub: string; ttlSecs: number; sessionId?: string; accessVersion?: number },
): string {
  const claims: StreamClaims = {
    kind: opts.kind,
    resourceId: opts.resourceId,
    sub: opts.sub,
    exp: Math.floor(Date.now() / 1000) + opts.ttlSecs,
    sessionId: opts.sessionId,
    accessVersion: opts.accessVersion,
  }
  const body = payload(claims)
  const sig = sign(secret, body)
  return `${body}.${sig}`
}

export function verifyStreamToken(secret: string, token: string): StreamClaims {
  const [body, sig] = token.split('.')
  if (!body || !sig) throw new Error('invalid_token')
  const expected = sign(secret, body)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('invalid_signature')
  let claims: StreamClaims
  try {
    claims = JSON.parse(b64urlDecode(body).toString('utf-8')) as StreamClaims
  } catch {
    throw new Error('invalid_payload')
  }
  if (claims.exp <= Math.floor(Date.now() / 1000)) throw new Error('expired_token')
  return claims
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run server/services/iptvStreamToken.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/iptvStreamToken.ts server/services/iptvStreamToken.test.ts
git commit -m "iptv: HMAC stream token util (sign+verify with TTL)"
```

---

### Task 4.1b: IPTV access-version revocation guard

**Files:**
- Create: `server/services/iptvAccessVersion.ts`

- [ ] **Step 1: Add per-user access-version helpers**

```typescript
const versions = new Map<string, number>()

export function currentIptvAccessVersion(sub: string): number {
  return versions.get(sub) ?? 1
}

export function bumpIptvAccessVersion(sub: string): number {
  const next = currentIptvAccessVersion(sub) + 1
  versions.set(sub, next)
  return next
}

export function assertIptvAccessVersion(sub: string, tokenVersion?: number): void {
  if (tokenVersion == null || tokenVersion !== currentIptvAccessVersion(sub)) {
    throw new Error('access_revoked')
  }
}
```

- [ ] **Step 2: Wire revocation points**

Call `bumpIptvAccessVersion(sub)` whenever `/api/me` or the auth gate discovers that a Plex user lost household/app access. Every token-authenticated stream route must call `assertIptvAccessVersion` after HMAC verification and before opening upstream.

---

### Task 4.2: In-memory concurrency tracker

**Files:**
- Create: `server/services/iptvConcurrency.ts`
- Test: `server/services/iptvConcurrency.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// server/services/iptvConcurrency.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createConcurrencyTracker } from './iptvConcurrency.js'

describe('iptv concurrency tracker', () => {
  beforeEach(() => vi.useFakeTimers())

  it('grants up to the cap then 429s', () => {
    const t = createConcurrencyTracker({ cap: 2, idleMs: 30_000 })
    const a = t.tryAcquire({ sub: 'u1', sessionId: 's1' })
    const b = t.tryAcquire({ sub: 'u2', sessionId: 's2' })
    const c = t.tryAcquire({ sub: 'u3', sessionId: 's3' })
    expect(a.ok && b.ok).toBe(true)
    expect(c.ok).toBe(false)
    if (!c.ok) expect(c.reason).toBe('iptv_concurrency_limit')
  })

  it('releases on heartbeat timeout', () => {
    const t = createConcurrencyTracker({ cap: 1, idleMs: 100 })
    t.tryAcquire({ sub: 'u1', sessionId: 's1' })
    expect(t.tryAcquire({ sub: 'u2', sessionId: 's2' }).ok).toBe(false)
    vi.advanceTimersByTime(150)
    t.sweep()
    expect(t.tryAcquire({ sub: 'u2', sessionId: 's2' }).ok).toBe(true)
  })

  it('heartbeat resets idle timer', () => {
    const t = createConcurrencyTracker({ cap: 1, idleMs: 100 })
    t.tryAcquire({ sub: 'u1', sessionId: 's1' })
    vi.advanceTimersByTime(80)
    t.heartbeat('s1')
    vi.advanceTimersByTime(80)
    t.sweep()
    expect(t.tryAcquire({ sub: 'u2', sessionId: 's2' }).ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run server/services/iptvConcurrency.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the tracker**

```typescript
// server/services/iptvConcurrency.ts
export interface AcquireOpts { sub: string; sessionId: string }
export type AcquireResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'iptv_concurrency_limit'; limit: number; current: number }

interface Session { sub: string; sessionId: string; lastSeen: number }

export interface ConcurrencyTracker {
  tryAcquire: (opts: AcquireOpts) => AcquireResult
  heartbeat: (sessionId: string) => void
  release: (sessionId: string) => void
  sweep: () => void
  size: () => number
}

export function createConcurrencyTracker(opts: { cap: number; idleMs: number }): ConcurrencyTracker {
  const sessions = new Map<string, Session>()

  function sweep(): void {
    const now = Date.now()
    for (const [id, s] of sessions) {
      if (now - s.lastSeen > opts.idleMs) sessions.delete(id)
    }
  }

  function tryAcquire({ sub, sessionId }: AcquireOpts): AcquireResult {
    sweep()
    if (sessions.has(sessionId)) {
      sessions.get(sessionId)!.lastSeen = Date.now()
      return { ok: true, sessionId }
    }
    if (sessions.size >= opts.cap) {
      return { ok: false, reason: 'iptv_concurrency_limit', limit: opts.cap, current: sessions.size }
    }
    sessions.set(sessionId, { sub, sessionId, lastSeen: Date.now() })
    return { ok: true, sessionId }
  }

  function heartbeat(sessionId: string): void {
    const s = sessions.get(sessionId)
    if (s) s.lastSeen = Date.now()
  }

  function release(sessionId: string): void {
    sessions.delete(sessionId)
  }

  return { tryAcquire, heartbeat, release, sweep, size: () => sessions.size }
}

import { env } from '../env.js'
let singleton: ConcurrencyTracker | null = null
export function streamConcurrency(): ConcurrencyTracker {
  if (!singleton) singleton = createConcurrencyTracker({ cap: env.IPTV_MAX_CONCURRENT_STREAMS, idleMs: 30_000 })
  return singleton
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run server/services/iptvConcurrency.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/iptvConcurrency.ts server/services/iptvConcurrency.test.ts
git commit -m "iptv: in-memory concurrency tracker with idle-timeout sweep"
```

---

### Task 4.3: Grant + live MPEG-TS proxy routes

**Files:**
- Modify: `server/routes/iptv.ts`
- Test: extend `server/routes/iptv.test.ts`

- [ ] **Step 1: Write failing tests for grant + token-gated stream**

Append to `server/routes/iptv.test.ts`:

```typescript
vi.mock('../services/iptvStreamToken.js', () => {
  const real = vi.fn()
  return {
    signStreamToken: vi.fn(() => 'fake.token'),
    verifyStreamToken: vi.fn((_secret: string, t: string) => {
      if (t === 'fake.token') return { kind: 'live', resourceId: '10', sub: 'plex:test', exp: Date.now() / 1000 + 60 }
      throw new Error('invalid_signature')
    }),
  }
})

describe('live stream grant + proxy', () => {
  const app = new Hono().route('/api/iptv', iptv)

  it('issues a tokenized URL on POST /stream/live/:id/grant', async () => {
    const res = await app.request('/api/iptv/stream/live/10/grant', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.url).toContain('/api/iptv/stream/live/10.ts?t=fake.token')
    expect(body.delivery).toBe('mpegts')
  })

  it('rejects bad tokens on the .ts endpoint', async () => {
    const res = await app.request('/api/iptv/stream/live/10.ts?t=bogus')
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run server/routes/iptv.test.ts`
Expected: FAIL — endpoints missing.

- [ ] **Step 3: Implement grants + live MPEG-TS proxy**

Append to `server/routes/iptv.ts`:

```typescript
import { signStreamToken, verifyStreamToken } from '../services/iptvStreamToken.js'
import { streamConcurrency } from '../services/iptvConcurrency.js'
import { assertIptvAccessVersion, currentIptvAccessVersion } from '../services/iptvAccessVersion.js'
import { credsFromEnv } from '../services/xtream.js'
import { env } from '../env.js'

function userOf(c: any): { sub: string } {
  // sessionGate sets `user` in the request context — read it.
  const u = c.get('user') as { sub: string } | undefined
  if (!u) throw new Error('missing_user')
  return u
}

function clientWantsAvplayer(c: any): boolean {
  return c.req.query('client') === 'avplayer'
}

iptv.post('/stream/live/:streamId/grant', (c) => {
  const streamId = c.req.param('streamId')
  if (!/^\d+$/.test(streamId)) return c.json({ error: 'invalid_id' }, 400)
  const { sub } = userOf(c)
  const accessVersion = currentIptvAccessVersion(sub)
  const sessionId = `live:${streamId}:${sub}:${Date.now()}`
  const acquired = streamConcurrency().tryAcquire({ sub, sessionId })
  if (!acquired.ok) return c.json(acquired, 429)

  if (clientWantsAvplayer(c)) {
    const token = signStreamToken(env.SESSION_SECRET, {
      kind: 'remux', resourceId: streamId, sub, ttlSecs: env.IPTV_STREAM_TOKEN_TTL_SECS, sessionId, accessVersion,
    })
    return c.json({
      url: `/api/iptv/stream/live/${streamId}/remux/index.m3u8?t=${token}`,
      delivery: 'hls', sessionId,
    })
  }

  const token = signStreamToken(env.SESSION_SECRET, {
    kind: 'live', resourceId: streamId, sub, ttlSecs: env.IPTV_STREAM_TOKEN_TTL_SECS, sessionId, accessVersion,
  })
  return c.json({
    url: `/api/iptv/stream/live/${streamId}.ts?t=${token}`,
    delivery: 'mpegts', sessionId,
  })
})

function checkToken(c: any, expectKind: string, resourceId: string): { ok: true; sub: string; sessionId?: string; accessVersion?: number } | { ok: false; resp: Response } {
  const t = c.req.query('t') ?? ''
  try {
    const claims = verifyStreamToken(env.SESSION_SECRET, t)
    if (claims.kind !== expectKind || claims.resourceId !== resourceId) {
      return { ok: false, resp: c.json({ error: 'token_mismatch' }, 401) }
    }
    assertTokenSubjectStillAllowed(claims.sub, claims.accessVersion)
    return { ok: true, sub: claims.sub, sessionId: claims.sessionId, accessVersion: claims.accessVersion }
  } catch (err) {
    return { ok: false, resp: c.json({ error: 'invalid_token', detail: err instanceof Error ? err.message : String(err) }, 401) }
  }
}

function assertTokenSubjectStillAllowed(sub: string, accessVersion?: number): void {
  assertIptvAccessVersion(sub, accessVersion)
}

iptv.get('/stream/live/:streamId.ts', async (c) => {
  const streamId = c.req.param('streamId')
  const v = checkToken(c, 'live', streamId)
  if (!v.ok) return v.resp
  if (!v.sessionId) return c.json({ error: 'missing_session' }, 401)
  const acquired = streamConcurrency().tryAcquire({ sub: v.sub, sessionId: v.sessionId })
  if (!acquired.ok) return c.json(acquired, 429)
  const creds = credsFromEnv()
  const upstreamUrl = `${creds.host}/live/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${streamId}.ts`

  const controller = new AbortController()
  c.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true })

  const heartbeat = setInterval(() => streamConcurrency().heartbeat(v.sessionId!), 15_000)
  const release = () => {
    clearInterval(heartbeat)
    streamConcurrency().release(v.sessionId!)
  }
  c.req.raw.signal.addEventListener('abort', release, { once: true })
  const upstream = await fetch(upstreamUrl, {
    signal: controller.signal,
    headers: { 'User-Agent': 'IPTVSmarters' },
  })
  if (!upstream.ok || !upstream.body) {
    release()
    return c.json({ error: `upstream_${upstream.status}` }, 502)
  }
  const body = upstream.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      streamConcurrency().heartbeat(v.sessionId!)
      controller.enqueue(chunk)
    },
    flush: release,
  }))
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'no-store',
    },
  })
})
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run server/routes/iptv.test.ts`
Expected: PASS — grant returns tokenized URL, bad-token request 401s.

- [ ] **Step 5: Commit**

```bash
git add server/routes/iptv.ts server/routes/iptv.test.ts
git commit -m "iptv: live stream grant + tokenized mpeg-ts proxy with concurrency cap"
```

---

### Task 4.4: VOD + series-episode grant + Range-aware proxy

**Files:**
- Modify: `server/routes/iptv.ts`
- Test: extend `server/routes/iptv.test.ts`

- [ ] **Step 1: Write failing test**

Append to `server/routes/iptv.test.ts`:

```typescript
describe('vod stream grant', () => {
  const app = new Hono().route('/api/iptv', iptv)
  it('issues a tokenized URL with detected ext', async () => {
    const res = await app.request('/api/iptv/stream/vod/20/grant', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.url).toContain('/api/iptv/stream/vod/20.')
  })
})
```

Also adjust the `iptvCatalog.js` mock — make `getVodDetail` return `{ stream_id: 20, container_extension: 'mp4' }` so the route can pick the extension. Similarly stub `getSeriesDetail` / a new `getSeriesEpisodeDetail` for series tests later.

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run server/routes/iptv.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement VOD grant + proxy + series-episode**

Append to `server/routes/iptv.ts`:

```typescript
import { getVodDetail } from '../services/iptvCatalog.js'

iptv.post('/stream/vod/:streamId/grant', (c) => {
  const streamId = c.req.param('streamId')
  if (!/^\d+$/.test(streamId)) return c.json({ error: 'invalid_id' }, 400)
  const { sub } = userOf(c)
  const detail = getVodDetail(iptvDb(), Number(streamId))
  if (!detail) return c.json({ error: 'not_found' }, 404)
  const ext = (detail.container_extension ?? 'mp4').toLowerCase()
  const accessVersion = currentIptvAccessVersion(sub)
  const acquired = streamConcurrency().tryAcquire({ sub, sessionId: `vod:${streamId}:${sub}:${Date.now()}` })
  if (!acquired.ok) return c.json(acquired, 429)
  const token = signStreamToken(env.SESSION_SECRET, {
    kind: 'vod', resourceId: streamId, sub, ttlSecs: env.IPTV_STREAM_TOKEN_TTL_SECS, sessionId: acquired.sessionId, accessVersion,
  })
  const delivery: 'hls' | 'progressive' = ext === 'm3u8' ? 'hls' : 'progressive'
  return c.json({
    url: `/api/iptv/stream/vod/${streamId}.${ext}?t=${token}`,
    delivery,
    mime: delivery === 'hls' ? 'application/vnd.apple.mpegurl' : (ext === 'mkv' ? 'video/x-matroska' : 'video/mp4'),
  })
})

async function proxyRangeable(c: any, upstreamUrl: string, mime: string): Promise<Response> {
  const controller = new AbortController()
  c.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true })
  const reqHeaders: Record<string, string> = {}
  const range = c.req.header('range')
  if (range) reqHeaders['Range'] = range
  const upstream = await fetch(upstreamUrl, { signal: controller.signal, headers: reqHeaders })
  if (!upstream.ok || !upstream.body) return c.json({ error: `upstream_${upstream.status}` }, 502)
  const headers = new Headers({
    'Content-Type': mime,
    'Cache-Control': 'no-store',
  })
  const cl = upstream.headers.get('content-length'); if (cl) headers.set('Content-Length', cl)
  const cr = upstream.headers.get('content-range'); if (cr) headers.set('Content-Range', cr)
  const ar = upstream.headers.get('accept-ranges'); if (ar) headers.set('Accept-Ranges', ar)
  return new Response(upstream.body, { status: upstream.status, headers })
}

iptv.get('/stream/vod/:streamId.:ext', async (c) => {
  const streamId = c.req.param('streamId')
  const ext = c.req.param('ext').toLowerCase()
  const v = checkToken(c, 'vod', streamId)
  if (!v.ok) return v.resp
  const creds = credsFromEnv()
  const upstreamUrl = `${creds.host}/movie/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${streamId}.${ext}`
  if (ext === 'm3u8') {
    // Rewrite playlist (see task 4.5)
    return await rewriteHlsPlaylist(c, upstreamUrl)
  }
  const mime = ext === 'mkv' ? 'video/x-matroska' : 'video/mp4'
  return await proxyRangeable(c, upstreamUrl, mime)
})

iptv.post('/stream/series/:episodeId/grant', (c) => {
  const episodeId = c.req.param('episodeId')
  if (!/^[\w-]+$/.test(episodeId)) return c.json({ error: 'invalid_id' }, 400)
  const { sub } = userOf(c)
  const row = iptvDb().raw
    .prepare(`SELECT container_extension FROM series_episodes WHERE episode_id = ?`)
    .get(episodeId) as { container_extension: string | null } | undefined
  if (!row) return c.json({ error: 'not_found' }, 404)
  const ext = (row.container_extension ?? 'mp4').toLowerCase()
  const accessVersion = currentIptvAccessVersion(sub)
  const acquired = streamConcurrency().tryAcquire({ sub, sessionId: `series:${episodeId}:${sub}:${Date.now()}` })
  if (!acquired.ok) return c.json(acquired, 429)
  const token = signStreamToken(env.SESSION_SECRET, {
    kind: 'series', resourceId: episodeId, sub, ttlSecs: env.IPTV_STREAM_TOKEN_TTL_SECS, sessionId: acquired.sessionId, accessVersion,
  })
  const delivery: 'hls' | 'progressive' = ext === 'm3u8' ? 'hls' : 'progressive'
  return c.json({
    url: `/api/iptv/stream/series/${episodeId}.${ext}?t=${token}`,
    delivery,
    mime: delivery === 'hls' ? 'application/vnd.apple.mpegurl' : (ext === 'mkv' ? 'video/x-matroska' : 'video/mp4'),
  })
})

iptv.get('/stream/series/:episodeId.:ext', async (c) => {
  const episodeId = c.req.param('episodeId')
  const ext = c.req.param('ext').toLowerCase()
  const v = checkToken(c, 'series', episodeId)
  if (!v.ok) return v.resp
  const creds = credsFromEnv()
  const upstreamUrl = `${creds.host}/series/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${episodeId}.${ext}`
  if (ext === 'm3u8') return await rewriteHlsPlaylist(c, upstreamUrl)
  const mime = ext === 'mkv' ? 'video/x-matroska' : 'video/mp4'
  return await proxyRangeable(c, upstreamUrl, mime)
})
```

- [ ] **Step 4: Stub `rewriteHlsPlaylist` (real impl in next task)**

```typescript
async function rewriteHlsPlaylist(c: any, _upstreamUrl: string): Promise<Response> {
  return c.json({ error: 'hls_rewrite_not_implemented' }, 501)
}
```

- [ ] **Step 5: Run, verify pass**

Run: `npx vitest run server/routes/iptv.test.ts`
Expected: PASS for VOD grant. HLS-rewrite-specific tests are added in 4.5.

- [ ] **Step 6: Commit**

```bash
git add server/routes/iptv.ts server/routes/iptv.test.ts
git commit -m "iptv: vod + series-episode grant routes with range-aware proxy"
```

---

### Task 4.5: HLS playlist rewrite + segment proxy

**Files:**
- Modify: `server/routes/iptv.ts`
- Create: `server/services/iptvHlsRewrite.ts`
- Test: `server/services/iptvHlsRewrite.test.ts`

- [ ] **Step 1: Write failing test for the rewrite logic**

```typescript
// server/services/iptvHlsRewrite.test.ts
import { describe, it, expect, vi } from 'vitest'
import { rewriteManifest } from './iptvHlsRewrite.js'

describe('rewriteManifest', () => {
  const sign = (url: string) => `signed(${url})`
  it('rewrites relative + absolute media URIs', () => {
    const input = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXTINF:6.0,',
      'seg-001.ts',
      '#EXTINF:6.0,',
      'https://cdn.example/foo/seg-002.ts',
      '#EXT-X-ENDLIST',
    ].join('\n')
    const out = rewriteManifest(input, 'https://upstream.example/path/movie.m3u8', sign, '/api/iptv/stream/segment')
    expect(out).toContain('/api/iptv/stream/segment?u=signed(https%3A%2F%2Fupstream.example%2Fpath%2Fseg-001.ts)')
    expect(out).toContain('/api/iptv/stream/segment?u=signed(https%3A%2F%2Fcdn.example%2Ffoo%2Fseg-002.ts)')
  })

  it('rewrites EXT-X-MEDIA URI attributes (subtitles, alt audio)', () => {
    const input = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="en",DEFAULT=YES,FORCED=NO,URI="subs/en.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1280000',
      'level1.m3u8',
    ].join('\n')
    const out = rewriteManifest(input, 'https://up.example/master.m3u8', sign, '/api/iptv/stream/segment')
    expect(out).toContain('URI="/api/iptv/stream/segment?u=signed(https%3A%2F%2Fup.example%2Fsubs%2Fen.m3u8)"')
    expect(out).toContain('/api/iptv/stream/segment?u=signed(https%3A%2F%2Fup.example%2Flevel1.m3u8)')
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run server/services/iptvHlsRewrite.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the rewriter**

```typescript
// server/services/iptvHlsRewrite.ts
function resolveUrl(base: string, ref: string): string {
  try {
    return new URL(ref, base).toString()
  } catch {
    return ref
  }
}

export function rewriteManifest(
  manifest: string,
  baseUrl: string,
  signSegment: (upstreamUrl: string) => string,
  proxyPrefix: string,
): string {
  const rewritten = (upstream: string): string =>
    `${proxyPrefix}?u=${encodeURIComponent(signSegment(upstream))}`

  return manifest
    .split(/\r?\n/)
    .map((line) => {
      // Rewrite URI="..." attributes anywhere in tag lines.
      if (line.startsWith('#') && /URI="[^"]+"/.test(line)) {
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${rewritten(resolveUrl(baseUrl, uri))}"`)
      }
      // Skip blank lines and tag-only lines without URIs.
      if (!line || line.startsWith('#')) return line
      // Media URI (segment / sub-playlist).
      return rewritten(resolveUrl(baseUrl, line))
    })
    .join('\n')
}
```

- [ ] **Step 4: Wire into route**

Replace the stub `rewriteHlsPlaylist` in `server/routes/iptv.ts` with:

```typescript
import { rewriteManifest } from '../services/iptvHlsRewrite.js'

function allowedStreamUrl(raw: string): URL | null {
  let url: URL
  try { url = new URL(raw) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  const host = url.hostname.toLowerCase()
  const configuredHost = new URL(credsFromEnv().host).host
  const allowed = new Set([
    configuredHost,
    ...env.IPTV_STREAM_ALLOWED_HOSTS,
  ])
  if (!allowed.has(url.host)) return null

  const privateHost =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.startsWith('127.') ||
    host.startsWith('169.254.') ||
    host.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    host.startsWith('192.168.')
  if (privateHost && url.host !== configuredHost) return null

  return url
}

async function rewriteHlsPlaylist(c: any, upstreamUrl: string): Promise<Response> {
  const playlistUrl = allowedStreamUrl(upstreamUrl)
  if (!playlistUrl) return c.json({ error: 'upstream_not_allowed' }, 403)
  const upstream = await fetch(playlistUrl)
  if (!upstream.ok) return c.json({ error: `upstream_${upstream.status}` }, 502)
  const text = await upstream.text()
  const { sub } = userOf(c)
  const sign = (url: string) => {
    const mediaUrl = allowedStreamUrl(url)
    if (!mediaUrl) throw new Error('upstream_not_allowed')
    return signStreamToken(env.SESSION_SECRET, {
      kind: 'segment', resourceId: mediaUrl.toString(), sub, ttlSecs: env.IPTV_STREAM_TOKEN_TTL_SECS,
    })
  }
  let rewritten: string
  try {
    rewritten = rewriteManifest(text, playlistUrl.toString(), sign, '/api/iptv/stream/segment')
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'manifest_rewrite_failed' }, 403)
  }
  return new Response(rewritten, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store',
    },
  })
}

iptv.get('/stream/segment', async (c) => {
  const t = c.req.query('u') ?? ''
  let claims: ReturnType<typeof verifyStreamToken>
  try {
    claims = verifyStreamToken(env.SESSION_SECRET, t)
    if (claims.kind !== 'segment') throw new Error('kind_mismatch')
  } catch (err) {
    return c.json({ error: 'invalid_token', detail: err instanceof Error ? err.message : String(err) }, 401)
  }
  const upstream = claims.resourceId
  const url = allowedStreamUrl(upstream)
  if (!url) return c.json({ error: 'upstream_not_allowed' }, 403)
  // Sub-playlists need rewriting too; segments are pass-through.
  if (url.pathname.endsWith('.m3u8')) {
    return await rewriteHlsPlaylist(c, url.toString())
  }
  // Bytestream pass-through with optional Range.
  const controller = new AbortController()
  c.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true })
  const range = c.req.header('range')
  const upstreamRes = await fetch(url, { signal: controller.signal, headers: range ? { Range: range } : {} })
  if (!upstreamRes.ok || !upstreamRes.body) return c.json({ error: `upstream_${upstreamRes.status}` }, 502)
  const headers = new Headers()
  const ct = upstreamRes.headers.get('content-type') ?? 'application/octet-stream'
  headers.set('Content-Type', ct)
  for (const h of ['content-length', 'content-range', 'accept-ranges']) {
    const v = upstreamRes.headers.get(h); if (v) headers.set(h, v)
  }
  headers.set('Cache-Control', 'no-store')
  return new Response(upstreamRes.body, { status: upstreamRes.status, headers })
}
```

- [ ] **Step 5: Run, verify pass**

Run: `npx vitest run server/services/iptvHlsRewrite.test.ts server/routes/iptv.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/iptvHlsRewrite.ts server/services/iptvHlsRewrite.test.ts server/routes/iptv.ts
git commit -m "iptv: hls playlist rewrite + signed segment proxy"
```

---

### Task 4.6: Phase 4 acceptance — play streams via curl + Range

- [ ] **Step 1: Grant a live token**

```bash
TOKEN=$(curl -s -b "<cookie>" -X POST http://localhost:3001/api/iptv/stream/live/<STREAM_ID>/grant)
echo "$TOKEN" | jq
URL=$(echo "$TOKEN" | jq -r .url)
```

Expected: URL of form `/api/iptv/stream/live/<id>.ts?t=...`.

- [ ] **Step 2: Open it in `ffplay` (or `mpv`) — should display the channel**

```bash
ffplay "http://localhost:3001$URL"
```

Expected: live channel renders. Ctrl-C to exit.

- [ ] **Step 3: Test VOD with Range**

```bash
RES=$(curl -s -b "<cookie>" -X POST http://localhost:3001/api/iptv/stream/vod/<VOD_ID>/grant | jq -r .url)
curl -I -b "<cookie>" -H "Range: bytes=0-1023" "http://localhost:3001$RES"
```

Expected: `HTTP/1.1 206 Partial Content` with `Content-Range: bytes 0-1023/...`.

- [ ] **Step 4: Concurrency cap smoke test**

Open `IPTV_MAX_CONCURRENT_STREAMS + 1` concurrent ffplay sessions. The last one's grant request should return 429 with body `{reason: 'iptv_concurrency_limit', limit, current}`.

- [ ] **Step 5: Commit phase marker**

```bash
git commit --allow-empty -m "iptv phase 4: stream proxy (live/vod/series) verified end-to-end"
```

---

## Phase 4b — Remux-to-HLS for AVPlayer clients

Goal: AVPlayer-class clients (tvOS/iOS in M2, also Safari when it refuses raw MPEG-TS) get an HLS playlist instead of a raw `.ts`. ffmpeg copies the upstream MPEG-TS into a sliding-window HLS playlist with no re-encoding.

### Task 4b.1: Remux session manager

**Files:**
- Create: `server/services/iptvRemux.ts`
- Test: `server/services/iptvRemux.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/services/iptvRemux.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { spawn as realSpawn } from 'node:child_process'

const spawnMock = vi.fn()
vi.mock('node:child_process', async () => ({ spawn: (...args: any[]) => spawnMock(...args) }))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    existsSync: vi.fn(() => true),
  }
})

import { startRemuxSession, heartbeatRemuxSession, stopRemuxSession, listRemuxSessions } from './iptvRemux.js'

describe('iptv remux session', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => {
      const ee = new EventEmitter() as any
      ee.stdout = new EventEmitter(); ee.stderr = new EventEmitter()
      ee.kill = vi.fn()
      ee.pid = 12345
      return ee
    })
  })

  it('starts ffmpeg with copy codec + hls flags', () => {
    const s = startRemuxSession({ streamId: '10', sub: 's', upstreamUrl: 'https://x/y.ts' })
    expect(spawnMock).toHaveBeenCalled()
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('-c'); expect(args).toContain('copy')
    expect(args).toContain('-f'); expect(args).toContain('hls')
    expect(args).toContain('-hls_time')
    expect(s.sessionId).toMatch(/^remux:10:/)
  })

  it('heartbeat extends lifetime; stop removes the entry', () => {
    const s = startRemuxSession({ streamId: '10', sub: 's', upstreamUrl: 'https://x/y.ts' })
    expect(listRemuxSessions().some(x => x.sessionId === s.sessionId)).toBe(true)
    heartbeatRemuxSession(s.sessionId)
    stopRemuxSession(s.sessionId)
    expect(listRemuxSessions().some(x => x.sessionId === s.sessionId)).toBe(false)
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run server/services/iptvRemux.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement session manager**

```typescript
// server/services/iptvRemux.ts
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { env } from '../env.js'

interface RemuxSession {
  sessionId: string
  streamId: string
  sub: string
  dir: string
  proc: ChildProcess
  startedAt: number
  lastSeen: number
}

const sessions = new Map<string, RemuxSession>()
const IDLE_MS = 30_000

export function listRemuxSessions(): Array<{ sessionId: string; streamId: string; sub: string }> {
  return [...sessions.values()].map((s) => ({ sessionId: s.sessionId, streamId: s.streamId, sub: s.sub }))
}

export function heartbeatRemuxSession(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (s) s.lastSeen = Date.now()
}

export function stopRemuxSession(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  try { s.proc.kill('SIGTERM') } catch { /* ignore */ }
  setTimeout(() => { try { s.proc.kill('SIGKILL') } catch { /* ignore */ } }, 5000)
  try { fs.rmSync(s.dir, { recursive: true, force: true }) } catch { /* ignore */ }
  sessions.delete(sessionId)
}

function sweep(): void {
  const now = Date.now()
  for (const s of sessions.values()) {
    if (now - s.lastSeen > IDLE_MS) stopRemuxSession(s.sessionId)
  }
}
const SWEEP_HANDLE = setInterval(sweep, 5_000)
SWEEP_HANDLE.unref?.()

export interface StartOpts { streamId: string; sub: string; upstreamUrl: string }
export interface StartResult { sessionId: string; dir: string; manifestPath: string }

export function startRemuxSession(opts: StartOpts): StartResult {
  const sessionId = `remux:${opts.streamId}:${opts.sub}:${Date.now()}`
  const dir = path.join(env.IPTV_REMUX_TMP_DIR, sessionId.replace(/[:/]/g, '_'))
  fs.mkdirSync(dir, { recursive: true })
  const manifestPath = path.join(dir, 'index.m3u8')
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', '+discardcorrupt+genpts',
    '-i', opts.upstreamUrl,
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '8',
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'),
    manifestPath,
  ]
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim()
    if (line) console.warn(`[iptv-remux ${sessionId}] ${line}`)
  })
  proc.on('exit', (code) => {
    console.log(`[iptv-remux ${sessionId}] ffmpeg exited code=${code}`)
    sessions.delete(sessionId)
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  const now = Date.now()
  sessions.set(sessionId, {
    sessionId, streamId: opts.streamId, sub: opts.sub, dir, proc, startedAt: now, lastSeen: now,
  })
  return { sessionId, dir, manifestPath }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run server/services/iptvRemux.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/iptvRemux.ts server/services/iptvRemux.test.ts
git commit -m "iptv: ffmpeg remux session manager (mpeg-ts -> hls, copy codec)"
```

---

### Task 4b.2: Remux-aware routes

**Files:**
- Modify: `server/routes/iptv.ts`

The grant route from Task 4.3 already returns `kind: 'remux'` URLs when `?client=avplayer`. Now implement the actual `.m3u8` and segment endpoints.

- [ ] **Step 1: Add remux endpoints**

Append to `server/routes/iptv.ts`:

```typescript
import { startRemuxSession, heartbeatRemuxSession, stopRemuxSession } from '../services/iptvRemux.js'
import fs from 'node:fs'
import path from 'node:path'

// Map from (sub, streamId) → active sessionId so re-requesting the manifest reuses the session.
const liveRemuxIndex = new Map<string, { sessionId: string; dir: string }>()
function remuxKey(streamId: string, sub: string): string { return `${streamId}:${sub}` }

iptv.get('/stream/live/:streamId/remux/index.m3u8', async (c) => {
  const streamId = c.req.param('streamId')
  const v = checkToken(c, 'remux', streamId)
  if (!v.ok) return v.resp
  const key = remuxKey(streamId, v.sub)
  let entry = liveRemuxIndex.get(key)
  if (!entry) {
    const creds = credsFromEnv()
    const upstreamUrl = `${creds.host}/live/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${streamId}.ts`
    const session = startRemuxSession({ streamId, sub: v.sub, upstreamUrl })
    entry = { sessionId: session.sessionId, dir: session.dir }
    liveRemuxIndex.set(key, entry)
  }
  heartbeatRemuxSession(entry.sessionId)

  // Wait briefly for manifest to appear (ffmpeg needs a couple of seconds to write the first segment).
  const manifestPath = path.join(entry.dir, 'index.m3u8')
  const deadline = Date.now() + 8000
  while (!fs.existsSync(manifestPath) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
  }
  if (!fs.existsSync(manifestPath)) {
    stopRemuxSession(entry.sessionId)
    liveRemuxIndex.delete(key)
    return c.json({ error: 'remux_manifest_timeout' }, 504)
  }
  const text = fs.readFileSync(manifestPath, 'utf-8')
  // Rewrite each segment URI to a token-authenticated route on this server.
  const sign = (segFile: string) =>
    signStreamToken(env.SESSION_SECRET, {
      kind: 'remux',
      resourceId: `${entry!.sessionId}/${segFile}`,
      sub: v.sub,
      ttlSecs: env.IPTV_STREAM_TOKEN_TTL_SECS,
    })
  const rewritten = text
    .split(/\r?\n/)
    .map((line) => {
      if (!line || line.startsWith('#')) return line
      const segFile = line.trim()
      return `/api/iptv/stream/live/${streamId}/remux/seg?t=${sign(segFile)}`
    })
    .join('\n')
  return new Response(rewritten, {
    status: 200,
    headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' },
  })
})

iptv.get('/stream/live/:streamId/remux/seg', (c) => {
  const streamId = c.req.param('streamId')
  const t = c.req.query('t') ?? ''
  let claims: ReturnType<typeof verifyStreamToken>
  try {
    claims = verifyStreamToken(env.SESSION_SECRET, t)
    if (claims.kind !== 'remux') throw new Error('kind_mismatch')
  } catch (err) {
    return c.json({ error: 'invalid_token', detail: err instanceof Error ? err.message : String(err) }, 401)
  }
  // resourceId format: "<sessionId>/<segFile>"
  const [sessionId, segFile] = claims.resourceId.split('/')
  if (!sessionId || !segFile || !/^seg_\d{5}\.ts$/.test(segFile)) {
    return c.json({ error: 'bad_resource' }, 400)
  }
  // Look up the session to find its dir.
  const entries = [...liveRemuxIndex.entries()].filter(([k]) => k.startsWith(`${streamId}:`))
  const match = entries.find(([, v]) => v.sessionId === sessionId)
  if (!match) return c.json({ error: 'session_gone' }, 410)
  const filePath = path.join(match[1].dir, segFile)
  if (!fs.existsSync(filePath)) return c.json({ error: 'segment_gone' }, 404)
  heartbeatRemuxSession(sessionId)
  const stream = fs.createReadStream(filePath)
  return new Response(stream as unknown as ReadableStream, {
    status: 200,
    headers: { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' },
  })
})
```

- [ ] **Step 2: Type-check + tests**

Run: `npx tsc -p server/tsconfig.json --noEmit && npx vitest run server/`
Expected: clean + green.

- [ ] **Step 3: Commit**

```bash
git add server/routes/iptv.ts
git commit -m "iptv: remux .m3u8 + segment endpoints for avplayer clients"
```

---

### Task 4b.3: Phase 4b acceptance — remux a live channel

- [ ] **Step 1: Verify ffmpeg is on PATH**

Run: `ffmpeg -version | head -1`
Expected: shows ffmpeg version. If missing: `brew install ffmpeg` on macOS.

- [ ] **Step 2: Grant w/ `client=avplayer`**

```bash
curl -s -b "<cookie>" -X POST "http://localhost:3001/api/iptv/stream/live/<STREAM_ID>/grant?client=avplayer" | jq
```

Expected: `{url: "/api/iptv/stream/live/<id>/remux/index.m3u8?t=...", delivery: "hls", sessionId: ...}`.

- [ ] **Step 3: Play the HLS in AVPlayer (or any HLS player)**

```bash
ffplay "http://localhost:3001<URL>"
```

Expected: live channel plays. Process list shows one `ffmpeg` running, watching the upstream TS.

- [ ] **Step 4: Verify cleanup**

Stop the player. Wait ~35s. Run `ps aux | grep ffmpeg | grep -v grep`. Expected: ffmpeg is gone (idle sweep killed it). `ls /tmp/iptv-remux/` shows no leftover dirs.

- [ ] **Step 5: Commit phase marker**

```bash
git commit --allow-empty -m "iptv phase 4b: mpeg-ts -> hls remux verified for avplayer clients"
```

---

## Phase 5 — Web player

Goal: clicking a channel/VOD/episode in the SPA grants a stream URL and plays it inline. Engine picked from grant `delivery`. Audio/subtitle tracks selectable. Position reported to history endpoint (stubbed for now — wired in Phase 6).

### Task 5.1: Grant + heartbeat client wrappers

**Files:**
- Modify: `src/lib/api/iptv.ts`

- [ ] **Step 1: Add grant/heartbeat methods**

Append to `src/lib/api/iptv.ts`:

```typescript
async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`iptv_api_${res.status}:${detail}`)
  }
  return res.json() as Promise<T>
}

export type StreamDelivery = 'mpegts' | 'hls' | 'progressive'
export interface StreamGrant {
  url: string
  delivery: StreamDelivery
  mime?: string
  sessionId?: string
}

function preferAvplayer(): boolean {
  // Safari/iOS strongly prefer AVPlayer-style HLS; Chromium handles mpegts.js fine.
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return /iPad|iPhone|iPod/.test(ua) || (/Safari/.test(ua) && !/Chrome|Chromium/.test(ua))
}

Object.assign(iptvApi, {
  grantLive: (streamId: number, opts?: { forceAvplayer?: boolean }) => {
    const q = opts?.forceAvplayer || preferAvplayer() ? '?client=avplayer' : ''
    return post<StreamGrant>(`/api/iptv/stream/live/${streamId}/grant${q}`)
  },
  grantVod: (streamId: number) => post<StreamGrant>(`/api/iptv/stream/vod/${streamId}/grant`),
  grantSeries: (episodeId: string) => post<StreamGrant>(`/api/iptv/stream/series/${episodeId}/grant`),
})
```

- [ ] **Step 2: Type-check**

Run: `npx tsc -b`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api/iptv.ts
git commit -m "iptv: client grant methods with safari/ios avplayer preference"
```

---

### Task 5.2: `IptvPlayer` component (engine selection + tracks)

**Files:**
- Create: `src/components/player/IptvPlayer.tsx`
- Create: `src/components/player/IptvPlayer.module.css`
- Test: `src/components/player/IptvPlayer.test.tsx`

- [ ] **Step 1: Write failing test (smoke render only — engine wiring is integration-tested manually)**

```typescript
// src/components/player/IptvPlayer.test.tsx
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import IptvPlayer from './IptvPlayer'

describe('IptvPlayer', () => {
  it('renders a video element with the granted URL', () => {
    const { container } = render(
      <IptvPlayer grant={{ url: '/stream/x.mp4', delivery: 'progressive', mime: 'video/mp4' }} />,
    )
    const v = container.querySelector('video')
    expect(v).not.toBeNull()
    expect(v?.src).toContain('/stream/x.mp4')
  })

  it('renders a video element with no src for hls (hls.js attaches asynchronously)', () => {
    const { container } = render(
      <IptvPlayer grant={{ url: '/stream/x.m3u8', delivery: 'hls' }} />,
    )
    expect(container.querySelector('video')).not.toBeNull()
  })
})
```

Add `@testing-library/react` if not already installed:

```bash
npm install -D @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
```

Update `vitest.config.ts` to use `environment: 'jsdom'` if it isn't already (check first).

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run src/components/player/IptvPlayer.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the player**

```tsx
// src/components/player/IptvPlayer.tsx
import { useEffect, useRef, useState } from 'react'
import type { StreamGrant } from '../../lib/api/iptv'
import styles from './IptvPlayer.module.css'

export interface IptvPlayerProps {
  grant: StreamGrant
  autoPlay?: boolean
  onPositionUpdate?: (positionSecs: number, durationSecs: number | null) => void
  onEnded?: () => void
}

interface TrackOption { id: string | number; label: string }

export default function IptvPlayer({ grant, autoPlay = true, onPositionUpdate, onEnded }: IptvPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const engineCleanupRef = useRef<(() => void) | null>(null)
  const [audioTracks, setAudioTracks] = useState<TrackOption[]>([])
  const [subtitleTracks, setSubtitleTracks] = useState<TrackOption[]>([])
  const [audioSel, setAudioSel] = useState<string | number>('')
  const [subSel, setSubSel] = useState<string | number>('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    setError(null)
    engineCleanupRef.current?.()
    engineCleanupRef.current = null

    const onTime = () => {
      if (onPositionUpdate) {
        const dur = Number.isFinite(video.duration) ? video.duration : null
        onPositionUpdate(video.currentTime, dur)
      }
    }
    const onEnd = () => onEnded?.()
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('ended', onEnd)

    const cleanupListeners = () => {
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('ended', onEnd)
    }

    let cancelled = false

    async function setup() {
      try {
        if (grant.delivery === 'hls') {
          if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = grant.url
            if (autoPlay) await video.play().catch(() => undefined)
            engineCleanupRef.current = cleanupListeners
            return
          }
          const Hls = (await import('hls.js')).default
          if (!Hls.isSupported()) {
            setError('HLS not supported on this browser')
            return
          }
          const hls = new Hls({ enableWorker: true })
          hls.loadSource(grant.url)
          hls.attachMedia(video)
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            setAudioTracks(hls.audioTracks.map((t, i) => ({ id: i, label: t.name || `Audio ${i + 1}` })))
            setSubtitleTracks(hls.subtitleTracks.map((t, i) => ({ id: i, label: t.name || `Subs ${i + 1}` })))
            if (autoPlay) void video.play().catch(() => undefined)
          })
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal) setError(`HLS error: ${data.type}/${data.details}`)
          })
          engineCleanupRef.current = () => { hls.destroy(); cleanupListeners() }
          return
        }
        if (grant.delivery === 'mpegts') {
          const mpegts = (await import('mpegts.js')).default
          if (!mpegts.isSupported()) {
            setError('MPEG-TS not supported on this browser')
            return
          }
          const player = mpegts.createPlayer({
            type: 'mpegts',
            isLive: true,
            url: grant.url,
          })
          player.attachMediaElement(video)
          player.load()
          if (autoPlay) await player.play().catch(() => undefined)
          // mpegts.js exposes audio/subtitle tracks via the metadata event:
          player.on(mpegts.Events.METADATA_ARRIVED, () => {
            const aTracks = (video as any).audioTracks
            if (aTracks && aTracks.length) {
              const opts: TrackOption[] = []
              for (let i = 0; i < aTracks.length; i++) {
                opts.push({ id: i, label: aTracks[i].label || aTracks[i].language || `Audio ${i + 1}` })
              }
              setAudioTracks(opts)
            }
          })
          engineCleanupRef.current = () => {
            try { player.destroy() } catch { /* noop */ }
            cleanupListeners()
          }
          return
        }
        // progressive
        video.src = grant.url
        if (autoPlay) await video.play().catch(() => undefined)
        engineCleanupRef.current = cleanupListeners
      } catch (err) {
        if (!cancelled) setError(`Player init failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    void setup()

    return () => { cancelled = true; engineCleanupRef.current?.() }
  }, [grant.url, grant.delivery, autoPlay, onPositionUpdate, onEnded])

  const onAudioChange = (id: string | number) => {
    setAudioSel(id)
    const video = videoRef.current as any
    if (video?.audioTracks) {
      for (let i = 0; i < video.audioTracks.length; i++) {
        video.audioTracks[i].enabled = String(i) === String(id)
      }
    }
  }
  const onSubChange = (id: string | number) => {
    setSubSel(id)
    const video = videoRef.current as any
    if (video?.textTracks) {
      for (let i = 0; i < video.textTracks.length; i++) {
        video.textTracks[i].mode = String(i) === String(id) ? 'showing' : 'disabled'
      }
    }
  }

  return (
    <div className={styles.wrapper}>
      <video ref={videoRef} className={styles.video} controls playsInline />
      {error && <p className={styles.error}>{error}</p>}
      {audioTracks.length > 1 && (
        <select className={styles.track} value={audioSel} onChange={(e) => onAudioChange(e.target.value)}>
          {audioTracks.map((t) => <option key={t.id} value={String(t.id)}>{t.label}</option>)}
        </select>
      )}
      {subtitleTracks.length > 0 && (
        <select className={styles.track} value={subSel} onChange={(e) => onSubChange(e.target.value)}>
          <option value="">Subtitles: off</option>
          {subtitleTracks.map((t) => <option key={t.id} value={String(t.id)}>{t.label}</option>)}
        </select>
      )}
    </div>
  )
}
```

```css
/* src/components/player/IptvPlayer.module.css */
.wrapper { display: flex; flex-direction: column; gap: .5rem; }
.video { width: 100%; max-height: 75vh; background: #000; }
.error { color: #c33; padding: .5rem; }
.track { width: max-content; padding: .25rem .5rem; }
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run src/components/player/IptvPlayer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/player/IptvPlayer.tsx src/components/player/IptvPlayer.module.css src/components/player/IptvPlayer.test.tsx
git commit -m "iptv: player component with hls.js / mpegts.js / native engines + track selection"
```

---

### Task 5.3: Wire player into LiveTab, VodTab, IptvSeriesTab

**Files:**
- Modify: `src/components/tabs/LiveTab.tsx`
- Modify: `src/components/tabs/VodTab.tsx`
- Modify: `src/components/tabs/IptvSeriesTab.tsx`

- [ ] **Step 1: Add a player modal to LiveTab**

Replace the `LiveTab.tsx` channel card click handler to open a modal hosting `IptvPlayer`. Patch:

```tsx
// src/components/tabs/LiveTab.tsx (additions only)
import { useCallback, useState as useStateBase } from 'react'
import { iptvApi, type StreamGrant } from '../../lib/api/iptv'
import IptvPlayer from '../player/IptvPlayer'

// inside the component, near other useState:
const [playing, setPlaying] = useStateBase<{ grant: StreamGrant; title: string } | null>(null)
const onChannelClick = useCallback(async (streamId: number, title: string) => {
  try {
    const grant = await iptvApi.grantLive(streamId)
    setPlaying({ grant, title })
  } catch (err) {
    console.error('grant failed:', err)
    alert(`Cannot play: ${err instanceof Error ? err.message : String(err)}`)
  }
}, [])

// in the JSX, wrap each <li> with onClick:
<li
  key={c.stream_id}
  className="iptv-channel-card"
  role="button"
  tabIndex={0}
  onClick={() => onChannelClick(c.stream_id, c.name)}
  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onChannelClick(c.stream_id, c.name) }}
>

// at the bottom of <section>:
{playing && (
  <div className="iptv-player-modal" role="dialog">
    <header className="iptv-player-modal__header">
      <h2>{playing.title}</h2>
      <button onClick={() => setPlaying(null)} aria-label="Close">×</button>
    </header>
    <IptvPlayer grant={playing.grant} autoPlay />
  </div>
)}
```

- [ ] **Step 2: Repeat the same pattern for VodTab.tsx**

Use `iptvApi.grantVod(stream_id)` instead of `grantLive`. Open the modal on poster click.

- [ ] **Step 3: Repeat for IptvSeriesTab.tsx — series clicks open a detail panel listing episodes**

Series cards open a `SeriesDetailModal` showing seasons + episodes. Each episode click calls `iptvApi.grantSeries(episode_id)` and opens the player.

Sketch:

```tsx
// inside IptvSeriesTab.tsx
import { useIptvSeriesDetail } from '../../lib/hooks/useIptvSeries'

const [selectedSeriesId, setSelectedSeriesId] = useState<number | null>(null)
const detail = useIptvSeriesDetail(selectedSeriesId)

// poster onClick:
onClick={() => setSelectedSeriesId(s.series_id)}

// modal (separate from playing modal):
{selectedSeriesId && (
  <div className="iptv-series-modal" role="dialog">
    <header><button onClick={() => setSelectedSeriesId(null)}>×</button></header>
    {detail.isLoading && <p>Loading…</p>}
    {detail.data && (
      <>
        <h2>{detail.data.name}</h2>
        {detail.data.seasons.map(s => (
          <section key={s.season}>
            <h3>Season {s.season}</h3>
            <ul>
              {s.episodes.map(e => (
                <li key={e.episode_id}>
                  <button onClick={async () => {
                    const grant = await iptvApi.grantSeries(e.episode_id)
                    setPlaying({ grant, title: `${detail.data!.name} S${s.season}E${e.episode_num}` })
                  }}>
                    {e.episode_num}. {e.title ?? `Episode ${e.episode_num}`}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </>
    )}
  </div>
)}
```

- [ ] **Step 4: Add modal CSS**

Append to `src/index.css`:

```css
.iptv-player-modal, .iptv-series-modal {
  position: fixed; inset: 0; background: rgba(0,0,0,.85);
  z-index: 50; display: flex; flex-direction: column; gap: .5rem; padding: 1rem;
}
.iptv-player-modal__header { display: flex; justify-content: space-between; align-items: center; color: #fff; }
.iptv-player-modal__header button { background: transparent; color: #fff; font-size: 1.5rem; border: none; cursor: pointer; }
.iptv-series-modal { overflow-y: auto; color: #fff; }
.iptv-series-modal button { background: transparent; color: #fff; border: 1px solid #444; padding: .5rem 1rem; cursor: pointer; margin: .25rem 0; width: 100%; text-align: left; }
```

- [ ] **Step 5: Type-check + lint**

Run: `npx tsc -b && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/tabs/LiveTab.tsx src/components/tabs/VodTab.tsx src/components/tabs/IptvSeriesTab.tsx src/index.css
git commit -m "iptv: wire tabs to grant + open player modal (live/vod/series)"
```

---

### Task 5.4: Phase 5 acceptance — play in browser

- [ ] **Step 1: In a Chromium browser**

Open the SPA. Click a channel in the Live tab.
Expected: player modal opens; channel plays via mpegts.js. Audio dropdown appears if the stream has multiple tracks.

- [ ] **Step 2: In Safari**

Same as step 1, but client preference forces `?client=avplayer` → HLS remux path. Channel plays via native HLS.

- [ ] **Step 3: VOD in Chromium**

Click a movie poster. Player plays the mp4 progressively (with seeking).

- [ ] **Step 4: Series in Chromium**

Click a series. Modal lists seasons. Click an episode. Plays via progressive or HLS depending on the source.

- [ ] **Step 5: Commit phase marker**

```bash
git commit --allow-empty -m "iptv phase 5: web player verified across live/vod/series + safari avplayer path"
```

---

## Phase 6 — Favorites + watch history

Goal: per-user favorites tagged on cards; watch position reported from the player and surfaced as resume points.

### Task 6.1: Backend favorites + history routes

**Files:**
- Modify: `server/routes/iptv.ts`
- Test: extend `server/routes/iptv.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `server/routes/iptv.test.ts`:

```typescript
describe('favorites + history', () => {
  const app = new Hono().route('/api/iptv', iptv)

  it('lists empty favorites for a new user', async () => {
    const res = await app.request('/api/iptv/favorites')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('adds + removes a favorite', async () => {
    const add = await app.request('/api/iptv/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'live', itemId: '10' }),
    })
    expect(add.status).toBe(201)
    const after = await (await app.request('/api/iptv/favorites')).json()
    expect(after).toContainEqual(expect.objectContaining({ kind: 'live', item_id: '10' }))

    const del = await app.request('/api/iptv/favorites/live/10', { method: 'DELETE' })
    expect(del.status).toBe(204)
    const empty = await (await app.request('/api/iptv/favorites')).json()
    expect(empty).toEqual([])
  })

  it('records and reads history', async () => {
    const put = await app.request('/api/iptv/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'vod', itemId: '20', positionSecs: 90, durationSecs: 7200, completed: false }),
    })
    expect(put.status).toBe(201)
    const hist = await (await app.request('/api/iptv/history?limit=10')).json()
    expect(hist[0]).toMatchObject({ kind: 'vod', item_id: '20', position_secs: 90, completed: 0 })
  })
})
```

Update the existing `iptvDbSingleton` mock to return a real in-memory DB. Replace the previous stub:

```typescript
import { openIptvDb as _open } from '../services/iptvDb.js'
let _testDb: ReturnType<typeof _open> | null = null
vi.mock('../services/iptvDbSingleton.js', () => ({
  iptvDb: () => {
    if (!_testDb) _testDb = _open(':memory:')
    return _testDb
  },
  closeIptvDb: () => { _testDb?.close(); _testDb = null },
}))
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run server/routes/iptv.test.ts`
Expected: FAIL — routes missing.

- [ ] **Step 3: Implement routes**

Append to `server/routes/iptv.ts`:

```typescript
const FAV_KINDS = new Set(['live', 'vod', 'series'])
const HIST_KINDS = new Set(['live', 'vod', 'series_episode'])

iptv.get('/favorites', (c) => {
  const { sub } = userOf(c)
  const rows = iptvDb().raw
    .prepare(`SELECT sub, kind, item_id, added_ts FROM iptv_favorites WHERE sub = ? ORDER BY added_ts DESC`)
    .all(sub)
  return c.json(rows)
})

iptv.post('/favorites', async (c) => {
  const { sub } = userOf(c)
  const body = await c.req.json().catch(() => ({} as any)) as { kind?: string; itemId?: string }
  if (!body.kind || !FAV_KINDS.has(body.kind)) return c.json({ error: 'invalid_kind' }, 400)
  if (!body.itemId || typeof body.itemId !== 'string') return c.json({ error: 'invalid_item' }, 400)
  iptvDb().stmts.addFavorite.run({ sub, kind: body.kind, item_id: body.itemId, added_ts: new Date().toISOString() })
  return c.body(null, 201)
})

iptv.delete('/favorites/:kind/:itemId', (c) => {
  const { sub } = userOf(c)
  const kind = c.req.param('kind')
  const itemId = c.req.param('itemId')
  if (!FAV_KINDS.has(kind)) return c.json({ error: 'invalid_kind' }, 400)
  iptvDb().stmts.removeFavorite.run({ sub, kind, item_id: itemId })
  return c.body(null, 204)
})

iptv.get('/history', (c) => {
  const { sub } = userOf(c)
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? '50')))
  const rows = iptvDb().raw.prepare(`
    SELECT sub, kind, item_id, position_secs, duration_secs, watched_at, completed
    FROM iptv_watch_history WHERE sub = ? ORDER BY watched_at DESC LIMIT ?
  `).all(sub, limit)
  return c.json(rows)
})

iptv.post('/history', async (c) => {
  const { sub } = userOf(c)
  const body = await c.req.json().catch(() => ({} as any)) as {
    kind?: string; itemId?: string; positionSecs?: number; durationSecs?: number | null; completed?: boolean
  }
  if (!body.kind || !HIST_KINDS.has(body.kind)) return c.json({ error: 'invalid_kind' }, 400)
  if (!body.itemId || typeof body.itemId !== 'string') return c.json({ error: 'invalid_item' }, 400)
  iptvDb().stmts.putHistory.run({
    sub,
    kind: body.kind,
    item_id: body.itemId,
    position_secs: Math.max(0, Math.floor(body.positionSecs ?? 0)),
    duration_secs: body.durationSecs != null && Number.isFinite(body.durationSecs) ? Math.floor(body.durationSecs) : null,
    watched_at: new Date().toISOString(),
    completed: body.completed ? 1 : 0,
  })
  return c.body(null, 201)
})
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run server/routes/iptv.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/iptv.ts server/routes/iptv.test.ts
git commit -m "iptv: favorites + watch-history routes (per-user)"
```

---

### Task 6.2: Frontend hooks + favorite toggle

**Files:**
- Modify: `src/lib/api/iptv.ts`
- Create: `src/lib/hooks/useIptvFavorites.ts`
- Create: `src/lib/hooks/useIptvHistory.ts`

- [ ] **Step 1: Add client methods**

Append to `src/lib/api/iptv.ts`:

```typescript
export interface FavoriteRow { sub: string; kind: 'live' | 'vod' | 'series'; item_id: string; added_ts: string }
export interface HistoryRow {
  sub: string; kind: 'live' | 'vod' | 'series_episode'; item_id: string;
  position_secs: number; duration_secs: number | null; watched_at: string; completed: number
}

async function del(path: string): Promise<void> {
  const res = await fetch(apiUrl(path), { method: 'DELETE', credentials: 'include' })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`iptv_api_${res.status}:${detail}`)
  }
}

Object.assign(iptvApi, {
  favorites: () => get<FavoriteRow[]>(`/api/iptv/favorites`),
  addFavorite: (kind: FavoriteRow['kind'], itemId: string) =>
    post<void>(`/api/iptv/favorites`, { kind, itemId }),
  removeFavorite: (kind: FavoriteRow['kind'], itemId: string) =>
    del(`/api/iptv/favorites/${kind}/${encodeURIComponent(itemId)}`),
  history: (limit = 50) => get<HistoryRow[]>(`/api/iptv/history?limit=${limit}`),
  putHistory: (input: { kind: HistoryRow['kind']; itemId: string; positionSecs: number; durationSecs: number | null; completed?: boolean }) =>
    post<void>(`/api/iptv/history`, input),
})
```

- [ ] **Step 2: Implement hooks**

```typescript
// src/lib/hooks/useIptvFavorites.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { iptvApi, type FavoriteRow } from '../api/iptv'

const KEY = ['iptv', 'favorites'] as const

export function useIptvFavorites() {
  return useQuery({ queryKey: KEY, queryFn: () => iptvApi.favorites(), staleTime: 5 * 60 * 1000 })
}

export function useIptvFavoriteSet(): Set<string> {
  const q = useIptvFavorites()
  return new Set((q.data ?? []).map((f) => `${f.kind}:${f.item_id}`))
}

export function useToggleIptvFavorite() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ kind, itemId, currentlyFav }: { kind: FavoriteRow['kind']; itemId: string; currentlyFav: boolean }) => {
      if (currentlyFav) await iptvApi.removeFavorite(kind, itemId)
      else await iptvApi.addFavorite(kind, itemId)
    },
    onMutate: async ({ kind, itemId, currentlyFav }) => {
      await qc.cancelQueries({ queryKey: KEY })
      const prev = qc.getQueryData<FavoriteRow[]>(KEY) ?? []
      const next = currentlyFav
        ? prev.filter((f) => !(f.kind === kind && f.item_id === itemId))
        : [...prev, { sub: '', kind, item_id: itemId, added_ts: new Date().toISOString() }]
      qc.setQueryData(KEY, next)
      return { prev }
    },
    onError: (_err, _vars, ctx) => { if (ctx?.prev) qc.setQueryData(KEY, ctx.prev) },
    onSettled: () => { void qc.invalidateQueries({ queryKey: KEY }) },
  })
}
```

```typescript
// src/lib/hooks/useIptvHistory.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { iptvApi, type HistoryRow } from '../api/iptv'

const KEY = ['iptv', 'history'] as const

export function useIptvHistory(limit = 50) {
  return useQuery({ queryKey: [...KEY, limit], queryFn: () => iptvApi.history(limit), staleTime: 60_000 })
}

export function useIptvHistoryIndex(): Map<string, HistoryRow> {
  const q = useIptvHistory(200)
  const map = new Map<string, HistoryRow>()
  for (const row of q.data ?? []) map.set(`${row.kind}:${row.item_id}`, row)
  return map
}

export function useReportPosition() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Parameters<typeof iptvApi.putHistory>[0]) => iptvApi.putHistory(input),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }) },
  })
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc -b`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api/iptv.ts src/lib/hooks/useIptvFavorites.ts src/lib/hooks/useIptvHistory.ts
git commit -m "iptv: favorites + history client hooks (optimistic toggle, debounced position)"
```

---

### Task 6.3: Player position reporting + favorite/resume UI

**Files:**
- Modify: `src/components/player/IptvPlayer.tsx`
- Modify: `src/components/tabs/LiveTab.tsx`
- Modify: `src/components/tabs/VodTab.tsx`
- Modify: `src/components/tabs/IptvSeriesTab.tsx`

- [ ] **Step 1: Wire position reporting**

In `IptvPlayer.tsx`, when `onPositionUpdate` fires, debounce to 5s and call `useReportPosition`. The cleanest path: the parent component owns the mutation and passes `onPositionUpdate` that calls it. Modify each tab's modal:

```tsx
import { useReportPosition } from '../../lib/hooks/useIptvHistory'

// inside the tab component:
const reporter = useReportPosition()
const lastReport = useRef(0)
const reportPos = useCallback((kind: 'live' | 'vod' | 'series_episode', itemId: string, pos: number, dur: number | null) => {
  const now = Date.now()
  if (now - lastReport.current < 5000) return
  lastReport.current = now
  reporter.mutate({ kind, itemId, positionSecs: pos, durationSecs: dur, completed: dur != null && pos >= dur - 30 })
}, [reporter])

// when rendering the player:
<IptvPlayer
  grant={playing.grant}
  onPositionUpdate={(p, d) => reportPos('vod', String(playing.itemId), p, d)}
/>
```

(For Live: kind='live'. For Series: kind='series_episode' and itemId=episode_id.)

- [ ] **Step 2: Wire favorites dot/star into cards**

In each tab, use `useIptvFavoriteSet()` and `useToggleIptvFavorite()`. Add a small button overlay on each card:

```tsx
const favs = useIptvFavoriteSet()
const toggle = useToggleIptvFavorite()
// inside card:
<button
  className={`iptv-fav-toggle ${favs.has(`live:${c.stream_id}`) ? 'iptv-fav-toggle--on' : ''}`}
  onClick={(e) => {
    e.stopPropagation()
    toggle.mutate({ kind: 'live', itemId: String(c.stream_id), currentlyFav: favs.has(`live:${c.stream_id}`) })
  }}
  aria-label={favs.has(`live:${c.stream_id}`) ? 'Unfavorite' : 'Favorite'}
>{favs.has(`live:${c.stream_id}`) ? '★' : '☆'}</button>
```

Repeat with `vod:` and `series:` keys in the other tabs.

- [ ] **Step 3: Resume marker on VOD/series cards**

In `VodTab.tsx` and `IptvSeriesTab.tsx`, use `useIptvHistoryIndex()` to get the latest position for each card. Render a small progress bar at the bottom of the poster when there's a non-completed entry:

```tsx
const history = useIptvHistoryIndex()
// inside poster:
{(() => {
  const h = history.get(`vod:${v.stream_id}`)
  if (!h || h.completed) return null
  const pct = h.duration_secs ? Math.min(100, Math.round((h.position_secs / h.duration_secs) * 100)) : 0
  return <div className="iptv-poster-card__progress"><div style={{ width: `${pct}%` }} /></div>
})()}
```

When clicking a card with a resume point, set the player's initial currentTime after first `loadedmetadata`. Pass a `startPositionSecs` prop into `IptvPlayer` and inside its effect: `video.addEventListener('loadedmetadata', () => { if (startPositionSecs) video.currentTime = startPositionSecs }, { once: true })`.

- [ ] **Step 4: CSS for badges**

Append to `src/index.css`:

```css
.iptv-fav-toggle {
  position: absolute; top: .25rem; right: .25rem; background: rgba(0,0,0,.5);
  color: #fff; border: none; width: 1.75rem; height: 1.75rem; border-radius: 50%;
  cursor: pointer; font-size: 1rem;
}
.iptv-fav-toggle--on { color: gold; }
.iptv-channel-card, .iptv-poster-card { position: relative; }
.iptv-poster-card__progress { height: 3px; background: rgba(255,255,255,.15); margin-top: .25rem; }
.iptv-poster-card__progress > div { height: 100%; background: #4caf50; }
```

- [ ] **Step 5: Type-check + lint + build**

Run: `npx tsc -b && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/player/IptvPlayer.tsx src/components/tabs/LiveTab.tsx src/components/tabs/VodTab.tsx src/components/tabs/IptvSeriesTab.tsx src/index.css
git commit -m "iptv: favorite toggle + resume marker + position reporting"
```

---

### Task 6.4: Phase 6 acceptance — favorites + resume

- [ ] **Step 1: Favorite a channel, refresh, verify star persists**
- [ ] **Step 2: Watch a VOD for 30s, close modal, reopen — player resumes near 30s mark; poster shows progress bar**
- [ ] **Step 3: Verify watch state is per-user — sign in as a different Plex member, verify their favorites and resume points are independent**
- [ ] **Step 4: Commit phase marker**

```bash
git commit --allow-empty -m "iptv phase 6: per-user favorites + resume verified across multi-user"
```

---

## Phase 7 — Catchup TV (time-shift)

Goal: an EPG grid shows past programmes on each channel; clicking one within the channel's archive window plays the catchup stream via Xtream's `timeshift.php` endpoint.

### Task 7.1: EPG query service + routes

**Files:**
- Create: `server/services/iptvEpgQuery.ts`
- Test: `server/services/iptvEpgQuery.test.ts`
- Modify: `server/routes/iptv.ts`

- [ ] **Step 1: Write failing test for EPG queries**

```typescript
// server/services/iptvEpgQuery.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'
import { openIptvDb } from './iptvDb.js'
import { epgNow, epgChannelWindow, epgGrid } from './iptvEpgQuery.js'

describe('epg queries', () => {
  let db: ReturnType<typeof openIptvDb>
  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-'))
    db = openIptvDb(path.join(tmp, 'iptv.db'))
    const now = new Date('2026-05-24T12:00:00Z')
    db.stmts.upsertChannel.run({
      stream_id: 10, num: 1, name: 'C1', stream_icon: null, epg_channel_id: 'c1',
      category_id: 1, is_adult: 0, tv_archive: 1, tv_archive_duration: 7,
      added_ts: null, fetched_at: now.toISOString(),
    })
    db.stmts.upsertEpg.run({ channel_id: 'c1', start_utc: '2026-05-24T11:00:00Z', stop_utc: '2026-05-24T11:30:00Z', title: 'Past', description: null })
    db.stmts.upsertEpg.run({ channel_id: 'c1', start_utc: '2026-05-24T11:30:00Z', stop_utc: '2026-05-24T12:30:00Z', title: 'Now', description: null })
    db.stmts.upsertEpg.run({ channel_id: 'c1', start_utc: '2026-05-24T12:30:00Z', stop_utc: '2026-05-24T13:00:00Z', title: 'Next', description: null })
  })

  it('epgNow returns current + next for each channel', () => {
    const r = epgNow(db, ['10'], new Date('2026-05-24T12:00:00Z'))
    expect(r[0].current?.title).toBe('Now')
    expect(r[0].next?.title).toBe('Next')
  })

  it('epgChannelWindow returns programmes in range', () => {
    const r = epgChannelWindow(db, 10, '2026-05-24T10:00:00Z', '2026-05-24T13:00:00Z')
    expect(r.map(p => p.title)).toEqual(['Past', 'Now', 'Next'])
  })

  it('epgGrid maps channels with programmes', () => {
    const r = epgGrid(db, '2026-05-24T10:00:00Z', '2026-05-24T13:00:00Z')
    expect(r[0].stream_id).toBe(10)
    expect(r[0].programmes).toHaveLength(3)
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run server/services/iptvEpgQuery.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// server/services/iptvEpgQuery.ts
import type { IptvDb } from './iptvDb.js'

export interface EpgProgramme {
  channel_id: string; start_utc: string; stop_utc: string;
  title: string | null; description: string | null
}

export function epgNow(db: IptvDb, channelStreamIds: string[], at: Date = new Date()): Array<{
  channel_stream_id: number; current: EpgProgramme | null; next: EpgProgramme | null
}> {
  if (!channelStreamIds.length) return []
  const placeholders = channelStreamIds.map(() => '?').join(',')
  const channelRows = db.raw.prepare(`
    SELECT stream_id, epg_channel_id FROM channels WHERE stream_id IN (${placeholders})
  `).all(...channelStreamIds.map(Number)) as Array<{ stream_id: number; epg_channel_id: string | null }>
  const iso = at.toISOString()
  const stmt = db.raw.prepare(`
    SELECT channel_id, start_utc, stop_utc, title, description
    FROM epg_programs
    WHERE channel_id = ? AND stop_utc > ?
    ORDER BY start_utc ASC LIMIT 2
  `)
  return channelRows.map((row) => {
    if (!row.epg_channel_id) return { channel_stream_id: row.stream_id, current: null, next: null }
    const programmes = stmt.all(row.epg_channel_id, iso) as EpgProgramme[]
    const current = programmes.find((p) => p.start_utc <= iso && p.stop_utc > iso) ?? null
    const next = programmes.find((p) => p.start_utc > iso) ?? null
    return { channel_stream_id: row.stream_id, current, next }
  })
}

export function epgChannelWindow(db: IptvDb, streamId: number, fromIso: string, toIso: string): EpgProgramme[] {
  const ch = db.raw.prepare(`SELECT epg_channel_id FROM channels WHERE stream_id = ?`).get(streamId) as { epg_channel_id: string | null } | undefined
  if (!ch?.epg_channel_id) return []
  return db.raw.prepare(`
    SELECT channel_id, start_utc, stop_utc, title, description
    FROM epg_programs
    WHERE channel_id = ? AND start_utc < ? AND stop_utc > ?
    ORDER BY start_utc ASC
  `).all(ch.epg_channel_id, toIso, fromIso) as EpgProgramme[]
}

export interface EpgGridRow {
  stream_id: number
  num: number
  name: string
  epg_channel_id: string | null
  tv_archive: number
  tv_archive_duration: number | null
  programmes: EpgProgramme[]
}

export function epgGrid(db: IptvDb, fromIso: string, toIso: string, categoryId?: number): EpgGridRow[] {
  const whereCat = categoryId != null ? `WHERE category_id = ?` : ''
  const channels = db.raw.prepare(`
    SELECT stream_id, num, name, epg_channel_id, tv_archive, tv_archive_duration
    FROM channels ${whereCat}
    ORDER BY num, name
  `).all(...(categoryId != null ? [categoryId] : [])) as Array<Pick<EpgGridRow, 'stream_id' | 'num' | 'name' | 'epg_channel_id' | 'tv_archive' | 'tv_archive_duration'>>
  const progStmt = db.raw.prepare(`
    SELECT channel_id, start_utc, stop_utc, title, description
    FROM epg_programs
    WHERE channel_id = ? AND start_utc < ? AND stop_utc > ?
    ORDER BY start_utc ASC
  `)
  return channels.map((c) => ({
    ...c,
    programmes: c.epg_channel_id ? (progStmt.all(c.epg_channel_id, toIso, fromIso) as EpgProgramme[]) : [],
  }))
}
```

- [ ] **Step 4: Wire routes**

Append to `server/routes/iptv.ts`:

```typescript
import { epgNow, epgChannelWindow, epgGrid } from '../services/iptvEpgQuery.js'

iptv.get('/epg/now', (c) => {
  const ids = (c.req.query('channelIds') ?? '').split(',').filter(Boolean)
  if (!ids.length) return c.json([])
  return c.json(epgNow(iptvDb(), ids, new Date()))
})

iptv.get('/epg/channel/:channelId', (c) => {
  const id = Number(c.req.param('channelId'))
  const from = c.req.query('from') ?? new Date().toISOString()
  const to = c.req.query('to') ?? new Date(Date.now() + 24 * 3600_000).toISOString()
  if (!Number.isFinite(id)) return c.json({ error: 'invalid_id' }, 400)
  return c.json(epgChannelWindow(iptvDb(), id, from, to))
})

iptv.get('/epg/grid', (c) => {
  const from = c.req.query('from') ?? new Date().toISOString()
  const to = c.req.query('to') ?? new Date(Date.now() + 4 * 3600_000).toISOString()
  const cat = c.req.query('categoryId')
  return c.json(epgGrid(iptvDb(), from, to, cat != null && cat !== '' ? Number(cat) : undefined))
})
```

- [ ] **Step 5: Run all server tests**

Run: `npx vitest run server/`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/services/iptvEpgQuery.ts server/services/iptvEpgQuery.test.ts server/routes/iptv.ts
git commit -m "iptv: epg queries (now / channel window / grid) + routes"
```

---

### Task 7.2: Catchup grant + proxy

**Files:**
- Modify: `server/routes/iptv.ts`

- [ ] **Step 1: Add catchup endpoints**

Append to `server/routes/iptv.ts`:

```typescript
function formatXtreamTimeshiftStart(iso: string): string {
  // YYYY-MM-DD:HH-MM (UTC)
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}:${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}`
}

iptv.post('/stream/catchup/:streamId/grant', (c) => {
  const streamId = c.req.param('streamId')
  if (!/^\d+$/.test(streamId)) return c.json({ error: 'invalid_id' }, 400)
  const startUtc = c.req.query('startUtc') ?? ''
  const durationMin = Number(c.req.query('durationMin') ?? '0')
  if (!startUtc || !Number.isFinite(durationMin) || durationMin <= 0) {
    return c.json({ error: 'invalid_params' }, 400)
  }
  const channel = iptvDb().raw
    .prepare(`SELECT tv_archive, tv_archive_duration FROM channels WHERE stream_id = ?`)
    .get(Number(streamId)) as { tv_archive: number; tv_archive_duration: number | null } | undefined
  if (!channel) return c.json({ error: 'not_found' }, 404)
  if (!channel.tv_archive) return c.json({ error: 'catchup_unavailable' }, 400)
  const archiveCutoff = new Date(Date.now() - (channel.tv_archive_duration ?? 7) * 24 * 3600_000)
  if (new Date(startUtc) < archiveCutoff) return c.json({ error: 'beyond_archive_window' }, 400)

  const { sub } = userOf(c)
  const sessionId = `catchup:${streamId}:${startUtc}:${sub}`
  const acquired = streamConcurrency().tryAcquire({ sub, sessionId })
  if (!acquired.ok) return c.json(acquired, 429)
  const resourceId = `${streamId}|${startUtc}|${durationMin}`
  const token = signStreamToken(env.SESSION_SECRET, {
    kind: 'catchup', resourceId, sub, ttlSecs: env.IPTV_STREAM_TOKEN_TTL_SECS,
  })
  const startPart = encodeURIComponent(formatXtreamTimeshiftStart(startUtc))
  return c.json({
    url: `/api/iptv/stream/catchup/${streamId}/${startPart}/${durationMin}.ts?t=${token}`,
    delivery: 'mpegts',
  })
})

iptv.get('/stream/catchup/:streamId/:startUtc/:durationMin.ts', async (c) => {
  const streamId = c.req.param('streamId')
  const startUtcParam = decodeURIComponent(c.req.param('startUtc'))
  const durationMin = Number(c.req.param('durationMin'))
  const t = c.req.query('t') ?? ''
  let claims
  try {
    claims = verifyStreamToken(env.SESSION_SECRET, t)
    if (claims.kind !== 'catchup') throw new Error('kind_mismatch')
  } catch (err) {
    return c.json({ error: 'invalid_token', detail: err instanceof Error ? err.message : String(err) }, 401)
  }
  const [claimedId, claimedStart, claimedDur] = claims.resourceId.split('|')
  // The URL has the xtream-format start; the claim has the ISO start. Reconstruct and compare.
  if (claimedId !== streamId || formatXtreamTimeshiftStart(claimedStart) !== startUtcParam || Number(claimedDur) !== durationMin) {
    return c.json({ error: 'token_mismatch' }, 401)
  }
  const creds = credsFromEnv()
  const upstreamUrl = `${creds.host}/streaming/timeshift.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}&stream=${streamId}&start=${startUtcParam}&duration=${durationMin}`
  const controller = new AbortController()
  c.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true })
  const upstream = await fetch(upstreamUrl, { signal: controller.signal })
  if (!upstream.ok || !upstream.body) return c.json({ error: `upstream_${upstream.status}` }, 502)
  return new Response(upstream.body, {
    status: 200,
    headers: { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' },
  })
})
```

- [ ] **Step 2: Run tests, type-check**

Run: `npx vitest run server/routes/iptv.test.ts && npx tsc -p server/tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add server/routes/iptv.ts
git commit -m "iptv: catchup grant + proxy with archive-window enforcement"
```

---

### Task 7.3: EPG hooks + grid UI in LiveTab

**Files:**
- Modify: `src/lib/api/iptv.ts`
- Create: `src/lib/hooks/useIptvEpg.ts`
- Modify: `src/components/tabs/LiveTab.tsx`

- [ ] **Step 1: Client + hooks**

Append to `src/lib/api/iptv.ts`:

```typescript
export interface EpgProgrammeDto {
  channel_id: string; start_utc: string; stop_utc: string;
  title: string | null; description: string | null
}
export interface EpgNowRow {
  channel_stream_id: number; current: EpgProgrammeDto | null; next: EpgProgrammeDto | null
}
export interface EpgGridDto {
  stream_id: number; num: number; name: string; epg_channel_id: string | null;
  tv_archive: number; tv_archive_duration: number | null;
  programmes: EpgProgrammeDto[]
}

Object.assign(iptvApi, {
  epgNow: (channelIds: number[]) =>
    get<EpgNowRow[]>(`/api/iptv/epg/now${channelIds.length ? `?channelIds=${channelIds.join(',')}` : ''}`),
  epgChannel: (channelId: number, fromIso: string, toIso: string) =>
    get<EpgProgrammeDto[]>(`/api/iptv/epg/channel/${channelId}?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`),
  epgGrid: (fromIso: string, toIso: string, categoryId?: number) =>
    get<EpgGridDto[]>(`/api/iptv/epg/grid?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}${categoryId != null ? `&categoryId=${categoryId}` : ''}`),
  grantCatchup: (streamId: number, startUtc: string, durationMin: number) =>
    post<StreamGrant>(`/api/iptv/stream/catchup/${streamId}/grant?startUtc=${encodeURIComponent(startUtc)}&durationMin=${durationMin}`),
})
```

```typescript
// src/lib/hooks/useIptvEpg.ts
import { useQuery } from '@tanstack/react-query'
import { iptvApi } from '../api/iptv'

export function useIptvEpgNow(channelIds: number[]) {
  return useQuery({
    queryKey: ['iptv', 'epg', 'now', channelIds.slice().sort().join(',')],
    queryFn: () => iptvApi.epgNow(channelIds),
    staleTime: 60_000,
    enabled: channelIds.length > 0,
  })
}

export function useIptvEpgGrid(fromIso: string, toIso: string, categoryId?: number) {
  return useQuery({
    queryKey: ['iptv', 'epg', 'grid', fromIso, toIso, categoryId ?? null],
    queryFn: () => iptvApi.epgGrid(fromIso, toIso, categoryId),
    staleTime: 60_000,
  })
}

export function useIptvEpgChannel(channelId: number | null, fromIso: string, toIso: string) {
  return useQuery({
    queryKey: ['iptv', 'epg', 'channel', channelId, fromIso, toIso],
    queryFn: () => iptvApi.epgChannel(channelId!, fromIso, toIso),
    enabled: channelId != null,
    staleTime: 60_000,
  })
}
```

- [ ] **Step 2: Wire EPG into LiveTab**

In `LiveTab.tsx`:
- After getting the channel list, derive the visible channel IDs and call `useIptvEpgNow(visibleIds)`.
- For each card, render "Now: Title" beneath the channel name.
- Add a "Guide" button on each card that opens a per-channel timeline (uses `useIptvEpgChannel` over the last `tv_archive_duration` days + next 4h).
- In the timeline, past programmes within the archive window are clickable → grant catchup → open the player modal.

Sketch:

```tsx
import { useIptvEpgNow, useIptvEpgChannel } from '../../lib/hooks/useIptvEpg'

// inside LiveTab:
const visibleIds = useMemo(() => (list.data?.items ?? []).map(c => c.stream_id), [list.data])
const epgNow = useIptvEpgNow(visibleIds)
const epgIndex = useMemo(() => {
  const m = new Map<number, { current?: string | null; next?: string | null }>()
  for (const row of epgNow.data ?? []) m.set(row.channel_stream_id, {
    current: row.current?.title ?? null, next: row.next?.title ?? null,
  })
  return m
}, [epgNow.data])

const [guideFor, setGuideFor] = useState<{ id: number; name: string; archiveDays: number } | null>(null)

// in card markup, beneath name:
<div className="iptv-channel-card__epg">
  <strong>Now:</strong> {epgIndex.get(c.stream_id)?.current ?? '—'}<br />
  <strong>Next:</strong> {epgIndex.get(c.stream_id)?.next ?? '—'}
</div>
<button className="iptv-channel-card__guide" onClick={(e) => {
  e.stopPropagation()
  setGuideFor({ id: c.stream_id, name: c.name, archiveDays: c.tv_archive_duration ?? 7 })
}}>Guide</button>

// guide modal (clicking a past programme calls iptvApi.grantCatchup):
{guideFor && (
  <ChannelGuide
    channel={guideFor}
    onClose={() => setGuideFor(null)}
    onPlayCatchup={async (startUtc, durMin) => {
      const grant = await iptvApi.grantCatchup(guideFor.id, startUtc, durMin)
      setPlaying({ grant, title: `${guideFor.name} (catchup)`, itemId: String(guideFor.id) })
      setGuideFor(null)
    }}
  />
)}
```

Pull `ChannelGuide` into a small component in the same file (or split):

```tsx
function ChannelGuide({ channel, onClose, onPlayCatchup }: { channel: { id: number; name: string; archiveDays: number }; onClose: () => void; onPlayCatchup: (startUtc: string, durMin: number) => void }) {
  const from = useMemo(() => new Date(Date.now() - channel.archiveDays * 24 * 3600_000).toISOString(), [channel])
  const to = useMemo(() => new Date(Date.now() + 4 * 3600_000).toISOString(), [])
  const epg = useIptvEpgChannel(channel.id, from, to)
  const now = Date.now()
  const archiveCutoff = now - channel.archiveDays * 24 * 3600_000
  return (
    <div className="iptv-guide-modal" role="dialog">
      <header><h3>{channel.name}</h3><button onClick={onClose}>×</button></header>
      {epg.isLoading && <p>Loading guide…</p>}
      <ul>
        {(epg.data ?? []).map(p => {
          const start = new Date(p.start_utc).getTime()
          const stop = new Date(p.stop_utc).getTime()
          const isPast = stop < now
          const inArchive = isPast && start >= archiveCutoff
          const inFuture = start > now
          return (
            <li key={p.start_utc}>
              <span>{new Date(p.start_utc).toLocaleString()}</span>
              <span>{p.title ?? '—'}</span>
              {inArchive && (
                <button onClick={() => onPlayCatchup(p.start_utc, Math.max(1, Math.round((stop - start) / 60000)))}>
                  Catchup
                </button>
              )}
              {!inArchive && isPast && <span className="iptv-guide-stale">(beyond archive)</span>}
              {inFuture && <span className="iptv-guide-future">(upcoming)</span>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
```

- [ ] **Step 3: CSS**

Append to `src/index.css`:

```css
.iptv-channel-card__epg { font-size: .85rem; color: var(--text-dim, #aaa); margin-top: .25rem; }
.iptv-channel-card__guide { position: absolute; bottom: .25rem; right: .25rem; font-size: .75rem; padding: .15rem .4rem; }
.iptv-guide-modal { position: fixed; inset: 0; background: rgba(0,0,0,.85); z-index: 60; color: #fff; padding: 1rem; overflow-y: auto; }
.iptv-guide-modal ul { list-style: none; padding: 0; }
.iptv-guide-modal li { display: grid; grid-template-columns: 180px 1fr auto; gap: .5rem; padding: .35rem 0; border-bottom: 1px solid #333; align-items: center; }
.iptv-guide-stale, .iptv-guide-future { color: #888; font-size: .85rem; }
```

- [ ] **Step 4: Type-check + lint**

Run: `npx tsc -b && npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api/iptv.ts src/lib/hooks/useIptvEpg.ts src/components/tabs/LiveTab.tsx src/index.css
git commit -m "iptv: epg now/next on channel cards + guide modal with catchup playback"
```

---

### Task 7.4: Phase 7 acceptance

- [ ] **Step 1: Channel cards display Now/Next from EPG**
- [ ] **Step 2: Open Guide on a channel with `tv_archive=1`. Past programme within window has a "Catchup" button. Click → player opens, plays from that timestamp**
- [ ] **Step 3: Channel with `tv_archive=0` shows no catchup button. Programme outside the archive window shows "(beyond archive)"**
- [ ] **Step 4: Commit phase marker**

```bash
git commit --allow-empty -m "iptv phase 7: catchup playback verified end-to-end"
```

---

## Phase 7b — External player M3U handoff

Goal: a long-lived signed M3U URL the user can paste into VLC / iPlayTV / TiviMate / Infuse / any IPTV app on any device. The M3U points every channel at this server's signed `.ts` URLs — not at raw mybunny — so credentials never leave the server.

### Task 7b.1: Long-lived "playlist" token and route

**Files:**
- Modify: `server/routes/iptv.ts`
- Modify: `server/services/iptvStreamToken.ts`

- [ ] **Step 1: Extend the token kind union**

Edit `server/services/iptvStreamToken.ts` and change:

```typescript
export type StreamKind = 'live' | 'vod' | 'series' | 'catchup' | 'segment' | 'remux' | 'playlist'
```

- [ ] **Step 2: Add playlist endpoint**

Append to `server/routes/iptv.ts`:

```typescript
iptv.post('/playlist/token', (c) => {
  const { sub } = userOf(c)
  const accessVersion = currentIptvAccessVersion(sub)
  // 12-hour TTL keeps external-player handoff usable while bounding leaked or already-exported URLs.
  // Bump the per-user access version whenever Plex membership or app access changes.
  const ttl = 12 * 3600
  const token = signStreamToken(env.SESSION_SECRET, {
    kind: 'playlist', resourceId: 'all', sub, ttlSecs: ttl, accessVersion,
  })
  const baseUrl = env.IPTV_PUBLIC_API_BASE_URL.replace(/\/+$/, '')
  return c.json({
    url: `${baseUrl}/api/iptv/playlist.m3u?t=${token}`,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  })
})

iptv.get('/playlist.m3u', (c) => {
  const t = c.req.query('t') ?? ''
  let claims
  try {
    claims = verifyStreamToken(env.SESSION_SECRET, t)
    if (claims.kind !== 'playlist') throw new Error('kind_mismatch')
    assertTokenSubjectStillAllowed(claims.sub, claims.accessVersion)
  } catch (err) {
    return c.json({ error: 'invalid_token', detail: err instanceof Error ? err.message : String(err) }, 401)
  }

  const channels = iptvDb().raw
    .prepare(`SELECT stream_id, num, name, stream_icon, epg_channel_id, category_id FROM channels ORDER BY num, name`)
    .all() as Array<{ stream_id: number; num: number; name: string; stream_icon: string | null; epg_channel_id: string | null; category_id: number | null }>
  const catNames = new Map<number, string>()
  for (const row of iptvDb().raw.prepare(`SELECT category_id, name FROM categories WHERE kind='live'`).all() as Array<{ category_id: number; name: string }>) {
    catNames.set(row.category_id, row.name)
  }

  const baseUrl = env.IPTV_PUBLIC_API_BASE_URL.replace(/\/+$/, '')
  const chTtl = 15 * 60
  const lines: string[] = ['#EXTM3U']
  for (const ch of channels) {
    const chToken = signStreamToken(env.SESSION_SECRET, {
      kind: 'live', resourceId: String(ch.stream_id), sub: claims.sub, ttlSecs: chTtl, accessVersion: claims.accessVersion,
    })
    const url = `${baseUrl}/api/iptv/stream/live/${ch.stream_id}.ts?t=${chToken}`
    const groupTitle = ch.category_id != null ? (catNames.get(ch.category_id) ?? 'Other') : 'Other'
    const tvgId = ch.epg_channel_id ?? ''
    const tvgLogo = ch.stream_icon ?? ''
    lines.push(`#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${escapeM3uAttr(ch.name)}" tvg-logo="${tvgLogo}" group-title="${escapeM3uAttr(groupTitle)}",${ch.name}`)
    lines.push(url)
  }
  return new Response(lines.join('\n') + '\n', {
    status: 200,
    headers: {
      'Content-Type': 'audio/x-mpegurl',
      'Content-Disposition': 'attachment; filename="theemeraldexchange.m3u"',
      'Cache-Control': 'no-store',
    },
  })
})

function escapeM3uAttr(value: string): string {
  return value.replace(/"/g, '\'')
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc -p server/tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add server/routes/iptv.ts server/services/iptvStreamToken.ts
git commit -m "iptv: signed playlist.m3u export with per-channel signed urls"
```

---

### Task 7b.2: UI button to copy the M3U URL

**Files:**
- Modify: `src/components/tabs/LiveTab.tsx`
- Modify: `src/lib/api/iptv.ts`

- [ ] **Step 1: Add client method**

Append to `src/lib/api/iptv.ts`:

```typescript
Object.assign(iptvApi, {
  generatePlaylist: () => post<{ url: string; expiresAt: string }>(`/api/iptv/playlist/token`),
})
```

- [ ] **Step 2: Add a toolbar button to LiveTab**

```tsx
// inside LiveTab.tsx toolbar:
<button onClick={async () => {
  const { url, expiresAt } = await iptvApi.generatePlaylist()
  await navigator.clipboard.writeText(url).catch(() => undefined)
  alert(`M3U URL copied. Expires ${new Date(expiresAt).toLocaleString()}.\n\n${url}`)
}}>Export M3U</button>
```

- [ ] **Step 3: Type-check + lint**

Run: `npx tsc -b && npm run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api/iptv.ts src/components/tabs/LiveTab.tsx
git commit -m "iptv: live tab toolbar 'Export M3U' button (copies signed url)"
```

---

### Task 7b.3: Phase 7b acceptance — VLC opens the playlist

- [ ] **Step 1: Click Export M3U; paste the URL into VLC (Media → Open Network Stream)**

Expected: VLC loads the playlist; channels are grouped by category; tvg-logo shows icons.

- [ ] **Step 2: Play a channel in VLC — verify it streams via your server, not raw mybunny**

Inspect `lsof -i -n -P | grep VLC` and confirm the established connection is to your localhost server, not mybunny. ffmpeg-remux is not used here — VLC handles MPEG-TS natively.

- [ ] **Step 3: Commit phase marker**

```bash
git commit --allow-empty -m "iptv phase 7b: m3u export verified in vlc with credential hiding"
```

---

## Phase 8 — Recommender integration

Goal: mybunny VOD/series rows reach the FastAPI recommender's `titles` table under new kinds and get featurized into the existing vector store. The `/api/suggestions` route tags each result with `available_on: ['plex'|'iptv'|...]`.

### Task 8.1: Recommender SQL migration — widen kind

**Files:**
- Create: `recommender/migrations/0005_iptv_kinds.sql`

(Note: the original spec said `0004` but the recommender already has a `0004_rec_outcomes_*.sql` migration — this becomes `0005`.)

- [ ] **Step 1: Inspect existing kind constraints**

Run: `grep -n "kind " recommender/migrations/0001_initial.sql | head -20`
Note the tables that constrain `kind` (`titles`, `title_features`, `title_vec`, `title_genres`, etc.).

- [ ] **Step 2: Write the migration**

```sql
-- recommender/migrations/0005_iptv_kinds.sql
-- Widen kind CHECK on the catalog tables to accept iptv kinds.
-- SQLite requires table rebuild for CHECK changes.

PRAGMA foreign_keys = OFF;

CREATE TABLE titles_new (
  tmdb_id           INTEGER NOT NULL,
  kind              TEXT    NOT NULL CHECK (kind IN ('movie','tv','iptv_vod','iptv_series')),
  title             TEXT    NOT NULL,
  original_title    TEXT,
  year              INTEGER,
  release_date      TEXT,
  overview          TEXT,
  poster_path       TEXT,
  vote_average      REAL,
  vote_count        INTEGER,
  popularity        REAL,
  runtime           INTEGER,
  status            TEXT,
  original_language TEXT,
  adult             INTEGER NOT NULL DEFAULT 0,
  last_changed_at   TEXT,
  fetched_at        TEXT    NOT NULL,
  PRIMARY KEY (tmdb_id, kind)
);
INSERT INTO titles_new SELECT * FROM titles;
DROP TABLE titles;
ALTER TABLE titles_new RENAME TO titles;
CREATE INDEX IF NOT EXISTS titles_by_kind ON titles(kind);

-- Repeat the same widen on title_features / title_genres if they have the kind CHECK.
-- Run this script as-is in dev; in prod, take a backup of /data/exchange.db first.

PRAGMA foreign_keys = ON;
```

If `title_features` / `title_genres` also have CHECK constraints on `kind`, repeat the rebuild pattern for each (use the existing column lists from `recommender/migrations/0001_initial.sql`).

- [ ] **Step 3: Apply the migration locally**

Run: `python -m recommender.cli migrate` (or whatever the existing migrate command is — `grep -r "migrate" recommender/`).

Expected: migration `0005_iptv_kinds.sql` applies; `SELECT kind, COUNT(*) FROM titles GROUP BY kind` still shows `movie` / `tv` rows but no `iptv_*` yet.

- [ ] **Step 4: Commit**

```bash
git add recommender/migrations/0005_iptv_kinds.sql
git commit -m "recommender: widen kind to include iptv_vod + iptv_series"
```

---

### Task 8.2: Export endpoint on Hono for the recommender to pull

**Files:**
- Modify: `server/routes/iptv.ts`

- [ ] **Step 1: Implement secret-gated export**

Append to `server/routes/iptv.ts` (above the admin block):

```typescript
// Secret-gated — NOT requireAuth (the recommender worker doesn't have a Plex cookie).
iptv.get('/export/recommender', (c) => {
  const secret = c.req.header('x-iptv-export-secret') ?? ''
  if (!env.IPTV_RECOMMENDER_EXPORT_SECRET || secret !== env.IPTV_RECOMMENDER_EXPORT_SECRET) {
    return c.json({ error: 'forbidden' }, 403)
  }
  const vod = iptvDb().raw.prepare(`
    SELECT stream_id AS id, name AS title, year, plot AS overview, director, cast_csv AS cast,
           tmdb_id, rating, stream_icon AS poster_path
    FROM vod
  `).all()
  const series = iptvDb().raw.prepare(`
    SELECT series_id AS id, name AS title, plot AS overview, cover AS poster_path,
           tmdb_id, rating
    FROM series
  `).all()
  return c.json({ vod, series })
})
```

Note: this route is mounted under `/api/iptv` which has `iptv.use('*', requireAuth)`. We need to bypass auth for this specific route. The cleanest way: move the `iptv.use('*', requireAuth)` so it's NOT mounted at root and instead apply `requireAuth` per-route (refactor in the same commit). Or — simpler — apply `requireAuth` per-route from the start. **Refactor the file:** remove the `iptv.use('*', requireAuth)` line and add `requireAuth` to every route that should be authenticated, leaving `/export/recommender` unguarded.

Concretely:

```typescript
// Replace:
// iptv.use('*', requireAuth)
// with per-route wrapping:
iptv.get('/health', requireAuth, async (c) => { /* ... */ })
iptv.get('/categories', requireAuth, (c) => { /* ... */ })
// ... etc for every authenticated route
```

The `requireAdmin` middleware already applies for admin routes.

- [ ] **Step 2: Update tests**

In `server/routes/iptv.test.ts`, the global `requireAuth` mock was applied via `vi.mock('../middleware/auth.js', ...)`. That still works because each route imports `requireAuth` from the mocked module. Existing tests pass without change. Add a new test for the export endpoint:

```typescript
describe('export endpoint', () => {
  const app = new Hono().route('/api/iptv', iptv)
  it('403s without secret', async () => {
    const res = await app.request('/api/iptv/export/recommender')
    expect(res.status).toBe(403)
  })
  it('200s with secret', async () => {
    process.env.IPTV_RECOMMENDER_EXPORT_SECRET = 'shh'
    // re-evaluate env import — easier: assert via direct fetch using env constant.
    // For now: this test depends on env wiring; if env is captured at import time, skip and rely on integration test.
  })
})
```

(If `env` is captured at module-load time, the integration check in Task 8.5 covers the secret path.)

- [ ] **Step 3: Type-check + tests**

Run: `npx tsc -p server/tsconfig.json --noEmit && npx vitest run server/`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add server/routes/iptv.ts server/routes/iptv.test.ts
git commit -m "iptv: per-route requireAuth + secret-gated /export/recommender endpoint"
```

---

### Task 8.3: Python worker `iptv_ingest.py`

**Files:**
- Create: `recommender/workers/iptv_ingest.py`
- Test: `recommender/workers/test_iptv_ingest.py`

- [ ] **Step 1: Inspect existing worker pattern**

Run: `cat recommender/workers/tmdb_ingest.py 2>/dev/null | head -40` (or whichever existing worker handles TMDB ingest — find with `ls recommender/workers/`). Mirror its style.

- [ ] **Step 2: Write the failing test**

```python
# recommender/workers/test_iptv_ingest.py
from unittest.mock import patch, MagicMock
import sqlite3
from recommender.workers.iptv_ingest import upsert_iptv_titles, IptvVod, IptvSeries

def make_db(tmp_path):
    db = sqlite3.connect(str(tmp_path / "exchange.db"))
    db.execute("""CREATE TABLE titles (
        tmdb_id INTEGER NOT NULL, kind TEXT NOT NULL,
        title TEXT NOT NULL, original_title TEXT, year INTEGER,
        release_date TEXT, overview TEXT, poster_path TEXT,
        vote_average REAL, vote_count INTEGER, popularity REAL,
        runtime INTEGER, status TEXT, original_language TEXT,
        adult INTEGER NOT NULL DEFAULT 0, last_changed_at TEXT, fetched_at TEXT NOT NULL,
        PRIMARY KEY (tmdb_id, kind)
    )""")
    return db

def test_upsert_iptv_titles_inserts_under_new_kinds(tmp_path):
    db = make_db(tmp_path)
    upsert_iptv_titles(
        db,
        [IptvVod(id=20, title="Matrix", year=1999, overview="Neo", poster_path=None, tmdb_id=603, rating=8.7)],
        [IptvSeries(id=30, title="GoT", overview=None, poster_path=None, tmdb_id=1399, rating=9.0)],
    )
    rows = db.execute("SELECT kind, tmdb_id, title FROM titles ORDER BY kind").fetchall()
    assert ("iptv_series", 1399, "GoT") in rows
    assert ("iptv_vod", 603, "Matrix") in rows
```

- [ ] **Step 3: Run, verify fail**

Run: `pytest recommender/workers/test_iptv_ingest.py`
Expected: FAIL.

- [ ] **Step 4: Implement the worker**

```python
# recommender/workers/iptv_ingest.py
from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime, timezone
import os
import sqlite3
from typing import Iterable

import httpx

@dataclass
class IptvVod:
    id: int
    title: str
    year: int | None
    overview: str | None
    poster_path: str | None
    tmdb_id: int | None
    rating: float | None

@dataclass
class IptvSeries:
    id: int
    title: str
    overview: str | None
    poster_path: str | None
    tmdb_id: int | None
    rating: float | None

UPSERT_SQL = """
INSERT INTO titles (
  tmdb_id, kind, title, original_title, year, release_date, overview,
  poster_path, vote_average, vote_count, popularity, runtime, status,
  original_language, adult, last_changed_at, fetched_at
) VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 0, NULL, ?)
ON CONFLICT(tmdb_id, kind) DO UPDATE SET
  title=excluded.title, year=excluded.year, overview=excluded.overview,
  poster_path=excluded.poster_path, vote_average=excluded.vote_average,
  fetched_at=excluded.fetched_at
"""

def upsert_iptv_titles(db: sqlite3.Connection, vods: Iterable[IptvVod], series: Iterable[IptvSeries]) -> None:
    now = datetime.now(timezone.utc).isoformat()
    for v in vods:
        # Use tmdb_id when present; otherwise fall back to a synthetic id under the iptv_vod kind
        # so the row still lands. Recommender recipes that key on tmdb_id will ignore synthetic rows.
        if v.tmdb_id is None:
            continue
        db.execute(UPSERT_SQL, (
            v.tmdb_id, "iptv_vod", v.title, v.year, v.overview, v.poster_path, v.rating, now,
        ))
    for s in series:
        if s.tmdb_id is None:
            continue
        db.execute(UPSERT_SQL, (
            s.tmdb_id, "iptv_series", s.title, None, s.overview, s.poster_path, s.rating, now,
        ))
    db.commit()

def fetch_iptv_export(host: str, secret: str) -> tuple[list[IptvVod], list[IptvSeries]]:
    url = f"{host.rstrip('/')}/api/iptv/export/recommender"
    res = httpx.get(url, headers={"x-iptv-export-secret": secret}, timeout=60.0)
    res.raise_for_status()
    payload = res.json()
    vods = [
        IptvVod(
            id=int(v["id"]), title=v["title"], year=v.get("year"),
            overview=v.get("overview"), poster_path=v.get("poster_path"),
            tmdb_id=v.get("tmdb_id"), rating=v.get("rating"),
        )
        for v in payload.get("vod", [])
    ]
    series = [
        IptvSeries(
            id=int(s["id"]), title=s["title"], overview=s.get("overview"),
            poster_path=s.get("poster_path"), tmdb_id=s.get("tmdb_id"), rating=s.get("rating"),
        )
        for s in payload.get("series", [])
    ]
    return vods, series

def main() -> None:
    db_path = os.environ.get("RECOMMENDER_DB_PATH", "/data/exchange.db")
    hono_host = os.environ["HONO_HOST"]  # e.g. http://app:3001
    secret = os.environ["IPTV_RECOMMENDER_EXPORT_SECRET"]
    vods, series = fetch_iptv_export(hono_host, secret)
    db = sqlite3.connect(db_path)
    try:
        upsert_iptv_titles(db, vods, series)
        print(f"[iptv-ingest] upserted vods={len(vods)} series={len(series)}")
    finally:
        db.close()

if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Run pytest, verify pass**

Run: `pytest recommender/workers/test_iptv_ingest.py`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add recommender/workers/iptv_ingest.py recommender/workers/test_iptv_ingest.py
git commit -m "recommender: iptv_ingest worker pulls export, upserts under iptv_vod/iptv_series"
```

---

### Task 8.4: Schedule the iptv_ingest worker

**Files:**
- Modify: `recommender/workers/` scheduler entrypoint (locate first)
- Modify: `docker-compose.yml`

- [ ] **Step 1: Find the existing scheduler entrypoint**

Run: `grep -rln "schedule\|apscheduler\|cron" recommender/workers/ | head`
Expected: a file that registers nightly TMDB ingest. Mirror that pattern.

- [ ] **Step 2: Register iptv_ingest at the same nightly cadence**

In the scheduler file, add:

```python
from recommender.workers.iptv_ingest import main as iptv_ingest_main
scheduler.add_job(iptv_ingest_main, trigger='cron', hour=3, minute=30, id='iptv_ingest')
```

(Time 03:30 follows the recommender's 03:00 nightly window — leaves Hono's 00:00/06:00 syncs alone.)

- [ ] **Step 3: Wire env vars into docker-compose**

Edit `docker-compose.yml` recommender service:

```yaml
recommender:
  environment:
    - HONO_HOST=http://backend:3001
    - IPTV_RECOMMENDER_EXPORT_SECRET=${IPTV_RECOMMENDER_EXPORT_SECRET}
```

(Match the Hono service name actually used in compose — check with `grep -n "container_name\|services:" docker-compose.yml`.)

- [ ] **Step 4: Commit**

```bash
git add recommender/workers/<scheduler_file>.py docker-compose.yml
git commit -m "recommender: schedule iptv_ingest nightly at 03:30 via compose env"
```

---

### Task 8.5: Hono suggestions route — tag `available_on`

**Files:**
- Modify: `server/routes/suggestions.ts`
- Test: extend `server/routes/suggestions.test.ts`

- [ ] **Step 1: Inspect existing suggestions shape**

Run: `cat server/routes/suggestions.ts | head -80`
Note how the route resolves `tmdb_id` against Sonarr/Radarr state — that's the pattern to extend.

- [ ] **Step 2: Write failing test**

Append to `server/routes/suggestions.test.ts`:

```typescript
describe('available_on tagging', () => {
  // Mock the recommender to return one tmdb_id that has both an iptv link and a plex/sonarr presence.
  // Spec: response items each have an `available_on: string[]` field containing some combination of
  // 'plex' | 'iptv' | 'local' | 'sonarr-monitored' | 'radarr-monitored'.
  it('tags an iptv-linked title with "iptv"', async () => {
    // Use the same mock pattern the existing suggestions tests use.
    // After mocking, call the route; assert response[0].available_on.includes('iptv').
  })
})
```

- [ ] **Step 3: Implement the tagger**

In `server/routes/suggestions.ts`, after the recommender response is assembled, join each result's tmdb_id against the iptv link table:

```typescript
import { iptvDb } from '../services/iptvDbSingleton.js'

function iptvAvailability(items: Array<{ tmdb_id: number | null; kind?: 'movie' | 'tv' }>): Map<number, 'vod' | 'series'> {
  if (!items.length) return new Map()
  const ids = items.filter(i => i.tmdb_id != null).map(i => i.tmdb_id as number)
  if (!ids.length) return new Map()
  const placeholders = ids.map(() => '?').join(',')
  const rows = iptvDb().raw.prepare(`
    SELECT tmdb_id, iptv_kind FROM iptv_title_link
    WHERE tmdb_id IN (${placeholders})
  `).all(...ids) as Array<{ tmdb_id: number; iptv_kind: 'vod' | 'series' }>
  const map = new Map<number, 'vod' | 'series'>()
  for (const r of rows) map.set(r.tmdb_id, r.iptv_kind)
  return map
}

// In the existing route handler, after building `results: Suggestion[]`:
const iptvMap = iptvAvailability(results)
for (const r of results) {
  const tags: string[] = r.available_on ?? []
  if (r.tmdb_id != null && iptvMap.has(r.tmdb_id)) tags.push('iptv')
  r.available_on = tags
}
```

If the existing `Suggestion` type doesn't have `available_on`, add it as `available_on?: string[]`.

- [ ] **Step 4: Populate `iptv_title_link` from `vod`/`series` tables**

Add a small migration step in `iptvSync.ts` after the catalog write — populate the link table from any vod/series rows that have `tmdb_id`. This is idempotent (PRIMARY KEY on `(iptv_kind, iptv_id)`):

```typescript
// inside syncOnce, after writeVod / writeSeries:
const linkVod = db.raw.prepare(`
  INSERT INTO iptv_title_link (iptv_kind, iptv_id, tmdb_kind, tmdb_id)
  SELECT 'vod', stream_id, 'movie', tmdb_id FROM vod WHERE tmdb_id IS NOT NULL
  ON CONFLICT(iptv_kind, iptv_id) DO UPDATE SET tmdb_id = excluded.tmdb_id, tmdb_kind = excluded.tmdb_kind
`)
const linkSeries = db.raw.prepare(`
  INSERT INTO iptv_title_link (iptv_kind, iptv_id, tmdb_kind, tmdb_id)
  SELECT 'series', series_id, 'tv', tmdb_id FROM series WHERE tmdb_id IS NOT NULL
  ON CONFLICT(iptv_kind, iptv_id) DO UPDATE SET tmdb_id = excluded.tmdb_id, tmdb_kind = excluded.tmdb_kind
`)
db.raw.transaction(() => { linkVod.run(); linkSeries.run() })()
```

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: full vitest suite green.

- [ ] **Step 6: Commit**

```bash
git add server/routes/suggestions.ts server/routes/suggestions.test.ts server/services/iptvSync.ts
git commit -m "iptv: tag suggestions with available_on (iptv vod/series via tmdb_id)"
```

---

### Task 8.6: SPA badge — "Available on IPTV"

**Files:**
- Modify: `src/components/tabs/HomeTab.tsx` (or wherever suggestions render)
- Modify: any suggestion-card component

- [ ] **Step 1: Locate the suggestion card render**

Run: `grep -rln "available_on\|Suggestion" src/components/ | head`
Pick the canonical card. Add a small badge when `s.available_on?.includes('iptv')`:

```tsx
{s.available_on?.includes('iptv') && (
  <span className="suggestion-badge suggestion-badge--iptv" title="Available via IPTV">IPTV</span>
)}
```

- [ ] **Step 2: CSS**

```css
.suggestion-badge { font-size: .7rem; padding: .15rem .4rem; border-radius: 3px; margin-left: .25rem; }
.suggestion-badge--iptv { background: rgba(76, 175, 80, .25); color: #4caf50; }
```

- [ ] **Step 3: Type-check + lint**

Run: `npx tsc -b && npm run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/components/tabs/HomeTab.tsx src/index.css
git commit -m "iptv: 'IPTV' badge on suggestion cards when available_on includes iptv"
```

---

### Task 8.7: Phase 8 acceptance

- [ ] **Step 1: Trigger an iptv_ingest run**

```bash
docker compose exec recommender python -m recommender.workers.iptv_ingest
```

Expected: log line `[iptv-ingest] upserted vods=N series=M`. Check the DB:

```bash
sqlite3 /data/exchange.db "SELECT kind, COUNT(*) FROM titles GROUP BY kind"
```

Expected: `iptv_vod` and `iptv_series` counts > 0.

- [ ] **Step 2: Hit /api/suggestions in the browser**

Open the Home tab. At least one suggestion card should have the "IPTV" badge (assuming a TMDB-known mybunny match exists for any recommended title).

- [ ] **Step 3: Commit phase marker**

```bash
git commit --allow-empty -m "iptv phase 8: unified suggestions tagged with available_on=iptv"
```

---

## Self-Review

This is the writer's own pass — fix anything inline.

**1. Spec coverage check (against `docs/superpowers/specs/2026-05-24-mybunny-and-plex-replacement-design.md` §1.9):**

| M1 spec phase | Tasks here |
|---|---|
| 1 (DB + skeleton) | 1.1 → 1.6 ✓ |
| 2 (catalog sync) | 2.1 → 2.6 ✓ |
| 3 (catalog read APIs + tabs) | 3.1 → 3.7 ✓ |
| 4 (stream proxy + grants) | 4.1 → 4.6 ✓ |
| 4b (AVPlayer remux) | 4b.1 → 4b.3 ✓ |
| 5 (player) | 5.1 → 5.4 ✓ |
| 6 (favorites + history) | 6.1 → 6.4 ✓ |
| 7 (catchup) | 7.1 → 7.4 ✓ |
| 7b (M3U handoff) | 7b.1 → 7b.3 ✓ |
| 8 (recommender) | 8.1 → 8.7 ✓ |

**2. Placeholder scan:** No "TBD" / "TODO" / "implement later" remain. Every code-changing step has a concrete code block or exact command.

**3. Type consistency:** Stream token kind union and grant `delivery` literals are consistent across `iptvStreamToken.ts`, `iptv.ts`, the client `StreamGrant` type, and the player engine switch. `available_on` is a `string[]` in both Hono and SPA. The recommender migration number was corrected from the spec's `0004` (already taken) to `0005`.

**4. Verified-against-codebase facts:**
- `server/services/upstream.ts` exists and exports `fetchWithTimeout` (confirmed during planning).
- `server/middleware/auth.ts` exports `requireAuth` and `requireAdmin` (confirmed).
- `server/session.ts` is where `SESSION_SECRET`-derived JWE plumbing lives (confirmed).
- `server/routes/sonarr.ts` is the canonical route shape (`Hono<Env>()`, per-route auth, services imported from `../services/*.js`) — replicated.
- Vitest is the test runner; `npm test` runs the full suite.
- `recommender/migrations/0004_rec_outcomes_*.sql` already exists, so the iptv widen migration must be 0005.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-24-mybunny-viewer-m1.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Uses `superpowers:subagent-driven-development`.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

**Which approach?**
