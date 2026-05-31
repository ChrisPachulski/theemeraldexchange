// GET /api/version — public, unauthenticated. Apple apps query this
// during PIN-pair to discover (a) the server_id for Keychain keying
// and (b) which auth_modes the server supports (so the app knows
// whether to offer Plex sign-in, local sign-in, Sign in with Apple,
// or some combination).
//
// Per contract §12.3 the response is intentionally minimal — no PII,
// no token material, no per-user state. A misconfigured tunnel can
// safely return this body to anyone on the internet.

import { Hono } from 'hono'
import Database from 'better-sqlite3'
import { env } from '../env.js'
import { ensureServerId } from '../session.js'

export const version = new Hono()

type SchemaState = { present: false } | { current: number | null }

function isMissingSchemaMigrationsTable(error: unknown): boolean {
  return error instanceof Error && error.message.includes('no such table: schema_migrations')
}

function schemaState(dbPath: string): SchemaState {
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const row = db
      .prepare('SELECT MAX(version) AS current FROM schema_migrations')
      .get() as { current: number | null } | undefined
    return { current: row?.current ?? null }
  } catch (error) {
    if (isMissingSchemaMigrationsTable(error)) return { current: null }
    return { present: false }
  } finally {
    db?.close()
  }
}

version.get('/', (c) => {
  const auth_modes: string[] = []
  // Plex is the only mode supported today; isPlexConfigured() always
  // returns true because PLEX_CLIENT_ID is `required()` at boot. The
  // shape is an array so M2+ work (local-auth, Sign in with Apple) can
  // add entries without a contract break.
  auth_modes.push('plex')

  return c.json({
    server_id: ensureServerId(),
    /** Build identifier from CI; falls back to 'dev'. */
    release: env.EEX_RELEASE,
    auth_modes,
    /** Mirrors contract §12.3 — apps gate "you may pair" on this. */
    accepting_device_pairs: !!env.deviceTokenSecret,
    schemas: {
      iptv: schemaState(env.IPTV_DB_PATH),
      exchange: schemaState(env.RECOMMENDER_DB_PATH),
      media: schemaState(env.MEDIA_DB_PATH),
    },
  })
})
