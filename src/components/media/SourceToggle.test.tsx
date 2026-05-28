import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SourceToggle, type SourceMode } from './SourceToggle'

describe('SourceToggle', () => {
  it('renders both tabs', () => {
    render(<SourceToggle mode="local" onChange={() => {}} />)
    expect(screen.getByRole('tab', { name: /available locally/i })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /requestable/i })).toBeTruthy()
  })

  it('aria-selected tracks the mode prop', () => {
    const { rerender } = render(<SourceToggle mode="local" onChange={() => {}} />)
    expect(
      screen.getByRole('tab', { name: /available locally/i }).getAttribute('aria-selected'),
    ).toBe('true')
    expect(
      screen.getByRole('tab', { name: /requestable/i }).getAttribute('aria-selected'),
    ).toBe('false')

    rerender(<SourceToggle mode="requestable" onChange={() => {}} />)
    expect(
      screen.getByRole('tab', { name: /requestable/i }).getAttribute('aria-selected'),
    ).toBe('true')
    expect(
      screen.getByRole('tab', { name: /available locally/i }).getAttribute('aria-selected'),
    ).toBe('false')
  })

  it('clicking the inactive tab calls onChange with the other mode', () => {
    const onChange = vi.fn<(next: SourceMode) => void>()
    render(<SourceToggle mode="local" onChange={onChange} />)

    fireEvent.click(screen.getByRole('tab', { name: /requestable/i }))
    expect(onChange).toHaveBeenCalledWith('requestable')
  })

  it('renders the local count when provided', () => {
    render(<SourceToggle mode="local" onChange={() => {}} localCount={12} />)
    expect(screen.getByText('12')).toBeTruthy()
  })
})
