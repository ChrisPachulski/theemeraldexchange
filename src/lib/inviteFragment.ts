const INVITE_FRAGMENT = /^#\/invite\/([^/?#]+)$/

/** Read the one-use invite handoff, then remove only its URL fragment. */
export function consumeInviteFragment(): string {
  if (typeof window === 'undefined') return ''
  const match = window.location.hash.match(INVITE_FRAGMENT)
  if (!match) return ''

  let inviteCode = match[1]
  try {
    inviteCode = decodeURIComponent(inviteCode)
  } catch {
    // Keep malformed input available for normal invite validation, but never
    // let decoding stop the synchronous URL scrub.
  }

  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${window.location.search}`,
  )
  return inviteCode
}
