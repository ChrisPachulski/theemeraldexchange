const BASE = '/api/sab/api'

async function call<T>(mode: string, extra?: Record<string, string>): Promise<T> {
  const url = new URL(BASE, window.location.origin)
  url.searchParams.set('mode', mode)
  url.searchParams.set('output', 'json')
  if (extra) {
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v)
  }
  const res = await fetch(url.toString().replace(window.location.origin, ''))
  if (!res.ok) throw new Error(`SAB ${mode}: ${res.status} ${res.statusText}`)
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
