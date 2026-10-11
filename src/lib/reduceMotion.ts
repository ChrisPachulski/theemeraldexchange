// In-app "Reduce motion" (UserMenu > Preferences) for viewers whose OS setting
// is off, like the Apple app's toggle. It sets data-reduce-motion on <html>:
// index.css mirrors every prefers-reduced-motion block under that attribute,
// and prefersReducedMotion() (viewTransition.ts) reads it for the JS paths.

const STORAGE_KEY = 'eex.reduceMotion'

export function storedReduceMotion(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function setReduceMotion(on: boolean): void {
  document.documentElement.toggleAttribute('data-reduce-motion', on)
  try {
    if (on) localStorage.setItem(STORAGE_KEY, '1')
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* storage unavailable: applies to this page only */
  }
}
