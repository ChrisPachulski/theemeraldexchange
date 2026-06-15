import { throwApiError } from './errors'
import { apiUrl } from './base'

type Params = Record<string, string | number | boolean>

/** Shared *arr HTTP client. Radarr and Sonarr speak the same v3 REST dialect
 *  behind their own `/api/<svc>/api/v3` proxy prefix; `label` only flavours
 *  error messages so a failure names the right service. */
export function createArrClient(label: string, base: string) {
  async function get<T>(path: string, params?: Params): Promise<T> {
    const res = await fetch(apiUrl(`${base}${path}`, params), { credentials: 'include' })
    if (!res.ok) await throwApiError(res, `${label} ${path}`)
    return res.json() as Promise<T>
  }

  async function post<T, B>(path: string, body: B): Promise<T> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 60_000)
    try {
      const res = await fetch(apiUrl(`${base}${path}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      if (!res.ok) await throwApiError(res, `${label} ${path}`)
      return res.json() as Promise<T>
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(
          `${label} ${path}: request timed out after 60s; the server is taking too long. Check ${label} is reachable from the dashboard server.`,
          { cause: err },
        )
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  async function del(path: string, params?: Params): Promise<void> {
    const res = await fetch(apiUrl(`${base}${path}`, params), {
      method: 'DELETE',
      credentials: 'include',
    })
    if (!res.ok) await throwApiError(res, `${label} ${path}`)
  }

  return { get, post, del }
}
