import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useRoute, type Route } from './router'
import './navTransition.css'

// One-shot nav transition + on-demand replay.
//
// The first time a visitor selects any nav button (top tabs or home
// buttons) on a fresh browser, a fullscreen splice from
// public/nav-transition.mp4 plays before navigating. After that, the
// "played" flag is persisted in localStorage and further navigation is
// instant. The brand "Emerald Exchange" button always navigates instantly
// — the flourish belongs to entering a section, not returning home.
//
// A Replay control (rendered separately, see ReplayButton.tsx) calls
// replay() to play the clip again without changing route.

const STORAGE_KEY = 'eex.navTransition.played'

function hasPlayed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function markPlayed() {
  try {
    localStorage.setItem(STORAGE_KEY, '1')
  } catch {
    // localStorage unavailable — fall back to in-memory only via the
    // "playing" check; user will get the transition each session.
  }
}

type Mode = 'transition' | 'replay'
type Active = {
  mode: Mode
  target: Route | null
  /** Route snapshot at the moment the transition started. We compare
   *  against the live route to detect external navigation (browser
   *  back/forward) mid-flight. */
  fromRoute: Route
}

type Ctx = {
  transitionTo: (route: Route) => void
  navigate: (route: Route) => void
  replay: () => void
}

const NavTransitionContext = createContext<Ctx | null>(null)

export function NavTransitionProvider({ children }: { children: ReactNode }) {
  const [route, navigate] = useRoute()
  const [active, setActive] = useState<Active | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  // Refreshing on the home route is the natural "reset" gesture — clear
  // the played gate so the next nav-button press replays the transition.
  // SPA nav back to home (brand click) does not re-mount this provider,
  // so it does NOT reset; only an actual page load on `#/home` (or `/`)
  // does. Refreshing on TV/Movies/Downloads keeps the gate intact.
  useEffect(() => {
    if (route === 'home') {
      try {
        localStorage.removeItem(STORAGE_KEY)
      } catch {
        // ignore — gate just stays as-is
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const transitionTo = (next: Route) => {
    if (active !== null) return
    if (next === route) return
    if (hasPlayed()) {
      navigate(next)
      return
    }
    // markPlayed() moved to finish() — if the user hits browser back
    // mid-transition, the gate stays unset so they still get the
    // flourish on their next intentional nav click.
    setActive({ mode: 'transition', target: next, fromRoute: route })
  }

  const replay = () => {
    if (active !== null) return
    setActive({ mode: 'replay', target: null, fromRoute: route })
  }

  useEffect(() => {
    if (!active) return
    const v = videoRef.current
    if (!v) return
    v.currentTime = 0
    // Native 1.0x. Source is already motion-interpolated to uniform
    // 24fps across all four scenes (commit 554623d), so there's no
    // pacing irregularity left to compensate for. Any additional
    // speedup just rushes the eye reveal, which is the whole point of
    // the opening beat.
    v.playbackRate = 1
    const p = v.play()
    if (p && typeof (p as Promise<void>).catch === 'function') {
      ;(p as Promise<void>).catch(() => {
        if (active.target) navigate(active.target)
        setActive(null)
      })
    }
  }, [active, navigate])

  // Cancel an in-flight transition if the user navigates away mid-flight
  // (browser back/forward, hash edit, etc.). Without this, the overlay
  // keeps playing on top of the new route, then finish() drags the user
  // back to the original target — fighting the back button. We compare
  // the live route against the snapshot we took when the transition
  // started; any divergence means the user took control.
  useEffect(() => {
    if (!active) return
    if (active.mode !== 'transition') return
    // Route already matches the target (some other code navigated us
    // there). Drop the overlay; nothing left to do.
    if (active.target !== null && route === active.target) {
      setActive(null)
      return
    }
    // Route diverged from where we started but isn't the target — the
    // user navigated externally. Surrender.
    if (route !== active.fromRoute) {
      setActive(null)
    }
  }, [route, active])

  const finish = () => {
    // Only complete the navigation if the user hasn't already bailed.
    // If `route` no longer matches the snapshot, the back button got
    // there first — don't fight it.
    if (active?.target && route === active.fromRoute) {
      markPlayed()
      navigate(active.target)
    } else if (active?.mode === 'replay') {
      // Replays don't navigate but still count as a played flourish.
      markPlayed()
    }
    setActive(null)
  }

  return (
    <NavTransitionContext.Provider value={{ transitionTo, navigate, replay }}>
      {children}
      {active && (
        <div className="nav-transition" role="presentation">
          <video
            ref={videoRef}
            className="nav-transition__video"
            playsInline
            // The re-encoded source has no audio track, but autoplay
            // policy in Chrome/Safari gates on the muted *attribute*,
            // not the actual stream. Without this, v.play() rejects
            // with NotAllowedError on the user-gesture click, the
            // catch branch dismisses the overlay, and the user sees a
            // black flash → instant nav.
            muted
            preload="auto"
            onEnded={finish}
            onError={(e) => {
              const ve = (e.currentTarget as HTMLVideoElement).error
              if (ve) console.warn('nav-transition video error', ve.code, ve.message)
              finish()
            }}
          >
            <source src="/nav-transition.mp4" type="video/mp4" />
          </video>
        </div>
      )}
    </NavTransitionContext.Provider>
  )
}

export function useNavTransition() {
  const ctx = useContext(NavTransitionContext)
  if (!ctx) throw new Error('useNavTransition must be used within NavTransitionProvider')
  return ctx
}
