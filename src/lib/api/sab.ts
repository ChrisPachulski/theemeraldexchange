import { throwApiError } from './errors'
import { apiUrl } from './base'

const BASE = '/api/sab/api'

async function call<T>(mode: string, extra?: Record<string, string>): Promise<T> {
  const params: Record<string, string> = { mode, output: 'json', ...(extra ?? {}) }
  const res = await fetch(apiUrl(BASE, params), { credentials: 'include' })
  if (!res.ok) await throwApiError(res, `SAB ${mode}`)
  return res.json() as Promise<T>
}

export type QueueSlot = {
  nzo_id: string
  filename: string
  cat: string
  status: string
  size: string
  sizeleft: string
  percentage: string
  timeleft: string
  index: number
}

export type QueueResponse = {
  queue: {
    status: string
    speedlimit: string
    speed: string
    sizeleft: string
    size: string
    eta: string
    timeleft: string
    paused: boolean
    slots: QueueSlot[]
  }
}

export type HistorySlot = {
  nzo_id: string
  name: string
  category: string
  size: number
  status: string
  completed: number
  fail_message?: string
}

export type HistoryResponse = {
  history: {
    slots: HistorySlot[]
    total_size: string
    month_size: string
    week_size: string
    day_size: string
  }
}

export const sab = {
  queue: () => call<QueueResponse>('queue'),
  history: (limit = 10) => call<HistoryResponse>('history', { limit: String(limit) }),
  pauseItem: (nzoId: string) => call<{ status: boolean }>('queue', { name: 'pause', value: nzoId }),
  resumeItem: (nzoId: string) => call<{ status: boolean }>('queue', { name: 'resume', value: nzoId }),
  deleteItem: (nzoId: string) =>
    call<{ status: boolean }>('queue', { name: 'delete', value: nzoId, del_files: '1' }),
}
