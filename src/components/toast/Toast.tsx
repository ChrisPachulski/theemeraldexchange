import { useEffect, useRef, useState } from 'react'
import './Toast.css'

type Props = {
  message: string | null
  onDone: () => void
  duration?: number
}

export function Toast({ message, onDone, duration = 3200 }: Props) {
  // `shown` is the message currently painted. It outlives `message` so the
  // toast can animate OUT (the `.toast--closing` closed state from b23ebaa)
  // before it unmounts, instead of vanishing the instant `message` clears.
  const [shown, setShown] = useState<string | null>(message)
  const [closing, setClosing] = useState(false)
  const elRef = useRef<HTMLDivElement>(null)

  // Adopt a new message via adjust-state-during-render (the supported React
  // pattern), clearing any in-flight closing phase so a fresh toast shows fully.
  if (message && message !== shown) {
    setShown(message)
    setClosing(false)
  }

  // Keep onDone callable from the transitionend handler / timers without
  // re-running the dismiss effect when the parent passes a fresh closure each
  // render. The ref is updated in an effect (never during render).
  const onDoneRef = useRef(onDone)
  useEffect(() => {
    onDoneRef.current = onDone
  }, [onDone])

  const finish = () => {
    setShown(null)
    setClosing(false)
    onDoneRef.current()
  }

  // Auto-dismiss timer, (re)started whenever a message becomes visible.
  useEffect(() => {
    if (!message) return
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const id = window.setTimeout(() => {
      if (reduce) {
        // No exit transition to await — dismiss straight away.
        setShown(null)
        setClosing(false)
        onDoneRef.current()
      } else {
        // Enter the closing phase; transitionend finishes the dismiss.
        setClosing(true)
      }
    }, duration)
    return () => window.clearTimeout(id)
  }, [message, duration])

  // Safety net: if transitionend never fires while closing (e.g. no
  // transitionable property actually changed), force the dismiss so the toast
  // can't get stuck on screen.
  useEffect(() => {
    if (!closing) return
    const id = window.setTimeout(() => {
      setShown(null)
      setClosing(false)
      onDoneRef.current()
    }, 400)
    return () => window.clearTimeout(id)
  }, [closing])

  if (!shown) return null

  return (
    <div
      ref={elRef}
      className={closing ? 'toast toast--closing' : 'toast'}
      role="status"
      aria-live="polite"
      onTransitionEnd={(e) => {
        // Only act on the toast element's own fade-out, and only while closing.
        if (!closing) return
        if (e.target !== elRef.current) return
        finish()
      }}
    >
      {shown}
    </div>
  )
}
