import { useEffect, useRef, useState } from 'react'
import { Kraken } from '../atmosphere/Kraken'
import { useAuth } from '../../lib/auth'
import './Walkthrough.css'

// Default unauthenticated landing for theemeraldexchange. Uninvited
// visitors see the showcase first; invited users sign in via the Plex
// CTA in the hero (or the duplicate CTA in the footer for after-scroll
// conversion). The showcase IS the pre-auth experience — there's no
// separate LoginScreen.
//
// Voice follows PRODUCT.md: considered, quiet confidence, no
// marketing exclamations. Long-scroll blog format; each section is
// a frosted card over the kraken atmosphere with one idea per pane.

type Section = {
  id: string
  eyebrow: string
  title: string
  body: string
  detail?: { label: string; value: string }[]
  aside?: string
}

const SECTIONS: Section[] = [
  {
    id: 'philosophy',
    eyebrow: 'Tone',
    title: 'Considered, not loud.',
    body:
      'The Exchange replaces the operator UIs of the *arr stack and SAB with one private surface — a dashboard that could pass for a members’ page rather than a homelab launcher. No tile grids, no marketing chrome, no "trending now" rails competing with what the household already owns. Search is the verb.',
    detail: [
      { label: 'Anti-references', value: 'Sonarr/Radarr add-series chrome, Plex web upsell tiles, Homepage/Homarr tile grids.' },
      { label: 'House style', value: 'Emerald on tinted-neutral, OKLCH palette, Space Grotesk display, frost-on-ink surfaces.' },
    ],
  },
  {
    id: 'atmosphere',
    eyebrow: 'Atmosphere',
    title: 'The kraken keeps the room dark.',
    body:
      'The video behind every word on this page is the home-screen background — a slow, looping current under everything else. Routes don’t remount the video; they cross-fade between a kraken variant and a resting variant in 250ms so the brand is never absent. Frosted surfaces bleed the current through deliberately, never opaquely.',
    aside: 'You’re looking at it.',
  },
  {
    id: 'search',
    eyebrow: 'Search',
    title: 'Find a show. Add it. Done.',
    body:
      'TV and Movies are search-first surfaces, not browse surfaces. Type a title, get a single confident result with poster + year + overview, accept the smart defaults (quality profile, root folder, monitor strategy — inherited from the underlying service’s existing config), and the request lands. No advanced-settings expanders by default. "Severance — added to library." No exclamation.',
    detail: [
      { label: 'Smart defaults', value: 'Pre-populated from Sonarr/Radarr’s own configured profiles — the choosers stay visible but rarely need touching.' },
      { label: 'Recoverable', value: 'Every pause / delete / remove surfaces a confirmation modal. Cancel is default; Enter does not submit.' },
    ],
  },
  {
    id: 'recs',
    eyebrow: 'Discover',
    title: 'Recommendations that read the room.',
    body:
      'Claude (Haiku 4.5) sees the household’s actual library, the explicit rejection list, the user’s liked titles, and the last ∼60 things this user was just shown — and returns picks calibrated to all of it. Genre mix is computed from the library and fed to the model as concrete percentages ("Drama 38%, Crime 22%, …"), so suggestions mirror taste instead of guessing at it.',
    detail: [
      { label: 'Validate-and-retry', value: 'Picks are TMDB-validated for id, title, and year proximity; mismatches feed a single retry loop with explicit per-pick failure reasons.' },
      { label: 'Library-aware fallback', value: 'If picks fall short, fill comes from TMDB /discover sorted by the household’s top genres — not generic "trending this week."' },
      { label: 'Rotation', value: 'A per-user recently-shown buffer is injected as a volatile prompt suffix so refreshes produce meaningfully different picks instead of near-identical lists.' },
    ],
  },
  {
    id: 'live',
    eyebrow: 'Live where it matters',
    title: 'The queue breathes.',
    body:
      'Downloads polls every 3 seconds while the tab is visible — size, ETA, speed, per-season cluster rollups. Everything else is request-driven. When the tab is hidden, polling pauses; when it returns, the next tick is immediate so the user never sees stale state.',
    aside: 'Live state pays its own rent. Static state shouldn’t pretend.',
  },
  {
    id: 'engineering',
    eyebrow: 'Underneath',
    title: 'Engineered like the back end of a SaaS.',
    body:
      'The hot AI path is the showpiece: speculative prefetch of TMDB caches in parallel with the Claude call, single-flight coalescing on every TMDB GET, 30-second library cache so concurrent household members share one Sonarr/Radarr fetch, library-block memoization on a content fingerprint, fully parallel route prologue, and a Server-Timing response header so every phase’s latency renders as a stacked bar in DevTools.',
    detail: [
      { label: 'Prompt caching', value: 'System + library + rejection list ride in the cached prefix (5-minute ephemeral TTL). User likes + recently-shown sit in the volatile suffix so they vary without breaking the cache.' },
      { label: 'Tool-use enforcement', value: 'Claude is forced to call submit_recommendations. Schema lives in the tool definition; output is validated, not parsed.' },
      { label: 'Observability', value: 'Server-Timing on every /api/suggestions response: prologue, claudeInitial, validate1, claudeRetry, validate2, fill, trending.' },
    ],
  },
  {
    id: 'auth',
    eyebrow: 'Getting in',
    title: 'By Plex invitation only.',
    body:
      'Access is gated on the same Plex account that’s been shared the household library — no separate username, no second password to forget. Inside, every household member has their own private likes / dislikes that influence their own discover surface. Dislikes also roll into a household-wide veto so nobody re-sees a title someone else has rejected.',
    aside: 'Same surface for everyone. Capability is gated by confirmation, never hidden modes.',
  },
]

