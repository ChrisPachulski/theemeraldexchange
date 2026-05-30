import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appleClientId, isAppleSignInConfigured, makeNonce } from './appleSdk'

// appleSdk wraps Apple's JS SDK + build-time config. The env-reading and
// nonce helpers are pure; loadAppleSdk/runAppleSignIn touch a (faked) DOM
// and a (faked) window.AppleID global.

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('appleClientId / isAppleSignInConfigured', () => {
  it('returns null when VITE_APPLE_CLIENT_ID is unset', () => {
    vi.stubEnv('VITE_APPLE_CLIENT_ID', '')
    expect(appleClientId()).toBeNull()
    expect(isAppleSignInConfigured()).toBe(false)
  })
  it('returns the configured Services ID when set', () => {
    vi.stubEnv('VITE_APPLE_CLIENT_ID', 'com.theemeraldexchange.web')
    expect(appleClientId()).toBe('com.theemeraldexchange.web')
    expect(isAppleSignInConfigured()).toBe(true)
  })
})

describe('makeNonce', () => {
  it('produces a 32-char lowercase hex string (16 random bytes)', () => {
    const n = makeNonce()
    expect(n).toMatch(/^[0-9a-f]{32}$/)
  })
  it('produces distinct values across calls', () => {
    expect(makeNonce()).not.toBe(makeNonce())
  })
})

// ── DOM-touching helpers ──────────────────────────────────────────

type FakeScript = {
  src: string
  async: boolean
  listeners: Record<string, Array<() => void>>
  addEventListener: (type: string, cb: () => void) => void
  fire: (type: string) => void
}

function makeFakeScript(): FakeScript {
  return {
    src: '',
    async: false,
    listeners: {},
    addEventListener(type, cb) {
      ;(this.listeners[type] ??= []).push(cb)
    },
    fire(type) {
      for (const cb of this.listeners[type] ?? []) cb()
    },
  }
}

function installFakeDom(opts: {
  appleId?: unknown
  onScriptCreated?: (s: FakeScript) => void
}) {
  const created: FakeScript[] = []
  const win: Record<string, unknown> = {
    location: { origin: 'https://app.test' },
    AppleID: opts.appleId,
    setTimeout: (fn: () => void, _ms?: number) => {
      // Never auto-fire the timeout in tests; return a token.
      void fn
      return 1 as unknown
    },
  }
  const doc = {
    querySelector: () => null,
    createElement: () => {
      const s = makeFakeScript()
      created.push(s)
      opts.onScriptCreated?.(s)
      return s
    },
    head: { appendChild: () => {} },
  }
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', doc)
  return { created, win }
}

describe('loadAppleSdk', () => {
  beforeEach(() => {
    // Each test gets a fresh module instance so the internal sdkLoad
    // memo doesn't leak between cases.
    vi.resetModules()
  })

  it('resolves immediately when window.AppleID is already present', async () => {
    installFakeDom({ appleId: { auth: {} } })
    const mod = await import('./appleSdk')
    await expect(mod.loadAppleSdk()).resolves.toBeUndefined()
  })

  it('injects a script and resolves once it loads and installs the global', async () => {
    let script: FakeScript | null = null
    const dom = installFakeDom({
      onScriptCreated: (s) => {
        script = s
      },
    })
    const mod = await import('./appleSdk')
    const p = mod.loadAppleSdk()
    // The SDK installs the global, then the load event fires.
    dom.win.AppleID = { auth: {} }
    expect(script).not.toBeNull()
    script!.fire('load')
    await expect(p).resolves.toBeUndefined()
  })

  it('rejects when the script load errors', async () => {
    let script: FakeScript | null = null
    installFakeDom({
      onScriptCreated: (s) => {
        script = s
      },
    })
    const mod = await import('./appleSdk')
    const p = mod.loadAppleSdk()
    script!.fire('error')
    await expect(p).rejects.toThrow(/apple_sdk_load_error/)
  })
})

describe('runAppleSignIn', () => {
  beforeEach(() => vi.resetModules())

  it('throws apple_not_configured when no client id is set', async () => {
    vi.stubEnv('VITE_APPLE_CLIENT_ID', '')
    installFakeDom({ appleId: { auth: {} } })
    const mod = await import('./appleSdk')
    await expect(mod.runAppleSignIn()).rejects.toThrow(/apple_not_configured/)
  })

  it('inits the SDK and returns the identity token + nonce on success', async () => {
    vi.stubEnv('VITE_APPLE_CLIENT_ID', 'com.x.web')
    const init = vi.fn()
    const signIn = vi.fn(async () => ({
      authorization: { id_token: 'eyJ.JWT.sig', code: 'c' },
    }))
    installFakeDom({ appleId: { auth: { init, signIn } } })
    const mod = await import('./appleSdk')
    const out = await mod.runAppleSignIn()
    expect(out.identityToken).toBe('eyJ.JWT.sig')
    expect(out.nonce).toMatch(/^[0-9a-f]{32}$/)
    // The same nonce we generated is passed to Apple's init.
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'com.x.web', nonce: out.nonce, usePopup: true }),
    )
    expect(signIn).toHaveBeenCalledOnce()
  })

  it('throws when Apple returns no identity token', async () => {
    vi.stubEnv('VITE_APPLE_CLIENT_ID', 'com.x.web')
    installFakeDom({
      appleId: { auth: { init: vi.fn(), signIn: vi.fn(async () => ({ authorization: {} })) } },
    })
    const mod = await import('./appleSdk')
    await expect(mod.runAppleSignIn()).rejects.toThrow(/apple_no_identity_token/)
  })
})
