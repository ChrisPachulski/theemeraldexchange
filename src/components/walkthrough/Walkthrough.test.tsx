import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Walkthrough } from './Walkthrough'
import { AuthProvider } from '../../lib/auth'

// SSR markup checks for the public login page. The parallel-auth model
// adds an invite-code field and a Sign in with Apple affordance alongside
// the existing Plex button — without breaking the WebGL brand mark.

function render(): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <Walkthrough />
      </AuthProvider>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Walkthrough sign-in', () => {
  it('keeps the Plex button and adds the invite-code field', () => {
    vi.stubEnv('VITE_APPLE_CLIENT_ID', '')
    const html = render()
    expect(html).toContain('Sign in with Plex')
    expect(html).toContain('Invite code')
    // Plex-only deploy (no Apple client id) shows no Apple control.
    expect(html).not.toContain('Sign in with Apple')
  })

  it('renders the Apple button alongside Plex when Apple is configured', () => {
    vi.stubEnv('VITE_APPLE_CLIENT_ID', 'com.theemeraldexchange.web')
    const html = render()
    expect(html).toContain('Sign in with Plex')
    expect(html).toContain('Sign in with Apple')
  })

  it('does not break the WebGL brand mark (canvas still present)', () => {
    vi.stubEnv('VITE_APPLE_CLIENT_ID', 'com.theemeraldexchange.web')
    const html = render()
    // EmeraldMark renders a <canvas>; the hero gem mounts it.
    expect(html).toContain('<canvas')
    expect(html).toContain('walkthrough__hero-gem')
  })
})
