// /api/plex/remote-access — admin-only diagnostic for the Plex
// Media Server's external-reachability state. Calls /:/prefs on the
// local PMS using the admin's session-stored Plex auth token (the
// owner is the only account whose token can read prefs), parses the
// XML preferences blob, and returns a small summary of the keys
// that actually decide whether the server is reachable from outside
// the LAN.
//
// We intentionally do NOT proxy the full prefs object — it has 100+
// keys, some sensitive (transcoder secrets, scheduled-task tokens).
// Just the connection-relevant subset.

import { Hono } from 'hono'
import { requireAdmin, type Env } from '../middleware/auth.js'
import { env } from '../env.js'
import { fetchWithTimeout, LAN_TIMEOUT_MS } from '../services/upstream.js'

export const plexAdmin = new Hono<Env>()

plexAdmin.use('*', requireAdmin)

function attr(xml: string, key: string): string | undefined {
  const m = xml.match(new RegExp(`id="${key}"[^/]*?value="([^"]*)"`))
  return m?.[1]
}

plexAdmin.get('/remote-access', async (c) => {
  const session = c.get('session')
  if (!session.plexAuthToken) {
    return c.json({ error: 'no_plex_token' }, 409)
  }
  const url = `${env.plexServerUrl}/:/prefs`
  // PMS is LAN-local but can wedge on a stuck transcoder lock. Bound
  // the fetch with the shared LAN budget so a hung PMS doesn't pin
  // the request handler. fetchWithTimeout synthesizes a 504 Response
  // on abort or network error which the non-ok branch below maps to
  // the existing 502 surface.
  const res = await fetchWithTimeout(
    url,
    { headers: { Accept: 'application/xml', 'X-Plex-Token': session.plexAuthToken } },
    LAN_TIMEOUT_MS,
    'plex.remoteAccess',
  )
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // 502 (Bad Gateway): we're the gateway, the upstream PMS failed.
    // Hono's c.json expects a known status literal, so we can't pass
    // res.status directly — the upstream status is in the body.
    return c.json({ error: 'prefs_failed', status: res.status, body: body.slice(0, 400) }, 502)
  }
  const xml = await res.text()

  const publish = attr(xml, 'PublishServerOnPlexOnlineKey') === '1'
  const manualPortMode = attr(xml, 'ManualPortMappingMode') === '1'
  const manualPort = attr(xml, 'ManualPortMappingPort')
  const securePref = attr(xml, 'secureConnections')
  const customConnections = attr(xml, 'customConnections') || ''
  const allowedNetworks = attr(xml, 'allowedNetworks') || ''
  const lanNetworksBandwidth = attr(xml, 'lanNetworksBandwidth')
  const wanPerStreamMaxUploadRate = attr(xml, 'WanPerStreamMaxUploadRate')
  const certificate = attr(xml, 'certificateUUID')
  const publicPort = attr(xml, 'PublicPort')
  const publicAddress = attr(xml, 'PublicAddress')

  return c.json({
    summary: {
      remoteAccessEnabled: publish,
      manualPortMappingEnabled: manualPortMode,
      manualPort: manualPort ?? null,
      // Never ship the raw public IP to the browser — even owner-only, it
      // lands in the Network tab / dev tools and is the owner's home WAN
      // address. A presence boolean is all the reachability diagnostic needs;
      // the owner can read the literal IP in Plex's own web UI if required.
      publicAddressDetected: Boolean(publicAddress),
      detectedPublicPort: publicPort ?? null,
      // customConnections routinely holds the operator's literal LAN/home-WAN
      // IP:port — same leak class as publicAddress above. Ship presence only.
      hasCustomConnections: Boolean(customConnections),
      secureConnectionsMode: securePref ?? null, // 0=disabled, 1=preferred, 2=required
      hasCertificate: Boolean(certificate),
      wanUploadCapBytes: wanPerStreamMaxUploadRate ?? null,
      allowedNetworks: allowedNetworks || null,
      lanNetworksBandwidth: lanNetworksBandwidth ?? null,
    },
    interpretation: {
      remoteAccess: publish
        ? 'Server is advertising itself to plex.tv as remotely accessible.'
        : 'Server is NOT advertising to plex.tv. Settings → Remote Access in Plex web UI is the toggle.',
      portMapping: manualPortMode
        ? `Plex is asking your router to forward TCP ${manualPort ?? '?'} to the Plex server on the LAN. Router must be configured to honor this.`
        : 'Plex is using UPnP to auto-map the port. If your router has UPnP disabled or broken (common on UGREEN/ISP routers), this will silently fail. Switch to manual.',
      publicReachability: publicAddress
        ? `Plex has detected a public address${publicPort ? ` on port ${publicPort}` : ''}. The literal IP is intentionally not returned here; read it in Plex's own web UI if you need it. If reachability is wrong (e.g. your ISP rotated the IP), hit Retry there.`
        : 'Plex has not detected a public address — strong signal that remote access is broken end-to-end.',
    },
  })
})
