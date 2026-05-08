import { useCallback, useState, type ReactNode } from 'react'
import { ConfirmModal, type ConfirmIntent } from './ConfirmModal'
import { ConfirmContext, type ConfirmContextValue } from './context'

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [intent, setIntent] = useState<ConfirmIntent | null>(null)

  const confirm = useCallback<ConfirmContextValue>((input) => {
    setIntent(input)
  }, [])

  const close = useCallback(() => setIntent(null), [])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmModal intent={intent} onClose={close} />
    </ConfirmContext.Provider>
  )
}
