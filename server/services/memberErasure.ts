// server/services/memberErasure.ts — per-member state purge behind self-service
// account deletion (DELETE /api/account/self, routes/account.ts).
//
// Runs AFTER the members row is revoked (the authoritative authZ gate), so every
// step here is post-commit convergence: a step that fails is reported to the
// caller for logging and never thrown. A 500 at this point would make the app
// believe the account still exists when the member can no longer sign in.

import { serverDb } from './serverDb.js'
import { iptvDb } from './iptvDbSingleton.js'
import { cascadeRevokeForSub } from './reconcileDeviceToken.js'
import { deleteUserApiKey } from './userApiKeys.js'
import { removePolicy } from './userPolicies.js'
import { clearUserFeedback } from './userFeedback.js'
import { clearUserWatchlist } from './userWatchlist.js'

export type ErasureStep =
  | 'device_tokens'
  | 'playlist_tokens'
  | 'iptv_favorites'
  | 'iptv_watch_history'
  | 'api_key'
  | 'passkeys'
  | 'policy'
  | 'feedback'
  | 'watchlist'
  | 'media_watch_state'

export type ErasureFailure = { step: ErasureStep; error: unknown }

export type ErasureHooks = {
  /** Purge the member's media-core watch state; absent when the media proxy is
   *  not mounted (USE_MEDIA_CORE unset). */
  eraseMediaWatchState?: (sub: string) => Promise<void>
}

/** Clear everything the server holds for `sub` besides the (kept, revoked)
 *  members row and the device-token audit rows. Returns the steps that failed. */
export async function eraseMemberState(sub: string, hooks: ErasureHooks = {}): Promise<ErasureFailure[]> {
  const failures: ErasureFailure[] = []
  const attempt = async (step: ErasureStep, run: () => void | Promise<void>): Promise<void> => {
    try {
      await run()
    } catch (error) {
      failures.push({ step, error })
    }
  }

  await attempt('device_tokens', () => {
    cascadeRevokeForSub(sub, 'account_deleted')
  })
  await attempt('playlist_tokens', () => {
    iptvDb().stmts.revokePlaylistTokensBySub.run(new Date().toISOString(), sub)
  })
  await attempt('iptv_favorites', () => {
    iptvDb().stmts.deleteFavoritesBySub.run(sub)
  })
  await attempt('iptv_watch_history', () => {
    iptvDb().stmts.deleteHistoryBySub.run(sub)
  })
  await attempt('api_key', () => {
    deleteUserApiKey(sub)
  })
  await attempt('passkeys', () => {
    serverDb().raw.prepare(`DELETE FROM webauthn_credentials WHERE sub = ?`).run(sub)
  })
  await attempt('policy', () => removePolicy(sub))
  await attempt('feedback', () => clearUserFeedback(sub))
  await attempt('watchlist', () => clearUserWatchlist(sub))
  if (hooks.eraseMediaWatchState) {
    const erase = hooks.eraseMediaWatchState
    await attempt('media_watch_state', () => erase(sub))
  }
  return failures
}