// Sections animate IN on scroll as polish, but they must be visible
// by default — link-unfurl screenshots, no-JS visitors, accessibility
// tooling, and any environment where IntersectionObserver doesn't
// fire promptly must still see the content. JS only adds the entrance
// animation; the absence of JS leaves content fully rendered.
function useReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [animating, setAnimating] = useState(false)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    // If the section is already in view at mount (above-the-fold),
    // skip the animation — it's already visible.
    const rect = node.getBoundingClientRect()
    if (rect.top < window.innerHeight * 0.9) {
      setAnimating(true)
      return
    }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setAnimating(true)
            obs.disconnect()
            return
          }
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.15 },
    )
    obs.observe(node)
    return () => obs.disconnect()
  }, [])
  return { ref, animating }
}

function WalkthroughSection({ section }: { section: Section }) {
  const { ref, animating } = useReveal<HTMLElement>()
  return (
    <section
      ref={ref}
      id={section.id}
      className={`walkthrough__section${animating ? ' walkthrough__section--in' : ''}`}
      aria-labelledby={`${section.id}-title`}
    >
      <div className="walkthrough__card">
        <p className="walkthrough__eyebrow">{section.eyebrow}</p>
        <h2 id={`${section.id}-title`} className="walkthrough__title">
          {section.title}
        </h2>
        <p className="walkthrough__body">{section.body}</p>
        {section.detail && section.detail.length > 0 && (
          <dl className="walkthrough__details">
            {section.detail.map((d) => (
              <div key={d.label} className="walkthrough__detail">
                <dt>{d.label}</dt>
                <dd>{d.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {section.aside && <p className="walkthrough__aside">{section.aside}</p>}
      </div>
    </section>
  )
}

function SignInBlock({ placement }: { placement: 'hero' | 'foot' }) {
  const { signIn, signInState, signInError, discoveredServers } = useAuth()
  const pending = signInState === 'pending' || signInState === 'opening'
  return (
    <div className={`walkthrough__signin walkthrough__signin--${placement}`}>
      <button
        type="button"
        className="walkthrough__signin-button"
        onClick={signIn}
        disabled={pending}
      >
        {pending ? 'Waiting for Plex…' : 'Sign in with Plex'}
      </button>
      <p className="walkthrough__signin-hint">
        Access is by Plex invitation only — sign in with the same Plex
        account that’s been shared the household library.
      </p>
      {signInError && (
        <p className="walkthrough__signin-error" role="alert">{signInError}</p>
      )}
      {discoveredServers && discoveredServers.length > 0 && (
        <div className="walkthrough__discovery">
          <p className="walkthrough__discovery-title">
            First-run setup — set <code>PLEX_SERVER_ID</code> to lock this down:
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

export function Walkthrough() {
  return (
    <>
      <Kraken variant="kraken" />
      <main className="walkthrough" role="main">
        <header className="walkthrough__hero" aria-labelledby="hero-title">
          <div className="walkthrough__card walkthrough__card--hero">
            <p className="walkthrough__eyebrow">The Emerald Exchange</p>
            <h1 id="hero-title" className="walkthrough__hero-title">
              A private members’ page<br />for a household media library.
            </h1>
            <p className="walkthrough__lede">
              One bookmark. Find a show, find a movie, see what’s downloading,
              open Plex. The operator UIs of Sonarr, Radarr, and SAB are not
              promoted, linked, or visible from inside it. If you’re invited,
              sign in below. If you’re not, scroll — the rest of the page is
              a tour.
            </p>
            <SignInBlock placement="hero" />
            <nav className="walkthrough__toc" aria-label="Sections">
              {SECTIONS.map((s) => (
                <a key={s.id} href={`#${s.id}`} className="walkthrough__toc-link">
                  {s.eyebrow}
                </a>
              ))}
            </nav>
          </div>
        </header>
        {SECTIONS.map((s) => (
          <WalkthroughSection key={s.id} section={s} />
        ))}
        <section
          className="walkthrough__section walkthrough__section--in"
          aria-labelledby="signin-foot-title"
        >
          <div className="walkthrough__card">
            <p className="walkthrough__eyebrow">Sign in</p>
            <h2 id="signin-foot-title" className="walkthrough__title">
              Invited? Pick up where you left off.
            </h2>
            <p className="walkthrough__body">
              The Exchange remembers you after the first Plex sign-in.
              No second password, no household-only username.
            </p>
            <SignInBlock placement="foot" />
          </div>
        </section>
        <footer className="walkthrough__foot">
          <p className="walkthrough__foot-line">
            Built by the household, for the household. Source &amp; design notes
            on request.
          </p>
        </footer>
      </main>
    </>
  )
}
