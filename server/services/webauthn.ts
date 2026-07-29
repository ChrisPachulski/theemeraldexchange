// server/services/webauthn.ts — passkey (WebAuthn) ceremony engine.
//
// Wraps @simplewebauthn/server v13 with this app's storage + identity model:
//   - A passkey user is a self-owned `local:<ulid>` sub (ulid.ts).
//   - Credentials live in webauthn_credentials; ceremony challenges live in
//     webauthn_challenges (0004_webauthn.sql), single-use with a 5-min TTL.
//
// AuthN/authZ split: this module ONLY proves identity (the passkey signature).
// It deliberately does NOT write a member row or burn an invite — the route
// (routes/passkey.ts) runs the shared authZ gate (authorizeOrRedeem) BETWEEN
// verifying the attestation and persisting the credential, so a registration
// that fails the invite check leaves no orphan credential and no member.

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server'
import { randomBytes } from 'node:crypto'
import { serverDb } from './serverDb.js'
import { env } from '../env.js'
import { newLocalSub } from './ulid.js'

const CHALLENGE_TTL_MS = 5 * 60 * 1000

/** A verified-but-not-yet-persisted credential, handed to the route for authZ. */
export interface VerifiedCredential {
  id: string // base64url credential id
  publicKey: Uint8Array
  counter: number
  transports: string[]
  backedUp: boolean
}

interface ChallengeRow {
  challenge_id: string
  challenge: string
  ceremony: 'register' | 'login'
  pending_sub: string | null
  pending_handle: string | null
  expires_at: string
}

interface CredentialRow {
  credential_id: string
  sub: string
  public_key: Buffer
  counter: number
  transports: string | null
  device_label: string | null
  backed_up: number
}

export class WebAuthnVerificationError extends Error {}

// ── challenge store (single-use, TTL-swept) ─────────────────────────────────

function sweepExpiredChallenges(nowIso: string): void {
  serverDb().raw.prepare(`DELETE FROM webauthn_challenges WHERE expires_at < ?`).run(nowIso)
}

