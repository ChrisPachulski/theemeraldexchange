import { createContext } from 'react'
import type { ConfirmIntent } from './ConfirmModal'

type ConfirmInput = Omit<ConfirmIntent, 'onConfirm'> & {
  onConfirm: () => Promise<void> | void
}

export type ConfirmContextValue = (input: ConfirmInput) => void

export const ConfirmContext = createContext<ConfirmContextValue | null>(null)
