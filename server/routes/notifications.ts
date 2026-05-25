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
let discordMutationTail = Promise.resolve()
type NotificationApp = 'sonarr' | 'radarr'
type NotificationConfig = Record<string, unknown> & { id: number; name: string; implementation: string }
type SuccessfulMutation =
  | { app: NotificationApp; action: 'create'; id: number }
  | { app: NotificationApp; action: 'update'; id: number; previous: NotificationConfig }
type NotificationDeleteFailure = { app: NotificationApp; id: number; status: number }

async function withDiscordMutationLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = discordMutationTail
  let release: () => void = () => {}
  discordMutationTail = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await fn()
  } finally {
    release()
  }
}

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

function notificationFetcher(app: NotificationApp) {
  return app === 'sonarr' ? sonarrFetch : radarrFetch
}

async function rollbackNotifications(mutations: SuccessfulMutation[]) {
  const failures: Array<{ app: NotificationApp; id: number; status: number; detail: string }> = []
  for (const mutation of [...mutations].reverse()) {
    try {
      const res =
        mutation.action === 'create'
          ? await notificationFetcher(mutation.app)(`/api/v3/notification/${mutation.id}`, {
              method: 'DELETE',
            })
          : await notificationFetcher(mutation.app)(`/api/v3/notification/${mutation.id}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(mutation.previous),
            })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        failures.push({ app: mutation.app, id: mutation.id, status: res.status, detail: detail.slice(0, 400) })
      }
    } catch (err) {
      failures.push({ app: mutation.app, id: mutation.id, status: 0, detail: err instanceof Error ? err.message : String(err) })
    }
  }
  return failures
}

// Thrown by listNotifications when the upstream returned non-ok. The
// caller MUST surface this as a hard failure rather than coalescing
// it with the "no existing connector" branch — otherwise a transient
// Sonarr/Radarr error during the POST handler causes the existing
// Emerald-created webhook to look absent, and we'd POST a duplicate
// every retry.
class NotificationListError extends Error {
  constructor(public app: 'sonarr' | 'radarr', public status: number) {
    super(`${app} /api/v3/notification list returned ${status}`)
    this.name = 'NotificationListError'
  }
}

async function listNotifications(app: 'sonarr' | 'radarr'): Promise<NotificationConfig[]> {
  const path = app === 'sonarr' ? '/api/v3/notification' : '/api/v3/notification'
  const fetcher = app === 'sonarr' ? sonarrFetch : radarrFetch
  const r = await fetcher(path, { method: 'GET' })
  if (!r.ok) throw new NotificationListError(app, r.status)
  return (await r.json()) as NotificationConfig[]
}

async function findEmeraldNotifications(app: 'sonarr' | 'radarr'): Promise<NotificationConfig[]> {
  const list = await listNotifications(app)
  return list
    .filter((n) => n.name === EMERALD_NAME && n.implementation === 'Discord')
    .filter((n) => typeof n.id === 'number')
}

async function findEmeraldIds(app: 'sonarr' | 'radarr'): Promise<number[]> {
  const list = await findEmeraldNotifications(app)
  return list.map((n) => n.id)
}

async function deleteNotifications(app: NotificationApp, ids: number[]) {
  const fetcher = notificationFetcher(app)
  const failures: NotificationDeleteFailure[] = []
  let removed = 0
  for (const id of ids) {
    const res = await fetcher(`/api/v3/notification/${id}`, { method: 'DELETE' })
    if (res.ok) removed++
    else failures.push({ app, id, status: res.status })
  }
  return { removed, failures }
}

async function findEmerald(app: 'sonarr' | 'radarr'): Promise<number | null> {
  const ids = await findEmeraldIds(app)
  return ids[0] ?? null
}

function partialDeletePayload(removed: number, failures: NotificationDeleteFailure[]) {
  return {
    error: 'partial_delete_failed',
    removed,
    failures,
    message:
      'one or more upstream notification deletes failed; the connector may still be active',
  }
}

notifications.get('/discord', async (c) => {
  try {
    const [sonarr, radarr] = await Promise.all([findEmerald('sonarr'), findEmerald('radarr')])
    return c.json({
      sonarr: sonarr !== null,
      radarr: radarr !== null,
      configured: sonarr !== null && radarr !== null,
    })
  } catch (err) {
    if (err instanceof NotificationListError) {
      return c.json({ error: `${err.app}_list_failed`, status: err.status }, 502)
    }
    throw err
  }
})

notifications.post('/discord', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { webhookUrl?: string } | null
  const url = body?.webhookUrl?.trim()
  if (!url) return c.json({ error: 'webhookUrl_required' }, 400)
  if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url)) {
    return c.json({ error: 'invalid_discord_webhook' }, 400)
  }

  return withDiscordMutationLock(async () => {
    // Resolve existing-or-not from a successful list before issuing any
    // mutation. If listNotifications throws, treating that as "none
    // exists" and creating a new one would stack a duplicate on every
    // retry until Sonarr/Radarr came back. Fail closed on list error.
    const mutations: SuccessfulMutation[] = []
    let existingByApp: Record<NotificationApp, NotificationConfig[]>
    try {
      const [sonarrExisting, radarrExisting] = await Promise.all([
        findEmeraldNotifications('sonarr'),
        findEmeraldNotifications('radarr'),
      ])
      existingByApp = { sonarr: sonarrExisting, radarr: radarrExisting }
    } catch (err) {
      if (err instanceof NotificationListError) {
        return c.json(
          { error: `${err.app}_list_failed`, status: err.status, message: 'refusing to mutate notifications without a fresh list' },
          502,
        )
      }
      throw err
    }
    for (const app of ['sonarr', 'radarr'] as const) {
      const existingNotifications = existingByApp[app]
      const fetcher = notificationFetcher(app)
      if (existingNotifications.length > 0) {
        const previous = existingNotifications[0]
        const existing = previous.id
        const extras = existingNotifications.slice(1).map((n) => n.id)
        const res = await fetcher(`/api/v3/notification/${existing}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...discordNotificationBody(url, app), id: existing }),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          const cleanupFailures = await rollbackNotifications(mutations)
          return c.json(
            {
              error: `${app}_update_failed`,
              status: res.status,
              detail: text.slice(0, 400),
              mutations,
              cleanupFailures,
              message:
                mutations.length > 0
                  ? 'one or more earlier notification mutations succeeded before this update failed'
                  : 'existing connector was left unchanged; retry, or remove and re-add from the menu',
            },
            502,
          )
        }
        mutations.push({ app, action: 'update', id: existing, previous })
        if (extras.length > 0) {
          const cleanup = await deleteNotifications(app, extras)
          if (cleanup.failures.length > 0) {
            const cleanupFailures = await rollbackNotifications(mutations)
            return c.json({ ...partialDeletePayload(cleanup.removed, cleanup.failures), cleanupFailures }, 502)
          }
        }
        continue
      }
      const res = await fetcher('/api/v3/notification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(discordNotificationBody(url, app)),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        const cleanupFailures = await rollbackNotifications(mutations)
        return c.json(
          { error: `${app}_create_failed`, status: res.status, detail: text.slice(0, 400), mutations, cleanupFailures },
          502,
        )
      }
      const created = (await res.json().catch(() => null)) as { id?: unknown } | null
      let id = typeof created?.id === 'number' ? created.id : null
      if (id === null) id = await findEmerald(app).catch(() => null)
      if (id !== null) mutations.push({ app, action: 'create', id })
    }
    return c.json({ ok: true, configured: true })
  })
})

