// @vitest-environment jsdom
//
// The empty-state copy used to blame "another IPTV app (e.g. on a phone)" for
// an upstream slot we can't see. That cause is a guess: the holder is just as
// often a sibling household member's device or a scheduled DVR recording, and
// telling the user to "close that app or restart the device" sends them after
// something that doesn't exist. Assert the panel no longer names a cause.

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionsWidget } from './ConnectionsWidget'

vi.mock('../../lib/hooks/useIptvSessions', () => ({
  // Nothing opened from this dashboard, yet upstream reports a held slot.
  useIptvSessions: () => ({
    data: { upstream: { activeConnections: 1, maxConnections: 2, status: 'Active' }, ours: [] },
  }),
  useKillIptvSession: () => ({ mutate: () => {}, isPending: false }),
}))

afterEach(cleanup)

describe('ConnectionsWidget empty state', () => {
  it('does not blame another IPTV app for a slot it cannot see', () => {
    render(<ConnectionsWidget />)
    fireEvent.click(screen.getByRole('button', { name: 'Connections' }))

    const empty = screen.getByText(/No sessions opened from this dashboard/i)
    expect(empty).toBeInTheDocument()
    expect(empty).toHaveTextContent(/may be in use elsewhere in your household or by a scheduled recording/i)
    expect(empty).not.toHaveTextContent(/another IPTV app/i)
    expect(empty).not.toHaveTextContent(/restart the device/i)
  })
})
