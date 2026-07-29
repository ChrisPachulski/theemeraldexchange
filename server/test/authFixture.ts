import { authModeFromSession, createSession, type Session } from '../session.js'
import { serverDb } from '../services/serverDb.js'

/** Mint a real session for an active member, matching the production login contract. */
export async function createMemberSession(payload: Session): Promise<string> {
  const authMode = payload.auth_mode ?? authModeFromSession(payload)

  serverDb()
    .raw.prepare(
      `INSERT INTO members
         (sub, display_name, role, auth_mode, invited_by, joined_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL, ?, NULL)
       ON CONFLICT(sub) DO UPDATE SET
         display_name = excluded.display_name,
         role = excluded.role,
         auth_mode = excluded.auth_mode,
         revoked_at = NULL`,
    )
    .run(payload.sub, payload.username, payload.role, authMode, new Date().toISOString())

  return createSession(payload)
}
