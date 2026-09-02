// IPTV (MyBunny / Xtream) router. Mounted at /api/iptv.
//
// Composed from per-concern modules under ./iptv/ (sessions, catalog + EPG,
// playlist tokens, favorites + history, live/catch-up streaming, on-demand
// streaming, export + admin sync). Every path and guard is exactly as it was
// in the single-file version; shared helpers live in ./iptv/shared.ts.

import { Hono } from 'hono'
import { type Env } from '../middleware/auth.js'
import { iptv as sessions } from './iptv/sessions.js'
import { iptv as catalog } from './iptv/catalog.js'
import { iptv as playlist } from './iptv/playlist.js'
import { iptv as history } from './iptv/history.js'
import { iptv as streamLive } from './iptv/streamLive.js'
import { iptv as streamOnDemand } from './iptv/streamOnDemand.js'
import { iptv as admin } from './iptv/admin.js'

export { publicBaseUrl, clientIp, formatXtreamTimeshiftStart } from './iptv/shared.js'
export { __test } from './iptv/shared.js'

export const iptv = new Hono<Env>()
iptv.route('/', sessions)
iptv.route('/', catalog)
iptv.route('/', playlist)
iptv.route('/', history)
iptv.route('/', streamLive)
iptv.route('/', streamOnDemand)
iptv.route('/', admin)
