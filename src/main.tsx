import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './lib/queryClient'
import { ConfirmProvider } from './components/confirm/ConfirmProvider'
import { ErrorBoundary } from './components/ErrorBoundary'
import { initTelemetry } from './lib/telemetry'
import { mountAnimatedFavicon } from './lib/animatedFavicon'
import App from './App'
import './index.css'

// §15: bring up crash/error telemetry before the first render so render throws
// and unhandled rejections are captured. No-ops when no Glitchtip DSN is set.
initTelemetry()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)

mountAnimatedFavicon()
