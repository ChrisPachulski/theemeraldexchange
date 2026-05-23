import { throwApiError } from './errors'
import { apiUrl } from './base'

const BASE = '/api/sab/api'

async function get<T>(mode: string, extra?: Record<string, string>): Promise<T> {
  const params: Record<string, string> = { mode, output: 'json', ...(extra ?? {}) }
  const res = await fetch(apiUrl(BASE, params), { credentials: 'include' })
  if (!res.ok) await throwApiError(res, `SAB ${mode}`)
  return res.json() as Promise<T>
}

async function mutate<T>(method: 'POST' | 'DELETE', path: string, label: string): Promise<T> {
  const res = await fetch(apiUrl(`${BASE}${path}`), {
    method,
    credentials: 'include',
  })
  if (!res.ok) await throwApiError(res, label)
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
    /** Current download rate, in MB/s as a bare number string ("0" or "5.5"). */
    speed: string
    /** Remaining size as a formatted string ("5.5 GB"). */
    sizeleft: string
    /** Total queued size as a formatted string ("10.2 GB"). */
    size: string
    eta: string
    timeleft: string
    paused: boolean
    /** Free space on the download (incomplete) directory, as raw GB string. */
    diskspace1?: string
    /** Total space on the download (incomplete) directory, as raw GB string. */
    diskspacetotal1?: string
    /** Free space on the completed-files directory, as raw GB string. */
    diskspace2?: string
    /** Total space on the completed-files directory, as raw GB string. */
    diskspacetotal2?: string
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
  queue: () => get<QueueResponse>('queue'),
  history: (limit = 10) => get<HistoryResponse>('history', { limit: String(limit) }),
  pauseItem: (nzoId: string) =>
    mutate<{ status: boolean }>('POST', `/queue/${encodeURIComponent(nzoId)}/pause`, 'SAB pause'),
  resumeItem: (nzoId: string) =>
    mutate<{ status: boolean }>('POST', `/queue/${encodeURIComponent(nzoId)}/resume`, 'SAB resume'),
  deleteItem: (nzoId: string) =>
    mutate<{ status: boolean }>('DELETE', `/queue/${encodeURIComponent(nzoId)}`, 'SAB delete'),
}
