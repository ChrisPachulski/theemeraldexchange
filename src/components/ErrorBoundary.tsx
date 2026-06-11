import { Component, type ErrorInfo, type ReactNode } from 'react'
import { captureError } from '../lib/telemetry'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
}

/**
 * Top-level React error boundary. Catches render throws and failed lazy chunk
 * loads (App.tsx lazy-loads every non-home tab, and IptvPlayer dynamically
 * import()s hls.js / mpegts.js) so an uncaught error degrades to a recoverable
 * brand fallback instead of white-screening the whole SPA. Every caught error
 * is forwarded to §15 telemetry.
 *
 * The fallback is intentionally dependency-free and uses inline styles so it
 * still renders when app/vendor CSS or JS chunks fail to load.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    captureError(error, { componentStack: info.componentStack })
  }

  private handleReset = (): void => {
    this.setState({ hasError: false })
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children

    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1rem',
          padding: '2rem',
          textAlign: 'center',
          background: '#0a0f0d',
          color: '#e7f5ee',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <h1 style={{ margin: 0, fontSize: '1.5rem', color: '#34d399' }}>
          The Emerald Exchange
        </h1>
        <p style={{ margin: 0, maxWidth: '32rem', lineHeight: 1.5 }}>
          Something went wrong while loading this view. Your session is still
          active; try again, or reload the page.
        </p>
        <div
          style={{
            display: 'flex',
            gap: '0.75rem',
            flexWrap: 'wrap',
            justifyContent: 'center',
          }}
        >
          <button
            type="button"
            onClick={this.handleReset}
            style={{
              padding: '0.55rem 1.1rem',
              borderRadius: '0.5rem',
              border: '1px solid #34d399',
              background: 'transparent',
              color: '#34d399',
              cursor: 'pointer',
              fontSize: '0.95rem',
            }}
          >
            Try again
          </button>
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              padding: '0.55rem 1.1rem',
              borderRadius: '0.5rem',
              border: 'none',
              background: '#34d399',
              color: '#04130c',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.95rem',
            }}
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
