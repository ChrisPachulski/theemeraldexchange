// Writes the schema_migrations ledger the TS migrator records for a fresh
// server.db. The Rust db test opens a server.db from its embedded copies of
// the same files and must record the same (version, checksum) rows. Run from
// the repo root while server/services/db.ts still exists (it goes at step 3):
//   npx tsx crates/auth/tests/fixtures/gen-server-ledger.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '../../../../server/services/db.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-ledger-'))
const db = openDb(path.join(here, '../../../../server/migrations/server'), path.join(dir, 'server.db'), 'server')
const ledger = db.raw.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all()
db.close()
fs.rmSync(dir, { recursive: true, force: true })
fs.writeFileSync(path.join(here, 'server-ledger.json'), JSON.stringify(ledger, null, 2) + '\n')
