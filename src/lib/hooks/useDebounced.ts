import { useEffect, useState } from 'react'

export const DEFAULT_DEBOUNCE_MS = 300

// Pure: normalizes a caller-supplied delay to a safe, finite,
// non-negative millisecond value. A NaN/negative/Infinity delay would
// otherwise produce a broken setTimeout; fall back to the default. Zero
// is a valid intentional delay and is preserved.
export function normalizeDelay(delay: number | undefined): number {
  return typeof delay === 'number' && Number.isFinite(delay) && delay >= 0
    ? delay
    : DEFAULT_DEBOUNCE_MS
}

export function useDebounced<T>(value: T, delay: number = DEFAULT_DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const ms = normalizeDelay(delay)
    const id = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(id)
  }, [value, delay])

  return debounced
}
