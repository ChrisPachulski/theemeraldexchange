import { useEffect, useRef, useState } from 'react'
import { Kraken } from '../atmosphere/Kraken'
import { EmeraldMark } from '../atmosphere/EmeraldMark'
import { TrendingRow } from '../search/TrendingRow'
import type { TrendingItem } from '../../lib/hooks/useTrending'
import type { DotState } from '../search/FeedbackDots'
import { inviteCodeError, useAuth } from '../../lib/auth'
import { AppleSignInButton } from '../auth/AppleSignInButton'
import { PasskeyButtons } from '../auth/PasskeyButtons'
import './Walkthrough.css'

// Default unauthenticated landing for theemeraldexchange. The
// walkthrough is the tour: real video assets, real components, mock
// data. Copy is captions, not paragraphs — the page IS the demo.

// Curated mock strip — real TMDB ids and poster paths pulled from the
// public CDN so the demo looks like the live strip without burning a
// TMDB key. Ordering matches what a Drama-leaning household would
// actually see surface.
const DEMO_STRIP: TrendingItem[] = [
  { id: 95396, title: 'Severance', posterPath: '/lFf6LLrQjYldcZItzOkGmMMigP7.jpg', year: 2022 },
  { id: 84958, title: 'Loki', posterPath: '/voHUmluYmKyleFkTu3lOXQG702u.jpg', year: 2021 },
  { id: 71912, title: 'The Witcher', posterPath: '/cZ0d3rtvXPVvuiX22sP79K3Hmjz.jpg', year: 2019 },
  { id: 1399, title: 'Game of Thrones', posterPath: '/1XS1oqL89opfnbLl8WnZY1O1uJx.jpg', year: 2011 },
  { id: 60625, title: 'Rick and Morty', posterPath: '/gdIrmf2DdY5mgN6ycVP0XlzKzbE.jpg', year: 2013 },
  { id: 60059, title: 'Better Call Saul', posterPath: '/fC2HDm5t0kHl7mTm7jxMR31b7by.jpg', year: 2015 },
  { id: 94605, title: 'Arcane', posterPath: '/abf8tHznhSvl9BAElD2cQeRr7do.jpg', year: 2021 },
  { id: 76479, title: 'The Boys', posterPath: '/2zmTngn1tYC1AvfnrFLhxeD82hz.jpg', year: 2019 },
]

// First-owner claim (plan 006 Phase 1): shown INSTEAD of the normal sign-in
// while the server is unclaimed. The setup token comes from the server's
// boot log (also ${data}/.setup-token) — possession of the box's logs is
// the proof of ownership. Claiming registers a passkey as role 'admin' and
// permanently closes the open first-run window.
function ClaimBlock({ placement }: { placement: 'hero' | 'foot' }) {
  const { passkeyRegister, signInState, signInError } = useAuth()
  const [handle, setHandle] = useState('')
  const [token, setToken] = useState('')
  const pending = signInState === 'pending' || signInState === 'opening'
  const nameId = `walkthrough-claim-name-${placement}`
  const tokenId = `walkthrough-claim-token-${placement}`
  // WebAuthn needs a secure context: https, or the localhost exception. On
  // plain http over a LAN IP the passkey ceremony is refused by the BROWSER
  // before the server ever sees it — show the fix instead of a doomed form.
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return (
      <div className={`walkthrough__signin walkthrough__signin--${placement}`}>
        <p className="walkthrough__eyebrow">Claim this server</p>
        <p className="walkthrough__signin-hint" role="alert">
          Passkeys need a secure page and this one isn&apos;t
          (http over the network). Open the app as{' '}
          <code>http://localhost:3001</code> on the server itself (or an SSH
          tunnel: <code>ssh -L 3001:localhost:3001 &lt;server&gt;</code>), or
          use an https address (e.g. Tailscale Serve), then claim from there.
        </p>
      </div>
    )
  }
  return (
    <div className={`walkthrough__signin walkthrough__signin--${placement}`}>
      <p className="walkthrough__eyebrow">Claim this server</p>
      <p className="walkthrough__signin-hint">
        This server hasn&apos;t been claimed yet. Paste the one-time setup token
        from the server&apos;s startup log to become its owner — you&apos;ll sign in
        with a passkey (Face ID, Touch ID, Windows Hello, or a security key).
      </p>
      <div className="walkthrough__invite">
        <label className="walkthrough__invite-label" htmlFor={nameId}>
          Your name
        </label>
        <input
          id={nameId}
          className="walkthrough__invite-input"
          type="text"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="e.g. Chris"
          autoComplete="name"
          spellCheck={false}
          disabled={pending}
        />
        <label className="walkthrough__invite-label" htmlFor={tokenId}>
          Setup token
        </label>
        <input
          id={tokenId}
          className="walkthrough__invite-input"
          type="text"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste the token from the server log"
          autoComplete="one-time-code"
          spellCheck={false}
          disabled={pending}
        />
      </div>
      <div className="walkthrough__signin-buttons">
        <button
          type="button"
          className="walkthrough__signin-button"
          onClick={() =>
            void passkeyRegister({ handle: handle.trim(), setupToken: token.trim() })
          }
          disabled={pending || handle.trim().length === 0 || token.trim().length === 0}
        >
          {pending ? 'Claiming…' : 'Claim server & create passkey'}
        </button>
      </div>
      {signInError && (
        <p className="walkthrough__signin-error" role="alert">{signInError}</p>
      )}
    </div>
  )
}

