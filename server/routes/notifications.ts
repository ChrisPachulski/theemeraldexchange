// /api/notifications/discord — admin-only Discord webhook
// configuration. One webhook URL drives Discord notifications on
// both Sonarr and Radarr so the household gets a single channel
// ping when grabs start, downloads complete, or something needs
// manual attention.
//
// Sonarr's notification.schema for Discord exposes:
//   webHookUrl, username, avatar, author,
//   grabFields, importFields, manualInteractionFields
// Triggers we light up: onGrab, onDownload, onUpgrade,
// onManualInteractionRequired. We leave health/app-update triggers
// off — those are operator chatter the household doesn't need.

import { Hono } from 'hono'
import { requireAdmin, type Env } from '../middleware/auth.js'
import { sonarrFetch } from '../services/sonarr.js'
import { radarrFetch } from '../services/radarr.js'

export const notifications = new Hono<Env>()

notifications.use('*', requireAdmin)

const EMERALD_NAME = 'Emerald Exchange Discord'

function discordNotificationBody(webhookUrl: string, app: 'sonarr' | 'radarr') {
  // grabFields / importFields / manualInteractionFields are bitmask
  // arrays Sonarr/Radarr use to pick which embed columns to render.
  // 0..9 covers Overview, Rating, Genres, Quality, Group, Size,
  // Links, Release, Poster, Fanart. Sending all gives a rich card.
  const allFields = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
  return {
    name: EMERALD_NAME,
    onGrab: true,
    onDownload: true,
    onUpgrade: true,
    onImportComplete: true,
    onManualInteractionRequired: true,
    onRename: false,
    onSeriesAdd: false,
    onSeriesDelete: false,
    onEpisodeFileDelete: false,
    onEpisodeFileDeleteForUpgrade: false,
    onMovieAdded: false,
    onMovieDelete: false,
    onMovieFileDelete: false,
    onMovieFileDeleteForUpgrade: false,
    onHealthIssue: false,
    onHealthRestored: false,
    onApplicationUpdate: false,
    includeHealthWarnings: false,
    supportsOnGrab: true,
    supportsOnDownload: true,
    supportsOnUpgrade: true,
    supportsOnManualInteractionRequired: true,
    implementation: 'Discord',
    implementationName: 'Discord',
    configContract: 'DiscordSettings',
    tags: [],
    fields: [
      { name: 'webHookUrl', value: webhookUrl },
      { name: 'username', value: 'Emerald Exchange' },
      { name: 'avatar', value: '' },
      { name: 'author', value: app === 'sonarr' ? 'Sonarr' : 'Radarr' },
      { name: 'grabFields', value: allFields },
      { name: 'importFields', value: allFields },
      { name: 'manualInteractionFields', value: allFields },
    ],
  }
}

async function listNotifications(app: 'sonarr' | 'radarr'): Promise<Array<{ id: number; name: string; implementation: string }>> {
  const path = app === 'sonarr' ? '/api/v3/notification' : '/api/v3/notification'
  const fetcher = app === 'sonarr' ? sonarrFetch : radarrFetch
  const r = await fetcher(path, { method: 'GET' })
  if (!r.ok) return []
  return (await r.json()) as Array<{ id: number; name: string; implementation: string }>
}

async function findEmerald(app: 'sonarr' | 'radarr'): Promise<number | null> {
  const list = await listNotifications(app)
  const hit = list.find(
    (n) => n.name === EMERALD_NAME && n.implementation === 'Discord',
  )
  return hit?.id ?? null
}

notifications.get('/discord', async (c) => {
  const [sonarr, radarr] = await Promise.all([findEmerald('sonarr'), findEmerald('radarr')])
  return c.json({
    sonarr: sonarr !== null,
    radarr: radarr !== null,
    configured: sonarr !== null && radarr !== null,
  })
})

notifications.post('/discord', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { webhookUrl?: string } | null
  const url = body?.webhookUrl?.trim()
  if (!url) return c.json({ error: 'webhookUrl_required' }, 400)
  if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url)) {
    return c.json({ error: 'invalid_discord_webhook' }, 400)
  }

  // Replace any prior Emerald-created notification so a re-paste of a
  // new URL takes effect instead of stacking duplicates.
  for (const app of ['sonarr', 'radarr'] as const) {
    const existing = await findEmerald(app)
    const fetcher = app === 'sonarr' ? sonarrFetch : radarrFetch
    if (existing !== null) {
      await fetcher(`/api/v3/notification/${existing}`, { method: 'DELETE' })
    }
    const res = await fetcher('/api/v3/notification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(discordNotificationBody(url, app)),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return c.json(
        { error: `${app}_create_failed`, status: res.status, detail: text.slice(0, 400) },
        502,
      )
    }
  }
  return c.json({ ok: true, configured: true })
})

notifications.delete('/discord', async (c) => {
  let removed = 0
  for (const app of ['sonarr', 'radarr'] as const) {
    const id = await findEmerald(app)
    if (id === null) continue
    const fetcher = app === 'sonarr' ? sonarrFetch : radarrFetch
    const res = await fetcher(`/api/v3/notification/${id}`, { method: 'DELETE' })
    if (res.ok) removed++
  }
  return c.json({ ok: true, removed })
})

// Fires a test embed at the configured webhook (uses Sonarr's test
// endpoint so we get the same payload format the live notifications
// will produce). Lets the household verify the channel is reachable
// without waiting for a real download to complete.
notifications.post('/discord/test', async (c) => {
  const id = await findEmerald('sonarr')
  if (id === null) return c.json({ error: 'not_configured' }, 409)
  const res = await sonarrFetch(`/api/v3/notification/${id}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return c.json({ error: 'test_failed', status: res.status, detail: text.slice(0, 400) }, 502)
  }
  return c.json({ ok: true })
})
