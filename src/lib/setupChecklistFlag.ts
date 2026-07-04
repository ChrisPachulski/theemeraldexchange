// One-shot flag driving the first-run SetupChecklist (plan 006 Phase 3).
// Lives outside the component so auth.tsx can set it without pulling
// component/CSS modules into the auth graph (and to satisfy
// react-refresh/only-export-components).

const FLAG_KEY = 'eex.showSetupChecklist'

export function shouldShowSetupChecklist(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) === '1'
  } catch {
    return false
  }
}

export function requestSetupChecklist(): void {
  try {
    localStorage.setItem(FLAG_KEY, '1')
  } catch {
    /* private mode — checklist just won't auto-show */
  }
}

export function dismissSetupChecklist(): void {
  try {
    localStorage.removeItem(FLAG_KEY)
  } catch {
    /* ignore */
  }
}
