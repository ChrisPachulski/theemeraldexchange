
# Backend SQLite Data Layer — Teaching Dossier

*Scope: `server/migrations/server/` (6 migrations), `server/services/db.ts`, `server/services/migrator.ts`. The separate media catalog DB (`crates/media-core/src/db.rs`, `exchange-media-core:/data/media.db`) is noted where relevant but its schema is covered only briefly.*

---

## 1. WHAT

The Emerald Exchange backend stores all its persistent data — who's allowed in, what devices they own, what passkeys they've registered, and so on — inside a single SQLite database file called `server.db`. SQLite is a library, not a server process: the whole database is one file on disk, and the TypeScript backend reads and writes it directly using the `better-sqlite3` npm package. There is a second SQLite database, `iptv.db`, that holds all the IPTV channel and EPG data, and a third completely separate database (`media.db`) that lives inside a different Docker container altogether and is written by the Rust media-scanner service. All three follow the same "migrations" discipline: instead of one big `CREATE TABLE` dump, the schema is built up over time by a numbered sequence of small SQL files, each applied exactly once. When the app boots it checks which migrations have already run, skips them, and applies only the new ones. The migrator also records a SHA-256 checksum of each file so it can warn you if someone edited an already-applied migration — a common accidental error.

---

## 2. WHY

**Why SQLite over Postgres for a NAS homelab app?**

- **Single file, no server process.** Postgres requires its own daemon, port, authentication layer, and backup tooling. SQLite is just a file. On a NAS that also runs Plex, Docker, and assorted sidecars, fewer processes = less memory pressure and fewer crash failure modes.
- **Zero network hops.** A Postgres query goes: app → TCP → Postgres → disk. SQLite goes: app → disk. For a single-server deployment with light concurrent load this is measurably faster and dramatically simpler.
- **Backup is a file copy.** You can `tar` the whole data directory and you have a complete, consistent backup (with WAL mode caveats — see Section 5).
- **No migrations tool lock-in.** The app carries its own migrator in `server/services/migrator.ts`, a ~300-line TypeScript file. It does not depend on an external tool like Flyway or Knex — just `better-sqlite3` and Node's `fs`.

**Why migrations, and why chained in order?**

Schema changes in production cannot be applied by hand reliably — you'd need to SSH into the NAS, figure out what's already been applied, and execute SQL without typos, every time. Migrations solve this by making the schema's history a sequence of numbered, version-controlled files. The sequence property matters: migration 3 may `ALTER TABLE` a column that only exists because migration 2 created it. Run them out of order and the schema is corrupt. The migrator enforces strict version ordering: it reads all `.sql` files, sorts them by the leading number (`0001_`, `0002_`…), and applies only the ones not yet recorded in the `schema_migrations` ledger table. That ledger is created on the first-ever boot if it doesn't exist.

---

## 3. MAP

**Key files**

| File | Purpose |
|---|---|
| `server/services/db.ts` | `openDb()` — the single entry point that opens any SQLite file, sets PRAGMAs, runs migrations, returns a `ManagedDb` handle |
| `server/services/migrator.ts` | `applyMigrations()` — the hardened runner: checksum verification, DESTRUCTIVE guard, backup gate, legacy table rename |
| `server/migrations/server/0001_init.sql` | Creates `server_state (key, value, ts)` — a key/value store for server config (e.g. `last_backup_at`) |
| `server/migrations/server/0002_device_tokens.sql` | `device_tokens` + `device_token_revocations` — native app bearer tokens |
| `server/migrations/server/0003_members_invites.sql` | `members` + `invites` — the authZ allowlist and invite codes |
| `server/migrations/server/0004_webauthn.sql` | `webauthn_credentials` + `webauthn_challenges` — passkey / FIDO2 ceremony tables |
| `server/migrations/server/0005_device_token_username.sql` | `ALTER TABLE device_tokens ADD COLUMN username TEXT` — additive column, no data risk |
| `server/migrations/server/0006_user_api_keys.sql` | `user_api_keys (sub, ciphertext, updated_at)` — encrypted per-user Anthropic API keys |
| `crates/media-core/src/db.rs` | Rust equivalent of `db.ts` — opens `media.db`, same WAL+busy_timeout PRAGMAs, same checksum convention, different container |

**Entity-Relationship sketch (server.db)**

