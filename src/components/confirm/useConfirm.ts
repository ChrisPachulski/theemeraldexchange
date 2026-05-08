import { useContext } from 'react'
import { ConfirmContext, type ConfirmContextValue } from './context'

export function useConfirm(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>')
  return ctx
}
