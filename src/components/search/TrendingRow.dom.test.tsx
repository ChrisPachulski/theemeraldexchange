// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TrendingRow } from './TrendingRow'

afterEach(cleanup)

describe('TrendingRow suggestion errors', () => {
  it('renders only an exact unauthenticated 401 as an expired session', () => {
    render(
      <TrendingRow
        items={[]}
        onPick={() => {}}
        error={{ status: 401, code: 'unauthenticated' }}
      />,
    )

    expect(screen.getByText('Session expired')).toBeInTheDocument()
    expect(screen.getByText(/signing out and back in/i)).toBeInTheDocument()
  })

  it('does not render an upstream 401 as an expired browser session', () => {
    render(
      <TrendingRow
        items={[]}
        onPick={() => {}}
        error={{
          status: 401,
          code: 'upstream_unauthorized',
          message: 'The upstream credentials were rejected.',
        }}
      />,
    )

    expect(screen.getByText('Couldn’t load suggestions')).toBeInTheDocument()
    expect(screen.getByText(/upstream credentials were rejected/i)).toBeInTheDocument()
    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument()
  })

  it('renders a forbidden 403 as denied access rather than an expired session', () => {
    render(
      <TrendingRow
        items={[]}
        onPick={() => {}}
        error={{ status: 403, code: 'forbidden' }}
      />,
    )

    expect(screen.getByText('Access denied')).toBeInTheDocument()
    expect(screen.getByText(/permission to load these suggestions/i)).toBeInTheDocument()
    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument()
  })
})
