import { afterEach, describe, expect, it, vi } from 'vitest'
import { consumeInviteFragment } from './inviteFragment'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function stubWindow(hash: string, state: unknown = { from: 'invite-test' }) {
  const replaceState = vi.fn()
  const localSetItem = vi.fn()
  const sessionSetItem = vi.fn()
  vi.stubGlobal('window', {
    location: {
      hash,
      pathname: '/library/watch',
      search: '?tab=recent&sort=desc',
    },
    history: { state, replaceState },
    localStorage: { setItem: localSetItem },
    sessionStorage: { setItem: sessionSetItem },
  })
  return { replaceState, localSetItem, sessionSetItem, state }
}

describe('consumeInviteFragment', () => {
  it('decodes and scrubs an invite while preserving path, search, and history state', () => {
    const sentinel = 'INVITE secret 123'
    const globals = stubWindow(`#/invite/${encodeURIComponent(sentinel)}`)
    const consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ]

    expect(consumeInviteFragment()).toBe(sentinel)
    expect(globals.replaceState).toHaveBeenCalledOnce()
    expect(globals.replaceState).toHaveBeenCalledWith(
      globals.state,
      '',
      '/library/watch?tab=recent&sort=desc',
    )
    expect(globals.localSetItem).not.toHaveBeenCalled()
    expect(globals.sessionSetItem).not.toHaveBeenCalled()
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled()
  })

  it('scrubs malformed percent encoding without crashing startup', () => {
    const globals = stubWindow('#/invite/%E0%A4%A')
    let invite = ''

    expect(() => {
      invite = consumeInviteFragment()
    }).not.toThrow()
    expect(invite).toBe('%E0%A4%A')
    expect(globals.replaceState).toHaveBeenCalledOnce()
  })

  it('leaves non-invite application hashes untouched', () => {
    const globals = stubWindow('#/movies')

    expect(consumeInviteFragment()).toBe('')
    expect(globals.replaceState).not.toHaveBeenCalled()
  })
})
