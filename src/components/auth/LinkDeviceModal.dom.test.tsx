// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const claimDeviceLink = vi.fn()
vi.mock('../../lib/api/deviceLink', () => ({ claimDeviceLink: (code: string) => claimDeviceLink(code) }))

import { LinkDeviceModal } from './LinkDeviceModal'

describe('LinkDeviceModal', () => {
  afterEach(cleanup)
  beforeEach(() => {
    claimDeviceLink.mockReset()
    claimDeviceLink.mockResolvedValue({ ok: true, device_name: 'Apple TV', device_platform: 'tvos' })
  })

  it('claims a scanned code without a second tap', async () => {
    render(<LinkDeviceModal initialCode="ABCD2345" autoSubmit onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/Apple TV is signed in as you/)).toBeTruthy())
    expect(claimDeviceLink).toHaveBeenCalledTimes(1)
    expect(claimDeviceLink).toHaveBeenCalledWith('ABCD2345')
  })

  it('waits for the button when the code was typed or is incomplete', () => {
    render(<LinkDeviceModal initialCode="" onClose={() => {}} />)
    render(<LinkDeviceModal initialCode="ABC" autoSubmit onClose={() => {}} />)
    expect(claimDeviceLink).not.toHaveBeenCalled()
  })
})
