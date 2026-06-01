import { useEffect, useState } from 'react'

// Pure: maps a Document-like value (or undefined, for SSR) to whether
// the page is currently visible. Treats a missing document as visible
// so SSR/first paint shows content rather than a hidden state.
export function computeDocumentVisible(
  doc: Pick<Document, 'visibilityState'> | undefined,
): boolean {
  if (typeof doc === 'undefined') return true
  return doc.visibilityState === 'visible'
}

export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    computeDocumentVisible(typeof document === 'undefined' ? undefined : document),
  )

  useEffect(() => {
    const onChange = () => setVisible(computeDocumentVisible(document))
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  return visible
}
