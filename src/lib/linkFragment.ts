// `#/link/CODE` is the URL a TV/phone shows while pairing without Plex. The
// code must survive the WorkOS/Google/Apple redirect round-trip (the provider
// sends the browser back to `/`), so it is parked in sessionStorage and the
// fragment scrubbed, mirroring inviteFragment.

const LINK_FRAGMENT = /^#\/link(?:\/([A-Za-z0-9-]*))?$/
export const PENDING_LINK_KEY = 'eex.pendingLinkCode'

/** Capture a `#/link[/CODE]` landing into sessionStorage; returns true if one was present. */
export function consumeLinkFragment(): boolean {
  if (typeof window === 'undefined') return false
  const match = window.location.hash.match(LINK_FRAGMENT)
  if (!match) return false
  try {
    window.sessionStorage.setItem(PENDING_LINK_KEY, (match[1] ?? '').toUpperCase())
  } catch {
    // Storage blocked: the modal still opens (empty code) once the app renders.
  }
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`)
  return true
}

export function readPendingLinkCode(): string | null {
  try {
    return window.sessionStorage.getItem(PENDING_LINK_KEY)
  } catch {
    return null
  }
}

export function clearPendingLinkCode(): void {
  try {
    window.sessionStorage.removeItem(PENDING_LINK_KEY)
  } catch {
    // ignore
  }
}
