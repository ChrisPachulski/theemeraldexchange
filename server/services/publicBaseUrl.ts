// The public origin a client reached us on, for URLs we hand back (the trailer
// stream). X-Forwarded-Host / Host are attacker-controlled wherever the backend
// is reachable without the trusted proxy in front, so a host is only echoed
// when it belongs to the operator's ALLOWED_ORIGINS, exactly or as a subdomain
// (the API lives at api.<spa-domain> in the Netlify / NAS split). An attacker
// cannot serve content from a subdomain of the operator's domain without
// controlling its DNS.

import type { Context } from 'hono'
import { env } from '../env.js'

function firstHeaderValue(value: string | undefined): string {
  return value?.split(',')[0]?.trim() ?? ''
}

function safeHost(value: string, fallback: string): string {
  if (!value || /[\s/\\]/.test(value)) return fallback
  return value
}

function isAllowedPublicHost(host: string): boolean {
  const hostname = host.toLowerCase().replace(/:\d+$/, '')
  for (const origin of env.allowedOrigins) {
    let originHostname: string
    try {
      originHostname = new URL(origin).hostname.toLowerCase()
    } catch {
      continue // a malformed allowlist entry can never match
    }
    if (hostname === originHostname || hostname.endsWith(`.${originHostname}`)) return true
  }
  return false
}

export function publicBaseUrl(c: Context): string {
  const requestUrl = new URL(c.req.url)
  const forwardedProto = firstHeaderValue(c.req.header('x-forwarded-proto')).toLowerCase()
  const proto = forwardedProto === 'http' || forwardedProto === 'https' ? `${forwardedProto}:` : requestUrl.protocol
  const host = safeHost(
    firstHeaderValue(c.req.header('x-forwarded-host')) || firstHeaderValue(c.req.header('host')) || requestUrl.host,
    requestUrl.host,
  )
  // No allowlist configured (dev / direct-LAN deploys): header passthrough.
  if (env.allowedOrigins.length === 0 || isAllowedPublicHost(host)) return `${proto}//${host}`
  // Never echo a foreign host: the first parseable configured origin, else the
  // socket-level request host (not the headers).
  for (const origin of env.allowedOrigins) {
    try {
      return new URL(origin).origin
    } catch {
      continue
    }
  }
  return `${proto}//${requestUrl.host}`
}
