export type ClientAddressSource = 'cf' | 'true-client' | 'socket'

export interface ResolvedClientAddress {
  address: string
  source: ClientAddressSource
}

interface ClientAddressInput {
  trustProxyHeaders: boolean
  cfConnectingIp?: string
  trueClientIp?: string
  socketAddress?: string
}

function forwardedAddress(value: string | undefined): string | null {
  const address = value?.trim()
  return address || null
}

/** Resolve the caller at the configured proxy trust boundary.
 *
 * CF-Connecting-IP and True-Client-IP are accepted only when the deployment
 * explicitly trusts its proxy headers. X-Forwarded-For is deliberately absent:
 * choosing a safe hop requires a configured, validated proxy chain, which these
 * deployments do not have. The direct socket remains the fallback.
 */
export function resolveClientAddress(input: ClientAddressInput): ResolvedClientAddress | null {
  if (input.trustProxyHeaders) {
    const cf = forwardedAddress(input.cfConnectingIp)
    if (cf) return { address: cf, source: 'cf' }
    const trueClient = forwardedAddress(input.trueClientIp)
    if (trueClient) return { address: trueClient, source: 'true-client' }
  }

  const socket = input.socketAddress?.trim()
  return socket ? { address: socket, source: 'socket' } : null
}