function SignInBlock({
  placement,
  initialInviteCode,
}: {
  placement: 'hero' | 'foot'
  initialInviteCode: string
}) {
  const { signIn, signInState, signInError, discoveredServers, authMethods, setupClaimable } =
    useAuth()
  const [inviteCode, setInviteCode] = useState(initialInviteCode)
  const pending = signInState === 'pending' || signInState === 'opening'
  const code = inviteCode.trim()
  const codeError = inviteCodeError(code)
  // A unique id per placement so the two SignInBlock instances on the
  // page don't share an htmlFor target.
  const inviteFieldId = `walkthrough-invite-${placement}`
  const inviteErrorId = `${inviteFieldId}-error`

  // Unclaimed server → the claim flow replaces sign-in entirely (there is
  // nobody to sign in AS until an owner exists).
  if (setupClaimable) return <ClaimBlock placement={placement} />

  // Only offer the providers this install actually configured (plan 006
  // Phase 1). null = methods not fetched yet → show everything rather than
  // hiding the way in behind a slow request.
  const showPlex = !authMethods || authMethods.plex
  const showApple = !authMethods || authMethods.apple
  return (
    <div className={`walkthrough__signin walkthrough__signin--${placement}`}>
      <div className="walkthrough__invite">
        <label className="walkthrough__invite-label" htmlFor={inviteFieldId}>
          Invite code <span className="walkthrough__invite-optional">(first time only)</span>
        </label>
        <input
          id={inviteFieldId}
          className="walkthrough__invite-input"
          type="text"
          value={inviteCode}
          onChange={(e) => setInviteCode(e.target.value)}
          placeholder="Paste the code the owner sent you"
          autoComplete="one-time-code"
          autoCapitalize="none"
          spellCheck={false}
          disabled={pending}
          aria-invalid={codeError ? true : undefined}
          aria-describedby={codeError ? inviteErrorId : undefined}
        />
        {codeError && (
          <p id={inviteErrorId} className="walkthrough__signin-error" role="alert">
            {codeError}
          </p>
        )}
      </div>
      <fieldset
        className="walkthrough__signin-buttons"
        disabled={pending || Boolean(codeError)}
      >
        {showPlex && (
          <button
            type="button"
            className="walkthrough__signin-button"
            onClick={() => void signIn(code || undefined)}
            disabled={pending}
          >
            {pending ? 'Waiting for Plex…' : 'Sign in with Plex'}
          </button>
        )}
        {showApple && <AppleSignInButton inviteCode={code || undefined} />}
        <PasskeyButtons inviteCode={code || undefined} />
      </fieldset>
      <p className="walkthrough__signin-hint">
        Invitation-only. Returning members can sign in with a passkey
        {showApple ? ', Apple' : ''}
        {showPlex ? ', or the Plex account the library was shared to' : ''}; no
        code needed. First-time guests: paste your invite code above, then set
        up a passkey{showPlex || showApple ? ' or sign in with the other providers' : ''}.
      </p>
      {signInError && (
        <p className="walkthrough__signin-error" role="alert">{signInError}</p>
      )}
      {discoveredServers && discoveredServers.length > 0 && (
        <div className="walkthrough__discovery">
          <p className="walkthrough__discovery-title">
            First-run setup. Set <code>PLEX_SERVER_ID</code> to lock this down:
          </p>
          <ul className="walkthrough__discovery-list">
            {discoveredServers.map((s) => (
              <li key={s.id}>
                <span className="walkthrough__discovery-name">{s.name}</span>
                {s.owned && <span className="walkthrough__discovery-tag">owned</span>}
                <code className="walkthrough__discovery-id">{s.id}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// The nav-transition splice. Click to play; play again button after
// it finishes. The same MP4 the real app uses at /nav-transition.mp4.
function TransitionDemo() {
  const ref = useRef<HTMLVideoElement>(null)
  const [state, setState] = useState<'idle' | 'playing' | 'done'>('idle')
  const play = () => {
    const v = ref.current
    if (!v) return
    v.currentTime = 0
    setState('playing')
    v.play().catch(() => setState('done'))
  }
  return (
    <div className="walkthrough__demo walkthrough__demo--transition">
      <button
        type="button"
        className={`walkthrough__transition-stage walkthrough__transition-stage--${state}`}
        onClick={play}
        aria-label={state === 'idle' ? 'Play the nav transition' : 'Replay the nav transition'}
      >
        <video
          ref={ref}
          className="walkthrough__transition-video"
          playsInline
          muted
          preload="auto"
          onEnded={() => setState('done')}
          onError={() => setState('done')}
        >
          <source src="/nav-transition.mp4" type="video/mp4" />
        </video>
        {state !== 'playing' && (
          <span className="walkthrough__transition-cta">
            {state === 'idle' ? '▶  Play' : '↻  Replay'}
          </span>
        )}
      </button>
    </div>
  )
}

// Two atmospheres side by side. Each panel mounts the actual video
// asset — the same ones the live app plays as the fixed background.
function AtmospherePair() {
  return (
    <div className="walkthrough__demo walkthrough__demo--pair">
      <figure className="walkthrough__atmos-panel">
        <video
          className="walkthrough__atmos-video walkthrough__atmos-video--kraken"
          loop
          muted
          playsInline
          autoPlay
          preload="auto"
          poster="/kraken-poster.jpg"
        >
          <source src="/kraken.webm" type="video/webm" />
          <source src="/kraken.mp4" type="video/mp4" />
        </video>
        <figcaption className="walkthrough__atmos-caption">
          <span className="walkthrough__eyebrow">Home</span>
          <span>kraken (graded toward emerald)</span>
        </figcaption>
      </figure>
      <figure className="walkthrough__atmos-panel">
        <video
          className="walkthrough__atmos-video walkthrough__atmos-video--resting"
          loop
          muted
          playsInline
          autoPlay
          preload="auto"
        >
          <source src="/resting.webm" type="video/webm" />
          <source src="/resting.mp4" type="video/mp4" />
        </video>
        <figcaption className="walkthrough__atmos-caption">
          <span className="walkthrough__eyebrow">Anywhere else</span>
          <span>resting (emerald grade baked in)</span>
        </figcaption>
      </figure>
    </div>
  )
}

// Live TrendingRow with mock data. Dots + AI toggle are local state
// so visitors can click around without an account.
function StripDemo() {
  const [feedback, setFeedback] = useState<Map<number, DotState>>(new Map())
  const [aiEnabled, setAiEnabled] = useState(true)
  const stateFor = (id: number): DotState => feedback.get(id) ?? 'unset'
  const apply = (id: number, next: DotState) => {
    setFeedback((m) => {
      const n = new Map(m)
      const cur = n.get(id) ?? 'unset'
      if (cur === next) n.delete(id)
      else n.set(id, next)
      return n
    })
  }
  return (
    <div className="walkthrough__demo walkthrough__demo--strip">
      <TrendingRow
        items={DEMO_STRIP}
        loading={false}
        onPick={() => {}}
        label={aiEnabled ? 'Picked for you' : 'Trending this week'}
        feedback={{
          stateFor,
          onLike: (id) => apply(id, 'liked'),
          onDislike: (id) => apply(id, 'disliked'),
        }}
        mode={{
          value: aiEnabled ? 'recommended' : 'trending',
          onChange: (m) => setAiEnabled(m === 'recommended'),
        }}
      />
    </div>
  )
}

// The brand gem on its own. Lives in a stage so the rotating silhouette
// has room to breathe — in the real app it's the tiny glyph next to
// "Watch" and the favicon; here it's centerpiece, same 3D scene scaled up.
function BeaconStage() {
  return (
    <div className="walkthrough__demo walkthrough__demo--beacon">
      <EmeraldMark width={360} variant="single" />
    </div>
  )
}

// IntersectionObserver mostly to autoplay the transition demo when it
// scrolls into view — not used for hide/reveal.
function useInView<T extends HTMLElement>(onEnter: () => void) {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            onEnter()
            obs.disconnect()
            return
          }
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.4 },
    )
    obs.observe(node)
    return () => obs.disconnect()
  }, [onEnter])
  return ref
}

type Section = {
  id: string
  eyebrow: string
  title: string
  caption: string
  render: () => React.ReactElement
}

export function Walkthrough() {
  const stripRef = useInView<HTMLElement>(() => {})
  const [initialInviteCode] = useState(() => {
    if (typeof window === 'undefined') return ''
    const match = window.location.hash.match(/^#\/invite\/([^/?#]+)$/)
    if (!match) return ''
    try {
      return decodeURIComponent(match[1])
    } catch {
      return match[1]
    }
  })

  // The invite lives in the fragment so it is never sent in the initial HTTP
  // request or Referer header. Remove it after reading so it does not linger in
  // browser history or get copied accidentally from the address bar.
  useEffect(() => {
    if (!initialInviteCode || typeof window === 'undefined') return
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  }, [initialInviteCode])

  const sections: Section[] = [
    {
      id: 'transition',
      eyebrow: 'First nav',
      title: 'The splice plays once, then gets out of the way.',
      caption: 'Every browser sees this once on its first nav. Tap the stage to play it now.',
      render: () => <TransitionDemo />,
    },
    {
      id: 'atmosphere',
      eyebrow: 'Atmosphere',
      title: 'Two layers. 250ms cross-fade. The brand is never absent.',
      caption: 'The kraken is the home layer. Every other route fades to resting and back.',
      render: () => <AtmospherePair />,
    },
    {
      id: 'strip',
      eyebrow: 'Discover',
      title: 'Click the dots. Toggle the AI. It’s the real strip.',
      caption: 'Mock posters, real component. Red hides the title forever; green tells the model.',
      render: () => <StripDemo />,
    },
    {
      id: 'beacon',
      eyebrow: 'The gem',
      title: 'A rotating brilliant cut pinned to the HUD.',
      caption: 'The same WebGL gem you see in the corner glyph and the favicon; same shader, same scene, scaled up.',
      render: () => <BeaconStage />,
    },
  ]

  return (
    <>
      <Kraken variant="kraken" />
      <main className="walkthrough" role="main">
        <header className="walkthrough__hero" aria-labelledby="hero-title">
          {/* Brand gem sits on the bottom-right rock spire so the
              emerald reads as treasure-on-stone instead of floating
              midair over the kraken's face. Aria-hidden because the
              eyebrow already carries the brand name for screen readers. */}
          <div className="walkthrough__hero-gem" aria-hidden="true">
            <EmeraldMark width={84} variant="single" className="walkthrough__brand-mark" />
          </div>
          <div className="walkthrough__hero-card">
            <p className="walkthrough__eyebrow">The Emerald Exchange</p>
            <h1 id="hero-title" className="walkthrough__hero-title">
              A private members’ page<br />for a household media library.
            </h1>
            <SignInBlock placement="hero" initialInviteCode={initialInviteCode} />
            <p className="walkthrough__hero-scroll">↓ scroll for the tour</p>
          </div>
        </header>
        {sections.map((s) => (
          <section
            key={s.id}
            id={s.id}
            className="walkthrough__section"
            aria-labelledby={`${s.id}-title`}
            ref={s.id === 'strip' ? stripRef : undefined}
          >
            <header className="walkthrough__section-head">
              <p className="walkthrough__eyebrow">{s.eyebrow}</p>
              <h2 id={`${s.id}-title`} className="walkthrough__title">{s.title}</h2>
              <p className="walkthrough__caption">{s.caption}</p>
            </header>
            {s.render()}
          </section>
        ))}
        <section
          className="walkthrough__section"
          aria-labelledby="signin-foot-title"
        >
          <div className="walkthrough__card">
            <p className="walkthrough__eyebrow">Sign in</p>
            <h2 id="signin-foot-title" className="walkthrough__title">
              Invited? Pick up where you left off.
            </h2>
            <SignInBlock placement="foot" initialInviteCode={initialInviteCode} />
          </div>
        </section>
        <footer className="walkthrough__foot">
          <p className="walkthrough__foot-line">
            Built by the household, for the household.
          </p>
        </footer>
      </main>
    </>
  )
}
