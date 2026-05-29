import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppleSignInButton } from './AppleSignInButton'
import { AuthProvider } from '../../lib/auth'

// SSR render check: the button only exists when Apple sign-in is
// configured for the build (VITE_APPLE_CLIENT_ID). A Plex-only deploy
// must render nothing so there's no dead control on the login page.
// renderToStaticMarkup doesn't fire effects, so AuthProvider's session
// probe never calls fetch — this is a pure markup assertion.

function render(node: React.ReactElement): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AuthProvider>{node}</AuthProvider>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('AppleSignInButton', () => {
  it('renders nothing when Apple sign-in is not configured', () => {
    vi.stubEnv('VITE_APPLE_CLIENT_ID', '')
    const html = render(<AppleSignInButton />)
    expect(html).not.toContain('Sign in with Apple')
  })

  it('renders the Apple button when configured', () => {
    vi.stubEnv('VITE_APPLE_CLIENT_ID', 'com.theemeraldexchange.web')
    const html = render(<AppleSignInButton inviteCode="ABCD" />)
    expect(html).toContain('Sign in with Apple')
    expect(html).toContain('apple-signin__button')
    // The Apple mark is present and aria-hidden for SR users.
    expect(html).toContain('<svg')
  })
})
