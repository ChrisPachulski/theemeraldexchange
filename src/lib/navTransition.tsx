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
type Active = { mode: Mode; target: Route | null }

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
    markPlayed()
    setActive({ mode: 'transition', target: next })
  }

  const replay = () => {
    if (active !== null) return
    setActive({ mode: 'replay', target: null })
  }

  useEffect(() => {
    if (!active) return
    const v = videoRef.current
    if (!v) return
    v.currentTime = 0
    // Source clip was rendered with slow-mo; play it at real-time so the
    // transition is a snappy ~2.8s flourish instead of a 5.7s drag.
    v.playbackRate = 2
    const p = v.play()
    if (p && typeof (p as Promise<void>).catch === 'function') {
      ;(p as Promise<void>).catch(() => {
        if (active.target) navigate(active.target)
        setActive(null)
      })
    }
  }, [active, navigate])

  const finish = () => {
    if (active?.target) navigate(active.target)
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
            preload="auto"
            onEnded={finish}
            onError={finish}
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
