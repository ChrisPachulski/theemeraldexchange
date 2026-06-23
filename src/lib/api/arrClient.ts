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

  // Shared body-bearing request with the 60s abort guard. POST and PUT
  // differ only by verb; `params` rides on the URL so a grab endpoint can
  // carry its scoping id (e.g. ?movieId=) alongside a JSON body.
  async function sendBody<T, B>(
    method: 'POST' | 'PUT',
    path: string,
    body: B,
    params?: Params,
  ): Promise<T> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 60_000)
    try {
      const res = await fetch(apiUrl(`${base}${path}`, params), {
        method,
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

  function post<T, B>(path: string, body: B, params?: Params): Promise<T> {
    return sendBody<T, B>('POST', path, body, params)
  }

  function put<T, B>(path: string, body: B, params?: Params): Promise<T> {
    return sendBody<T, B>('PUT', path, body, params)
  }

  async function del(path: string, params?: Params): Promise<void> {
    const res = await fetch(apiUrl(`${base}${path}`, params), {
      method: 'DELETE',
      credentials: 'include',
    })
    if (!res.ok) await throwApiError(res, `${label} ${path}`)
  }

  return { get, post, put, del }
}