function putChallenge(
  ceremony: 'register' | 'login',
  challenge: string,
  pendingSub: string | null,
  pendingHandle: string | null,
): string {
  const now = new Date()
  const nowIso = now.toISOString()
  sweepExpiredChallenges(nowIso)
  const challengeId = randomBytes(16).toString('base64url')
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString()
  serverDb()
    .raw.prepare(
      `INSERT INTO webauthn_challenges
         (challenge_id, challenge, ceremony, pending_sub, pending_handle, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(challengeId, challenge, ceremony, pendingSub, pendingHandle, nowIso, expiresAt)
  return challengeId
}

/** Fetch + delete a challenge atomically (single-use). Returns null if missing
 *  / wrong ceremony / expired. */
function takeChallenge(challengeId: string, ceremony: 'register' | 'login'): ChallengeRow | null {
  const db = serverDb()
  const nowIso = new Date().toISOString()
  const tx = db.raw.transaction((): ChallengeRow | null => {
    const row = db.raw
      .prepare(
        `SELECT challenge_id, challenge, ceremony, pending_sub, pending_handle, expires_at
           FROM webauthn_challenges WHERE challenge_id = ? AND ceremony = ?`,
      )
      .get(challengeId, ceremony) as ChallengeRow | undefined
    if (row) {
      db.raw.prepare(`DELETE FROM webauthn_challenges WHERE challenge_id = ?`).run(challengeId)
    }
    if (!row) return null
    if (row.expires_at < nowIso) return null
    return row
  })
  return tx()
}

// ── registration ────────────────────────────────────────────────────────────

/** Begin a registration ceremony for a NEW self-owned user. Mints a fresh
 *  `local:<ulid>` sub and returns creation options + an opaque challengeId the
 *  client echoes back at verify time. No member/credential is written yet. */
/** Request-derived Relying Party (plan 006 Phase 2): when the backend
 *  serves the SPA same-origin and the operator hasn't pinned
 *  WEBAUTHN_RP_ID, the passkey routes derive the RP from the request's
 *  own (same-host-verified) Origin so a LAN/tailnet self-host works with
 *  zero WebAuthn env. Both ceremony halves derive it the same way, so
 *  begin/verify agree as long as the client talks to one hostname. */
export type RpOverride = { rpId: string; origin: string }

export async function beginRegistration(
  handle: string,
  rp?: RpOverride,
): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }> {
  const sub = newLocalSub()
  const userID = new TextEncoder().encode(sub) // 32 bytes for local:<26> — well under 64
  const options = await generateRegistrationOptions({
    rpName: env.webauthnRpName,
    rpID: rp?.rpId ?? env.webauthnRpId,
    userName: handle,
    userDisplayName: handle,
    userID,
    attestationType: 'none',
    // Discoverable credentials keep login usernameless; user verification is
    // required because possession of an unlocked/shared authenticator alone
    // must not authenticate an owner or administrator.
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  })
  const challengeId = putChallenge('register', options.challenge, sub, handle)
  return { options, challengeId }
}

/** Verify a registration response. Returns the (validated) credential + the
 *  pending sub/handle WITHOUT persisting anything — the caller runs authZ and
 *  then calls persistCredential. Throws on any verification failure. */
export async function verifyRegistration(
  challengeId: string,
  response: RegistrationResponseJSON,
  rp?: RpOverride,
): Promise<{ sub: string; handle: string; credential: VerifiedCredential }> {
  const ch = takeChallenge(challengeId, 'register')
  if (!ch || !ch.pending_sub) throw new WebAuthnVerificationError('challenge_invalid')

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: rp ? [rp.origin] : env.webauthnOrigins,
      expectedRPID: rp?.rpId ?? env.webauthnRpId,
      requireUserVerification: true,
    })
  } catch {
    throw new WebAuthnVerificationError('registration_unverified')
  }
  if (!verification.verified || !verification.registrationInfo) {
    throw new WebAuthnVerificationError('registration_unverified')
  }

  const { credential, credentialBackedUp } = verification.registrationInfo
  return {
    sub: ch.pending_sub,
    handle: ch.pending_handle ?? '',
    credential: {
      id: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports ?? [],
      backedUp: credentialBackedUp,
    },
  }
}

/** Persist a verified credential against its owning sub. Called by the route
 *  only AFTER authZ (invite redemption) has succeeded. */
export function persistCredential(
  sub: string,
  cred: VerifiedCredential,
  deviceLabel: string | null,
): void {
  const nowIso = new Date().toISOString()
  serverDb()
    .raw.prepare(
      `INSERT INTO webauthn_credentials
         (credential_id, sub, public_key, counter, transports, device_label, backed_up, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      cred.id,
      sub,
      Buffer.from(cred.publicKey),
      cred.counter,
      JSON.stringify(cred.transports),
      deviceLabel,
      cred.backedUp ? 1 : 0,
      nowIso,
    )
}

// ── authentication ──────────────────────────────────────────────────────────

/** Begin a usernameless (discoverable-credential) login ceremony. */
export async function beginLogin(rp?: RpOverride): Promise<{
  options: PublicKeyCredentialRequestOptionsJSON
  challengeId: string
}> {
  const options = await generateAuthenticationOptions({
    rpID: rp?.rpId ?? env.webauthnRpId,
    userVerification: 'required',
    allowCredentials: [], // discoverable: the authenticator offers its resident keys
  })
  const challengeId = putChallenge('login', options.challenge, null, null)
  return { options, challengeId }
}

/** Verify a login assertion against the stored credential, bump the signature
 *  counter, and return the authenticated sub. Throws on any failure. */
export async function verifyLogin(
  challengeId: string,
  response: AuthenticationResponseJSON,
  rp?: RpOverride,
): Promise<{ sub: string }> {
  const ch = takeChallenge(challengeId, 'login')
  if (!ch) throw new WebAuthnVerificationError('challenge_invalid')

  const row = serverDb()
    .raw.prepare(
      `SELECT credential_id, sub, public_key, counter, transports, device_label, backed_up
         FROM webauthn_credentials WHERE credential_id = ?`,
    )
    .get(response.id) as CredentialRow | undefined
  if (!row) throw new WebAuthnVerificationError('credential_unknown')

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: rp ? [rp.origin] : env.webauthnOrigins,
      expectedRPID: rp?.rpId ?? env.webauthnRpId,
      requireUserVerification: true,
      credential: {
        id: row.credential_id,
        publicKey: new Uint8Array(row.public_key),
        counter: row.counter,
        transports: row.transports ? (JSON.parse(row.transports) as []) : undefined,
      },
    })
  } catch {
    throw new WebAuthnVerificationError('authentication_unverified')
  }
  if (!verification.verified) {
    throw new WebAuthnVerificationError('authentication_unverified')
  }

  serverDb()
    .raw.prepare(`UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE credential_id = ?`)
    .run(verification.authenticationInfo.newCounter, new Date().toISOString(), row.credential_id)

  return { sub: row.sub }
}

/** True when this install has at least one passkey credential registered.
 *  Used by /api/version so clients can show the passkey login affordance. */
export function hasAnyCredential(): boolean {
  const row = serverDb().raw.prepare(`SELECT 1 FROM webauthn_credentials LIMIT 1`).get()
  return row !== undefined
}