```
server_state
  key (PK) ──── e.g. 'last_backup_at'
  value
  ts

members
  sub (PK) ──────────────────────────────┐
  role (admin|user)                      │
  auth_mode (plex|local|apple)           │  "who is allowed in"
  invited_by ──── FK → members.sub       │
  revoked_at (NULL = active)             │
                                         │
invites                                  │
  code_hash (PK, sha256 of plaintext)    │
  issued_by ──── FK → members.sub ───────┘
  expires_at, max_uses, used_count

device_tokens                     device_token_revocations
  jti (PK) ────────────────────────── jti (PK, revoked copy)
  sub ──── FK → members.sub
  device_id, device_name, platform
  issued_at, expires_at, last_seen_at

webauthn_credentials              webauthn_challenges
  credential_id (PK)                challenge_id (PK)
  sub ──── FK → members.sub         ceremony (register|login)
  public_key (BLOB, COSE)           pending_sub, expires_at
  counter (replay detection)

user_api_keys
  sub (PK) ──── FK → members.sub
  ciphertext (AES-256-GCM, base64)
  updated_at
```

**How one write flows db-ward: a member joins via invite**

1. SPA POSTs `/api/auth/invite/redeem` with an invite code.
2. Hono route calls `server/services/migrator.ts`-managed `db.raw` handle (already open since boot).
3. A `BEGIN` transaction runs: verify `code_hash` exists in `invites`, check `used_count < max_uses`, insert a row into `members`, increment `used_count`, `COMMIT`.
4. `better-sqlite3` writes the change to the WAL file (`server.db-wal`) immediately.
5. SQLite checkpoints the WAL back to the main `server.db` file automatically when the WAL reaches ~1000 pages.

---

## 4. PREREQUISITES

**Tables and rows, for someone who has never seen SQL**

A database table is like a spreadsheet: it has named columns and rows of data. The `members` table has columns like `sub` (a text ID like `plex:12345`), `role` (the word `"admin"` or `"user"`), and `revoked_at` (a timestamp, or empty/NULL meaning the account is still active). Every row is one person. When code does `SELECT * FROM members WHERE revoked_at IS NULL` it is asking: "give me all the rows where the revoked_at column is empty" — i.e., all currently active members.

A **primary key** (PK) is the column that uniquely identifies each row. In `members`, `sub` is the PK — there can only ever be one row for `plex:12345`. If you try to insert a second one, the database rejects it.

A **foreign key** (FK) is a column in one table that must match a PK in another table. `device_tokens.sub` is a foreign key pointing at `members.sub`. This means you cannot register a device for a user who does not exist in `members`. The line `PRAGMA foreign_keys = ON` at the top of the migration files turns this enforcement on (SQLite defaults it off, for historical reasons).

An **index** is a behind-the-scenes sorted copy of one column that makes lookups faster. `CREATE INDEX device_tokens_by_sub ON device_tokens(sub)` means "when code asks for all tokens belonging to a particular sub, do not scan every row — use this index." Indexes cost a tiny bit of storage and slow down writes very slightly; they speed up reads a lot.

**Transactions, eli5**

A transaction is a way to say "do these several changes as one atomic unit — either all succeed or none of them are saved." Imagine the invite redemption above: you need to (a) insert the new member and (b) increment `used_count` on the invite. If the app crashes between (a) and (b), you'd have a new member whose invite still shows 0 uses — the invite could be redeemed again. Wrapping both writes in `BEGIN ... COMMIT` prevents this: if anything goes wrong, `ROLLBACK` undoes both writes as if they never happened. The migrator in `server/services/migrator.ts` lines 292–299 does exactly this for every migration it applies.

---

## 5. GOTCHAS AND WAR STORIES

**WAL mode: the three-file database**

When SQLite runs in WAL (Write-Ahead Log) mode — which this app always does (`PRAGMA journal_mode = WAL`) — the database is not a single file. It is three files:

- `server.db` — the main database pages, only updated during checkpoints
- `server.db-wal` — the "write-ahead log": new writes go here first, fast
- `server.db-shm` — a shared-memory index for readers to find their place in the WAL

All three must be treated as a unit. If you copy only `server.db` while the app is running, you get an incomplete and potentially corrupt backup — the live changes sitting in `server.db-wal` are missing. This is the exact failure mode that bit the Plex backup system: the appdata backup job used `tar` to archive live database files, and tar's streaming read saw the WAL change mid-read, producing a "file changed as we read it" error. The fix was to exclude the live `-wal` and `-shm` files from the tar archive and use the dated `.db-YYYY-MM-DD` backup copies instead.

The migrator itself knows about this: the `checkRecentBackup` guard in `migrator.ts` lines 57–96 refuses to run a `-- DESTRUCTIVE` migration unless `server_state.last_backup_at` shows a backup was taken within the last 10 minutes. This forces an operator to deliberately capture a consistent snapshot before any schema destruction.