notifications.delete('/discord', async (c) => {
  // Attempt both deletes before returning so a failure on Sonarr
  // doesn't strand Radarr's connector (or vice versa). If any DELETE
  // refused, surface 502 with the per-app status — the prior version
  // returned {ok:true, removed:0} even when both refused, so the SPA
  // showed "Removed" while connectors stayed active and the household
  // kept getting double-pings on the next grab.
  const failures: NotificationDeleteFailure[] = []
  let removed = 0
  let existingByApp: Record<NotificationApp, number[]>
  try {
    const [sonarrIds, radarrIds] = await Promise.all([findEmeraldIds('sonarr'), findEmeraldIds('radarr')])
    existingByApp = { sonarr: sonarrIds, radarr: radarrIds }
  } catch (err) {
    if (err instanceof NotificationListError) {
      return c.json({ error: `${err.app}_list_failed`, status: err.status }, 502)
    }
    throw err
  }
  for (const app of ['sonarr', 'radarr'] as const) {
    const result = await deleteNotifications(app, existingByApp[app])
    removed += result.removed
    failures.push(...result.failures)
  }
  if (failures.length > 0) {
    return c.json(partialDeletePayload(removed, failures), 502)
  }
  return c.json({ ok: true, removed })
})

// Fires a test embed at the configured webhook (uses Sonarr's test
// endpoint so we get the same payload format the live notifications
// will produce). Lets the household verify the channel is reachable
// without waiting for a real download to complete.
notifications.post('/discord/test', async (c) => {
  let id: number | null
  try {
    id = await findEmerald('sonarr')
  } catch (err) {
    if (err instanceof NotificationListError) {
      return c.json({ error: `${err.app}_list_failed`, status: err.status }, 502)
    }
    throw err
  }
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
