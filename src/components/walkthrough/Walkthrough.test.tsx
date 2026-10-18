import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Walkthrough } from './Walkthrough'
import { AuthProvider } from '../../lib/auth'

// SSR markup checks for the public login page: the invite-code field and the
// Sign in with Apple affordance, without breaking the WebGL brand mark.

function render(initialInviteCode = ''): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <Walkthrough initialInviteCode={initialInviteCode} />
      </AuthProvider>
    </QueryClientProvider>,
  )
}

// The demo strip's posters resolve through apiUrl, which reads the origin.
beforeEach(() => {
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('Walkthrough sign-in', () => {
  it('shows the invite-code field and no Apple control without an Apple client id', () => {
    vi.stubEnv('VITE_APPLE_CLIENT_ID', '')
    const html = render()
    expect(html).toContain('Invite code')
    expect(html).not.toContain('Sign in with Apple')
    expect(html).not.toMatch(/sign in with plex/i)
  })

  it('renders the Apple button when Apple is configured', () => {
    vi.stubEnv('VITE_APPLE_CLIENT_ID', 'com.theemeraldexchange.web')
    const html = render()
    expect(html).toContain('Sign in with Apple')
  })

  it('does not break the WebGL brand mark (canvas still present)', () => {
    vi.stubEnv('VITE_APPLE_CLIENT_ID', 'com.theemeraldexchange.web')
    const html = render()
    // EmeraldMark renders a <canvas>; the hero gem mounts it.
    expect(html).toContain('<canvas')
    expect(html).toContain('walkthrough__hero-gem')
  })

  it('prefills an invite handed off from the scrubbed URL fragment', () => {
    const code = 'A'.repeat(22)

    const html = render(code)

    expect(html).toContain(`value="${code}"`)
  })
})
