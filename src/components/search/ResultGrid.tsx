import type { ReactNode } from 'react'
import './ResultGrid.css'

export function ResultGrid({ children }: { children: ReactNode }) {
  return <div className="result-grid">{children}</div>
}
