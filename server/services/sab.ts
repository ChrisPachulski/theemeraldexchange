// SAB fetch helper. SAB takes the apikey as a query param (not a
// header), so we splice it in here. Output mode is forced to JSON for
// every call; a non-JSON 200 from SAB usually means the apikey was
// rejected and SAB returned its HTML error page.

import { env } from '../env.js'
import { fetchWithTimeout, LAN_TIMEOUT_MS, NotConfiguredError } from './upstream.js'

export async function sabCall(
  mode: string,
  extra?: Record<string, string>,
): Promise<Response> {
  // SAB is optional (plan 006 Phase 0): unset key → typed 503 via onError.
  const apiKey = env.sabApiKey
  if (!apiKey) throw new NotConfiguredError('sab')
  const url = new URL(`${env.sabUrl}/api`)
  url.searchParams.set('mode', mode)
  url.searchParams.set('output', 'json')
  url.searchParams.set('apikey', apiKey)
  if (extra) for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v)
  return fetchWithTimeout(url.toString(), {}, LAN_TIMEOUT_MS, 'sab')
}
