// server/services/mediaLibraryDb.ts
//
// Read-only accessor for media-core's library DB (media.db). media-core
// (Rust/sqlx) OWNS this file and performs ALL writes, migrations, and
// schema management — see crates/media-core/migrations/0001_init.sql.
// The server opens it strictly read-only so the recommender can stamp
// available_on:['local'] for titles the household already has on disk.
// We deliberately do NOT run migrations or enable WAL here: opening
// another writer (WAL switches the file into WAL journal mode, which is a
// write) would race media-core. readonly + fileMustExist guarantees we
// never create or mutate the file.
//
// IMPORT RULE (cross-cutting, applies project-wide): this module touches
// media.db via plain better-sqlite3 only, so it needs NOTHING from
// @emerald/contracts-napi today. If a future need arises here for the
// internal principal / JWE (e.g. forwarding a principal into media-core),
// it MUST be obtained through server/services/contractsBinding.ts
// (createRequire), never `import * as '@emerald/contracts-napi'` — the
// napi addon does not load under ESM via a bare import.

import Database from 'better-sqlite3'

export interface MediaLibraryDb {
  /** Underlying better-sqlite3 handle (opened read-only). */
  raw: Database.Database
  close(): void
}

/**
 * Open media-core's media.db READ-ONLY.
 *
 * - `readonly: true`  — no writes are ever attempted; any write throws.
 * - `fileMustExist: true` — never create the file; a missing media.db
 *   (media-core not yet deployed / never scanned) throws, which the
 *   singleton catches to degrade gracefully.
 *
 * No WAL pragma and no migrations: media-core owns all of that.
 */
export function openMediaLibraryDb(filePath: string): MediaLibraryDb {
  const raw = new Database(filePath, { readonly: true, fileMustExist: true })
  return {
    raw,
    close: () => raw.close(),
  }
}
