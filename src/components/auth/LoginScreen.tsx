import { useAuth } from '../../lib/auth'
import './LoginScreen.css'

// Sign-in gate. Sits above the entire app when no session cookie is
// present. The kraken atmosphere keeps playing behind it; the screen
// itself is just a centered emerald-tinted card with a single
// "Sign in with Plex" button. Auth happens in a popup; this screen
// reactively flips to the post-auth state when the popup polling
// completes.

export function LoginScreen() {
  const { signIn, signInState, signInError, discoveredServers } = useAuth()
  const pending = signInState === 'pending' || signInState === 'opening'

  return (
    <section className="login" role="dialog" aria-modal="true" aria-labelledby="login-title">
      <div className="login__card">
        <p className="login__eyebrow">Emerald Exchange</p>
        <h1 id="login-title" className="login__title">Sign in</h1>
        <p className="login__copy">
          This dashboard is gated to members of the home Plex server.
          Authenticate with your Plex account to continue.
        </p>

        <button
          type="button"
          className="login__button"
          onClick={signIn}
          disabled={pending}
        >
          {pending ? 'Waiting for Plex…' : 'Sign in with Plex'}
        </button>

        {signInError && (
          <p className="login__error" role="alert">{signInError}</p>
        )}

        {discoveredServers && discoveredServers.length > 0 && (
          <div className="login__discovery">
            <p className="login__discovery-title">
              First-run setup — set <code>PLEX_SERVER_ID</code> to lock this down:
            </p>
            <ul className="login__discovery-list">
              {discoveredServers.map((s) => (
                <li key={s.id}>
                  <span className="login__discovery-name">{s.name}</span>
                  {s.owned && <span className="login__discovery-tag">owned</span>}
                  <code className="login__discovery-id">{s.id}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}
