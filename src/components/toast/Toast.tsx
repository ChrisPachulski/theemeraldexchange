import { useEffect } from 'react'
import './Toast.css'

type Props = {
  message: string | null
  onDone: () => void
  duration?: number
}

export function Toast({ message, onDone, duration = 3200 }: Props) {
  useEffect(() => {
    if (!message) return
    const id = setTimeout(onDone, duration)
    return () => clearTimeout(id)
  }, [message, duration, onDone])

  if (!message) return null

  return (
    <div className="toast" role="status" aria-live="polite">
      {message}
    </div>
  )
}