**Reading a WAL-mode database read-only from another process**

If you open a WAL-mode SQLite file from a second process (e.g., a probe container, a debugging script), you must open it with the `immutable=1` URI parameter:

```
sqlite3 file:server.db?immutable=1
```

Without `immutable=1`, SQLite tries to acquire a shared lock and update the `-shm` file — which requires write permission on the directory. In a read-only Docker bind-mount this fails silently or crashes. With `immutable=1`, SQLite promises it will never write anything, which both removes the permission requirement and makes reads faster. This was discovered the hard way when probe containers against the live `iptv.db` appeared to work but were actually reading stale data (the WAL had not been checkpointed into the main file yet).

**The media catalog lives in a completely different container**

`server.db` and `iptv.db` are both owned by the Node backend container (`exchange-backend`). The media scanner — Rust, runs as `exchange-media-core` — writes a completely separate SQLite file: `exchange-media-core:/data/media.db`. The Node backend can read this file when the two containers share a Docker volume, but it is NOT opened via `server/services/db.ts`. It has its own migration system (`crates/media-core/src/db.rs`), its own table names (`media_files`, `movies`, `series`, `series_episodes` for the scanned library), and its own Rust connection pool via `sqlx`. When you are debugging a "movie not found" issue, check `media.db`, not `server.db`. They are on different containers and querying one when you mean the other wastes time.

The canonical way to query `media.db` interactively: `docker exec exchange-media-core` — or if the container's rootfs is read-only, copy the file out first: `docker cp exchange-media-core:/data/media.db /tmp/media.db` and query the copy.

**Feedback and grabs are NOT in SQLite**

The per-user like/dislike feedback store lives in a JSON file (`env.userFeedbackPath`, default `./data/feedback.json`). Grab history lives in a JSONL file (`./data/grabs.jsonl`). Neither is in the SQLite database. This surprises people who expect "all persistent data = database." The design choice was simplicity: feedback is low-volume (one household, a few hundred entries), append-friendly, and the JSON/JSONL format is self-describing and trivially inspectable with any text editor. The recommender Python service reads `feedback.json` directly, not via the DB. If you are grepping for where "likes" are stored and only look in the migrations, you will not find them.

---

## 6. QUIZ BANK

**Q1.** The app boots on a fresh NAS with no `server.db` file. Walk through what happens in `openDb()`. What files are created on disk, and in what order?

*Answer:* `openDb` calls `fs.mkdirSync` to create the parent directory (e.g. `./data/`) if it doesn't exist. `new Database(dbPath)` creates the empty `server.db` file. The four PRAGMAs are set immediately: `busy_timeout=5000`, `journal_mode=WAL` (this creates `server.db-wal` and `server.db-shm`), `synchronous=NORMAL`, `foreign_keys=ON`. Then `applyMigrations()` is called: `bootstrapMigrationsTable` runs, finds no existing tables, creates `schema_migrations`. Each of the 6 migration files is read, checksummed, executed in a transaction, and recorded. After migration 0001 runs, `server_state` exists. After 0002, `device_tokens` and `device_token_revocations` exist. And so on through 0006.

**Q2.** A developer edits `0003_members_invites.sql` to add a `nickname TEXT` column, then restarts the app. The column does not appear. What happened and how would you fix it?

*Answer:* The migrator sees that migration version 3 is already recorded in `schema_migrations`. It computes the new checksum, notices it does not match the stored one, and logs a warning ("checksum mismatch on 3...") — but it skips the migration entirely. The migration has already run; re-running it would attempt to `CREATE TABLE IF NOT EXISTS members` again (a no-op because `IF NOT EXISTS`) and still not add `nickname`. The fix is to create a new migration file — `0007_members_nickname.sql` — with `ALTER TABLE members ADD COLUMN nickname TEXT`. Never edit an already-applied migration to add schema; always write a new additive migration.

**Q3.** You want to drop the `device_token_revocations` table because it's being replaced. You write `0007_replace_revocations.sql` containing `DROP TABLE device_token_revocations;`. The app refuses to start. Why, and what two things must you do to fix it?

*Answer:* The migrator's regex `/\bDROP\s+TABLE\b/i` detects the DROP TABLE and checks for the `-- DESTRUCTIVE` comment on its own line. The comment is missing, so the migrator throws: "Migration 0007... contains DROP TABLE but is missing the required '-- DESTRUCTIVE' comment." Fix 1: add `-- DESTRUCTIVE` on its own line at the top of the file. Fix 2: before restarting, POST to `/api/admin/backup` — the `checkRecentBackup` guard will then refuse the migration unless `server_state.last_backup_at` is within the last 10 minutes.

