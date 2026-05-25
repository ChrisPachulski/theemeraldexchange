import { env } from '../env.js'
import { fetchWithTimeout } from './upstream.js'

export interface XtreamCreds {
  host: string
  username: string
  password: string
}

export interface AccountInfo {
  expiresAt: Date | null
  maxConnections: number
  status: string
}

export function credsFromEnv(): XtreamCreds {
  if (!env.XTREAM_HOST || !env.XTREAM_USERNAME || !env.XTREAM_PASSWORD) {
    throw new Error('xtream_credentials_missing')
  }
  return {
    host: env.XTREAM_HOST.replace(/\/+$/, ''),
    username: env.XTREAM_USERNAME,
    password: env.XTREAM_PASSWORD,
  }
}

export function buildPlayerApiUrl(
  creds: XtreamCreds,
  action: string,
  extra?: Record<string, string | number>,
): string {
  const params = new URLSearchParams({
    username: creds.username,
    password: creds.password,
    action,
  })
  if (extra) {
    for (const [k, v] of Object.entries(extra)) params.set(k, String(v))
  }
  return `${creds.host}/player_api.php?${params.toString()}`
}

export function parseAccountInfo(payload: unknown): AccountInfo {
  const root = (payload as { user_info?: Record<string, unknown> })?.user_info ?? {}
  const rawExp = root.exp_date
  const expNum =
    typeof rawExp === 'number' ? rawExp : typeof rawExp === 'string' ? Number(rawExp) : NaN
  const expiresAt = Number.isFinite(expNum) ? new Date(expNum * 1000) : null
  const maxConnections =
    typeof root.max_connections === 'number'
      ? root.max_connections
      : Number(root.max_connections ?? 0) || 0
  const status = typeof root.status === 'string' ? root.status : ''
  return { expiresAt, maxConnections, status }
}

export async function getAccountInfo(creds: XtreamCreds = credsFromEnv()): Promise<AccountInfo> {
  const probe = `${creds.host}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}`
  const res = await fetchWithTimeout(probe, {}, env.IPTV_LIST_TIMEOUT_MS, 'xtream.account_info')
  if (!res.ok) throw new Error(`xtream_account_${res.status}`)
  const json = (await res.json()) as unknown
  return parseAccountInfo(json)
}
