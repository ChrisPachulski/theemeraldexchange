// Public auth surface. Everything the app imports from `lib/auth` lands here,
// so the split below (context/provider, session reconcile, per-provider
// flows, admin allowlist API) stays an internal concern.
export { AuthProvider, useAuth } from './AuthProvider'
export { deniedMessage, inviteCodeError } from './messages'
export {
  authModeFromUser,
  type ActiveSignIn,
  type AuthMode,
  type AuthUser,
  type Role,
  type SessionState,
} from './types'
export {
  createInvite,
  listInvites,
  listMembers,
  revokeInvite,
  revokeMember,
  type CreatedInvite,
  type InviteStatus,
  type InviteView,
  type MemberView,
} from './admin'