**Q4.** A user reports that when she closes her laptop and opens it elsewhere, the app forces her to re-authenticate. The session system should be keeping her logged in. You suspect a device token issue. What table do you query, and what columns tell you whether her token was revoked vs. just expired?

*Answer:* Query `device_tokens` filtered by her `sub`. The `expires_at` column (ISO-8601) tells you whether the token has naturally expired. Then cross-reference `device_token_revocations`: if her `jti` appears there, it was explicitly revoked (e.g. by an admin). An expired token means the app needs to issue a new one (re-pair the device). A revoked token means someone deliberately invalidated it. The `last_seen_at` column also tells you the last time the token was successfully used, which helps confirm it was ever valid on her device.

**Q5.** You want to add a script that reads `server.db` offline while the backend container is running. You mount the data directory read-only into a temporary container and open the database. It crashes with "unable to open database file." What is the most likely cause, and how do you fix it?

*Answer:* WAL mode requires SQLite to create or write the `-shm` (shared memory) index file alongside the database. In a read-only bind-mount, that write is forbidden and SQLite refuses to open. Fix: open the file with the `immutable=1` URI parameter: `sqlite3 "file:server.db?immutable=1"`. This tells SQLite it must not write anything, bypasses the `-shm` requirement, and allows a clean read-only open. Note: `immutable=1` means you may not see writes that are in the WAL but have not been checkpointed yet; for a quick schema inspection or debugging read this is fine.

---

## 7. CODE-READING EXERCISE

**Guided walk through `server/migrations/server/0003_members_invites.sql`**

Open the file at `server/migrations/server/0003_members_invites.sql`. Read it top-to-bottom with these questions as a guide.

**Line 1** — The comment says "authZ allowlist (members) + owner-issued invites." Before reading further, try to guess why these two tables are in the same migration file rather than separate files.

*(Answer: they are logically coupled — invites create members. Grouping them in one migration ensures they are both present or both absent; you can never have the `invites` table without `members`. A migration that creates related tables together is a cohesion signal.)*

**Lines 7–9** — `PRAGMA foreign_keys = ON` appears again even though `db.ts` already sets it. Why does it appear inside the migration file too?

*(Answer: SQLite PRAGMAs are per-connection settings, not stored schema. `db.ts` sets it on the live connection, which is always active. The PRAGMA inside the `.sql` file is documentation-as-enforcement: it ensures that if someone ever runs this file directly with `sqlite3` from the command line, foreign keys are still enforced during the migration itself. It has no effect when the migrator runs it via `db.exec()` because the connection already has FK enforcement on.)*

**Lines 18–26** — The `members` table has no integer auto-increment `id` column. The `sub` column is the primary key. What kind of values go in `sub`, and why is this a better design than a numeric ID for an identity table?

*(Answer: `sub` holds namespaced identity strings like `apple:ABCDEF123`, `plex:494190801`, or `local:01JFHEK...` (a ULID). Using the identity provider's own identifier as the PK means there is no separate step needed to "look up the real ID" after authentication — the subject claim from the session cookie IS the PK. A numeric surrogate key would require a join every time you went from "authenticated user" to "is this user allowed in?" By making the auth provider's ID the PK, the allowlist check is a single equality lookup: `SELECT 1 FROM members WHERE sub = ? AND revoked_at IS NULL`.)*

**Lines 35–44** — The `invites` table stores `code_hash`, not the plaintext code. The comment says the plaintext is shown "exactly once at creation and never stored." Sketch the security model: what threat does this prevent, and why is sha256 acceptable here instead of a slow KDF like bcrypt?

*(Answer: storing the hash prevents a database dump from leaking redeemable invite codes — an attacker who reads `invites` gets only hashes. sha256 is acceptable (rather than bcrypt/argon2) because the code is 128-bit random, not a human-chosen password. A 128-bit random value has no dictionary, no low-entropy guessing attack, and no precomputed rainbow table — the only attack is brute-force of 2^128 possibilities, which is computationally infeasible regardless of how fast the hash algorithm is. bcrypt's slowness only helps when the input space is small and predictable, like passwords.)*

**The `schema_migrations` ledger** — After this migration runs, what does the row inserted into `schema_migrations` look like?

*(Answer: `version=3, applied_at='2026-06-11T...Z' (ISO-8601), checksum='<hex sha256 of the file contents>'`. If you later edit the file (e.g. to add a comment), the next boot will compute a new checksum, compare it to the stored `3 → <original hex>`, and log a warning but not crash or re-run the migration.)*

---

