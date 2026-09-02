// Maps a server 403 `reason` from either login path to human copy.
// The new parallel model rejects a valid identity that presents no
// redeemed invite with `no_invite`; the legacy Plex path used
// `not_a_server_member`. Both mean "your identity is fine, but you're
// not on the allowlist."
export function deniedMessage(reason: unknown): string {
  switch (reason) {
    case 'no_invite':
    case 'not_authorized':
      return 'Invitation-only. Ask the owner for an invite code, then sign in again.'
    case 'access_revoked':
      return 'Your access to this library has been revoked. Ask the owner to restore it.'
    case 'workos_state_invalid':
      return 'That sign-in link expired. Start the WorkOS sign-in again.'
    case 'workos_code_invalid':
      return 'WorkOS rejected the sign-in. Try again.'
    case 'workos_unavailable':
      return 'WorkOS is unreachable right now. Try again in a moment.'
    case 'not_a_server_member':
      return "You aren't a member of this Plex server."
    default:
      return 'Access denied.'
  }
}

const INVITE_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/
const INVALID_INVITE_CODE_MESSAGE =
  'Invite codes are 22 characters. Paste the complete code.'

/** Empty is valid for returning members; a supplied invite must be complete. */
export function inviteCodeError(code?: string): string | null {
  const value = code?.trim()
  return !value || INVITE_CODE_PATTERN.test(value) ? null : INVALID_INVITE_CODE_MESSAGE
}
