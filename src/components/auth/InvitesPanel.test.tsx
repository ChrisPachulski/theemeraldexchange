import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { InvitesPanel } from './InvitesPanel'

// SSR markup check for the admin allowlist panel. Effects/queries don't
// fire under renderToStaticMarkup, so we assert the static scaffold:
// the create-invite control group and the two list sections are present,
// and no plaintext code is ever rendered in the initial markup.

function render(): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <InvitesPanel />
    </QueryClientProvider>,
  )
}

describe('InvitesPanel', () => {
  it('renders the create-invite control and both list sections', () => {
    const html = render()
    expect(html).toContain('Create invite')
    expect(html).toContain('Outstanding invites')
    expect(html).toContain('Members')
    // Disclosure summary present.
    expect(html).toContain('Invites &amp; members')
  })

  it('does not reveal any code before one is created', () => {
    const html = render()
    expect(html).not.toContain("won't be shown again")
    expect(html).not.toContain('invites-panel__code')
  })
})
