import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './lib/queryClient'
import { ConfirmProvider } from './components/confirm/ConfirmProvider'
import { ErrorBoundary } from './components/ErrorBoundary'
import { initTelemetryFromServer } from './lib/telemetry'
import { consumeInviteFragment } from './lib/inviteFragment'
import { mountAnimatedFavicon } from './lib/animatedFavicon'
import App from './App'
import './index.css'

// Invite fragments are bearer secrets. Consume them before telemetry or React
// can observe the startup URL, including when the visitor is already signed in.
const initialInviteCode = consumeInviteFragment()

// Injected/build-time telemetry still initialises synchronously inside this
// call; a server-config fetch continues in the background without delaying UI.
void initTelemetryFromServer()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ConfirmProvider>
          <App initialInviteCode={initialInviteCode} />
        </ConfirmProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)

mountAnimatedFavicon()
